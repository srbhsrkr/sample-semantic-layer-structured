"""
Supervisor loop and structured-output models for the query agent.

The supervisor wraps Agent invocations with an explicit retry budget and a
post-step satisfaction check. It also exposes the data structures used by
pick #2 (column picker) and pick #3 (subquery decomposition).

Design notes
------------
- The supervisor does not replace the Strands tool loop. The Agent still picks
  tools internally. After the agent returns a result we ask a separate
  structured-output call ("did the agent actually answer the question?") and
  use the answer to decide whether to retry, decompose, or stop.
- _agent_state remains the source of truth for cached tool outputs (sql,
  rdf, disambiguation). The supervisor adds attempt tracking on top.
"""

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# Retry budgets — kept conservative so an agent can't spin forever.
# Each agent attempt costs 30-90s end-to-end (Neptune fetch + tool loop +
# judge call), so 2 is the sweet spot: one retry to recover from a transient
# tool error, no second wild swing on questions where the data genuinely is
# what it is (e.g. 0 rows for a date filter).
MAX_QUERY_ATTEMPTS = 2      # full agent retries with same question
MAX_REPLAN_ATTEMPTS = 2     # times we'll trigger a "decompose and retry" branch


# ---------------------------------------------------------------------------
# Pick 2 — structured column picker
# ---------------------------------------------------------------------------

class ColumnChoice(BaseModel):
    """
    Structured column selection used by the schema-aware disambiguation step.
    The agent emits one ColumnChoice per ambiguous term so we have an
    auditable record of *why* a column was picked.
    """

    table: str = Field(description="Fully-qualified table name (db.table) the term resolves to.")
    column: str = Field(default="", description="Column name on `table` if the term refers to a property.")
    ontology_term_uri: str = Field(description="Ontology class or property URI this term maps to.")
    confidence: float = Field(ge=0.0, le=1.0, description="0.0–1.0 confidence in the pick.")
    alternatives_considered: List[str] = Field(
        default_factory=list,
        description="Other table.column candidates that were ruled out, with one-line reasons.",
    )


# ---------------------------------------------------------------------------
# Pick 1 — supervisor decision
# ---------------------------------------------------------------------------

class SupervisorDecision(BaseModel):
    """
    Verdict from the supervisor after the agent finishes a turn.

    next_action drives the supervisor loop:
      - "stop"        — the answer is acceptable, return it to the user.
      - "retry"       — re-run the agent with the same question + a hint.
      - "decompose"   — break the question into sub-queries (pick 3) and fan out.
      - "clarify"     — the agent should surface a needs_clarification response.
    """

    satisfied: bool = Field(description="True iff the answer addresses the user's question with real data.")
    reason: str = Field(description="One-sentence rationale for the verdict.")
    next_action: str = Field(
        description="One of: stop, retry, decompose, clarify.",
    )
    hint_for_retry: str = Field(
        default="",
        description="Optional short hint to feed back into the agent on retry (e.g. 'try catalog X').",
    )


# ---------------------------------------------------------------------------
# Pick 3 — subquery decomposition
# ---------------------------------------------------------------------------

class SubQuery(BaseModel):
    """A single scoped sub-query produced by the decomposer."""

    purpose: str = Field(description="What this sub-query is meant to retrieve, in plain English.")
    natural_language: str = Field(description="The sub-question phrased so the agent can answer it standalone.")
    target_class: str = Field(default="", description="Ontology class URI this sub-query is scoped to.")
    join_key: str = Field(
        default="",
        description="Column name on this sub-query's result that joins to the next sub-query (e.g. 'customer_id').",
    )


class DecompositionPlan(BaseModel):
    """The decomposer's output: an ordered list of sub-queries plus a merge key."""

    sub_queries: List[SubQuery] = Field(default_factory=list, min_length=1, max_length=4)
    merge_key: str = Field(
        default="",
        description="Column name to join sub-query result sets on; empty means union the rows.",
    )
    rationale: str = Field(default="", description="Why the question was split this way.")


# ---------------------------------------------------------------------------
# Supervisor state
# ---------------------------------------------------------------------------

@dataclass
class SupervisorState:
    """Tracks the supervisor's progress through a single user question."""

    session_id: str
    question: str
    query_attempts: int = 0
    replan_attempts: int = 0
    last_hint: str = ""
    decisions: List[Dict[str, Any]] = field(default_factory=list)

    def can_retry(self) -> bool:
        return self.query_attempts < MAX_QUERY_ATTEMPTS

    def can_replan(self) -> bool:
        return self.replan_attempts < MAX_REPLAN_ATTEMPTS

    def record(self, decision: SupervisorDecision) -> None:
        self.decisions.append(decision.model_dump())
