"""
Supervisor runner — orchestrates the agent invocation with retries and
decomposition.

Public surface:
    run_supervised(user_input, agent_factory, model_factory, state_resetter,
                   cached_state_getter) -> AgentResult

The runner is intentionally infrastructure-light: it accepts callables for
agent creation, model creation, and state management so it can be unit-tested
without bringing up Bedrock.
"""

import json
import logging
from typing import Any, Callable, Dict, List, Optional

from strands import Agent

from .supervisor import (
    DecompositionPlan,
    SubQuery,
    SupervisorDecision,
    SupervisorState,
)

logger = logging.getLogger(__name__)


_SUPERVISOR_PROMPT = (
    "You judge whether a query agent's answer satisfies the user's question. "
    "Return SupervisorDecision JSON only. "
    "next_action must be one of: stop, retry, decompose, clarify.\n\n"
    "STOP rules (use these aggressively — retries are expensive at ~60s each):\n"
    "  - The agent successfully executed SQL and returned a count, list, or aggregate, "
    "    even if the count is 0 or the list is empty. An empty result on a clean SQL run "
    "    is a valid answer; do NOT retry hoping for different data.\n"
    "  - The agent returned concrete row data (IDs, names, numeric values).\n"
    "  - The agent already asked for clarification (needs_clarification=true).\n\n"
    "RETRY rules (use sparingly — only when a different attempt would plausibly help):\n"
    "  - The agent crashed before running any SQL.\n"
    "  - The agent hit an Athena error like UNRESOLVED_COLUMN, TABLE_NOT_FOUND, or "
    "    CATALOG_NOT_FOUND that a hint about the right name could fix.\n"
    "  - The agent answered without running SQL at all (likely tool-loop error).\n\n"
    "DECOMPOSE rules:\n"
    "  - The question requires joining 2+ entity types AND the agent ran out of context "
    "    or produced an answer that obviously didn't combine them.\n\n"
    "CLARIFY rules:\n"
    "  - The agent already produced a needs_clarification response.\n\n"
    "Default: when in doubt, STOP. Empty results, partial answers, and 'I don't have data' "
    "are all valid — the user can refine their question."
)

_DECOMPOSER_PROMPT = (
    "You break a multi-hop question into 1-3 ordered sub-questions that can each "
    "be answered against a single ontology class. "
    "Return DecompositionPlan JSON only. "
    "Each sub-query must declare a join_key column where it connects to the next "
    "sub-query. The final merge_key is the column name to join the result sets on."
)


def _build_judge(model_factory: Callable[[], Any], output_model) -> Agent:
    """Construct a tools-less Strands Agent that returns structured output."""
    return Agent(
        model=model_factory(),
        system_prompt=(
            _SUPERVISOR_PROMPT if output_model is SupervisorDecision else _DECOMPOSER_PROMPT
        ),
        tools=[],
        structured_output_model=output_model,
    )


def evaluate_answer(
    question: str,
    answer_text: str,
    cached_state: Dict[str, Any],
    model_factory: Callable[[], Any],
) -> SupervisorDecision:
    """Ask a small model whether the agent's answer is good enough."""
    judge = _build_judge(model_factory, SupervisorDecision)
    snapshot = {
        "question": question,
        "answer": answer_text[:1500],
        "had_query_result": bool(cached_state.get("query_result")),
        "had_rdf_result": bool(cached_state.get("rdf_result")),
        "disambiguation_status": _disambig_status(cached_state),
        "sql_executed_cleanly": _sql_ran_cleanly(cached_state),
    }
    prompt = (
        "Question and agent output below. Decide whether to stop, retry, "
        "decompose, or clarify.\n\n" + json.dumps(snapshot, ensure_ascii=False)
    )
    try:
        result = judge(prompt)
        decision: Optional[SupervisorDecision] = result.structured_output
        if decision is None:
            logger.warning("Supervisor returned no structured output — defaulting to stop")
            return SupervisorDecision(satisfied=True, reason="no judge output", next_action="stop")
        return _apply_safety_overrides(decision, cached_state)
    except Exception as e:
        logger.warning("Supervisor evaluation failed (%s) — defaulting to stop", e)
        return SupervisorDecision(satisfied=True, reason=f"judge error: {e}", next_action="stop")


def _sql_ran_cleanly(cached_state: Dict[str, Any]) -> bool:
    """True iff execute_sql_query produced a successful result (any row count)."""
    raw = cached_state.get("query_result", "")
    if not raw:
        return False
    try:
        qr = json.loads(raw)
    except Exception:
        return False
    if "error" in qr:
        return False
    return "row_count" in qr or "rows" in qr


def _apply_safety_overrides(
    decision: SupervisorDecision, cached_state: Dict[str, Any]
) -> SupervisorDecision:
    """
    Force the decision to 'stop' when retrying would be wasteful:
      - SQL ran cleanly (any count is a valid answer, including 0 rows)
      - judge produced no actionable retry hint
    Pure rule, deterministic — no extra model call.
    """
    if decision.next_action != "retry":
        return decision
    sql_ok = _sql_ran_cleanly(cached_state)
    has_actionable_hint = bool((decision.hint_for_retry or "").strip())
    if sql_ok and not has_actionable_hint:
        logger.info(
            "[supervisor] override: SQL ran cleanly with no actionable hint — coercing retry→stop"
        )
        return SupervisorDecision(
            satisfied=True,
            reason=f"override: SQL ran cleanly; original judge said retry: {decision.reason[:160]}",
            next_action="stop",
        )
    return decision


def decompose_question(
    question: str,
    schema_digest: str,
    model_factory: Callable[[], Any],
) -> Optional[DecompositionPlan]:
    """Ask the decomposer to split a question into sub-queries."""
    judge = _build_judge(model_factory, DecompositionPlan)
    prompt = (
        f"Question: {question}\n\n"
        f"Available schema (table → columns):\n{schema_digest[:6000]}\n\n"
        "Produce a DecompositionPlan."
    )
    try:
        result = judge(prompt)
        return result.structured_output
    except Exception as e:
        logger.warning("Decomposition failed (%s) — skipping", e)
        return None


def _disambig_status(cached_state: Dict[str, Any]) -> str:
    raw = cached_state.get("disambiguation_result", "")
    if not raw:
        return "none"
    try:
        return json.loads(raw).get("status", "unknown")
    except Exception:
        return "unparseable"


def run_supervised(
    user_input: str,
    question: str,
    state: SupervisorState,
    agent_factory: Callable[[], Agent],
    model_factory: Callable[[], Any],
    state_resetter: Callable[[str], None],
    cached_state_getter: Callable[[], Dict[str, Any]],
) -> Any:
    """
    Run the agent with retries and (optionally) decomposition.

    Returns the AgentResult from whichever attempt the supervisor accepts.
    """
    last_response: Any = None
    last_text: str = ""

    while state.can_retry():
        state.query_attempts += 1
        attempt_input = user_input
        if state.last_hint:
            attempt_input = f"{user_input}\n[supervisor_hint: {state.last_hint}]"
        logger.info(
            "[supervisor] attempt %d/%d hint=%r",
            state.query_attempts, 3, state.last_hint,
        )

        agent = agent_factory()
        try:
            response = agent(attempt_input)
        except Exception as e:
            logger.warning("[supervisor] agent raised (%s) — treating as retry", e)
            last_text = str(e)
            state.last_hint = f"previous attempt raised: {e}"
            # Reset to allow re-execution
            state_resetter(state.session_id)
            continue

        last_response = response
        last_text = _extract_text(response)
        cached = cached_state_getter()

        decision = evaluate_answer(question, last_text, cached, model_factory)
        state.record(decision)
        logger.info(
            "[supervisor] decision: action=%s satisfied=%s reason=%s",
            decision.next_action, decision.satisfied, decision.reason[:120],
        )

        if decision.next_action == "stop" or decision.next_action == "clarify":
            return last_response

        if decision.next_action == "decompose" and state.can_replan():
            state.replan_attempts += 1
            decomposed = _run_decomposed(
                question=question,
                user_input_template=user_input,
                agent_factory=agent_factory,
                model_factory=model_factory,
                state_resetter=state_resetter,
                cached_state_getter=cached_state_getter,
                state=state,
            )
            if decomposed is not None:
                return decomposed
            # Decomposition failed — fall through to retry
            state.last_hint = "decomposition produced no usable plan; try a simpler approach"
            state_resetter(state.session_id)
            continue

        # Default: retry with hint
        state.last_hint = decision.hint_for_retry or decision.reason or "previous attempt unsatisfactory"
        state_resetter(state.session_id)

    logger.info("[supervisor] retry budget exhausted — returning last response")
    return last_response


def _run_decomposed(
    question: str,
    user_input_template: str,
    agent_factory: Callable[[], Agent],
    model_factory: Callable[[], Any],
    state_resetter: Callable[[str], None],
    cached_state_getter: Callable[[], Dict[str, Any]],
    state: SupervisorState,
) -> Any:
    """
    Run the decomposer, fan out one sub-query at a time, merge in Python.
    Returns None if decomposition can't be applied; otherwise an AgentResult-like.
    """
    cached = cached_state_getter()
    schema = cached.get("schema_digest", "")
    plan = decompose_question(question, schema, model_factory)
    if plan is None or not plan.sub_queries:
        return None

    logger.info(
        "[supervisor] decomposing into %d sub-queries (merge_key=%r)",
        len(plan.sub_queries), plan.merge_key,
    )

    sub_results: List[Dict[str, Any]] = []
    for idx, sub in enumerate(plan.sub_queries, start=1):
        state_resetter(f"{state.session_id}-sub{idx}")
        # Replace the question portion of the input with the sub-query.
        # user_input_template starts with the [ontology:...] hint header.
        header = user_input_template.split("\n", 1)[0]
        sub_input = f"{header}\n{sub.natural_language}"
        logger.info("[supervisor] sub-query %d: %s", idx, sub.natural_language[:120])

        agent = agent_factory()
        try:
            response = agent(sub_input)
        except Exception as e:
            logger.warning("[supervisor] sub-query %d failed: %s", idx, e)
            continue

        sub_state = cached_state_getter()
        sub_results.append({
            "purpose": sub.purpose,
            "join_key": sub.join_key,
            "answer": _extract_text(response),
            "query_result": sub_state.get("query_result", ""),
        })

    if not sub_results:
        return None

    # Build a merged answer description. The structured response payload that
    # invoke() returns to the caller is rebuilt from the LAST cached query
    # result, so we expose all sub-results in the answer text.
    merged = (
        "Decomposed question into "
        f"{len(sub_results)} sub-queries:\n"
        + "\n".join(f"- {r['purpose']}: {_summarize(r['answer'])}" for r in sub_results)
    )
    logger.info("[supervisor] merged answer: %s", merged[:200])

    # The Strands AgentResult shape we care about downstream is .structured_output
    # and .message[content][0][text]. Build a tiny stand-in.
    return _SyntheticAgentResult(merged)


def _extract_text(response: Any) -> str:
    """Best-effort extraction of the agent's final text answer."""
    if response is None:
        return ""
    so = getattr(response, "structured_output", None)
    if so is not None:
        ans = getattr(so, "answer", "")
        if ans:
            return ans
    msg = getattr(response, "message", None)
    if isinstance(msg, dict):
        try:
            return msg["content"][0]["text"]
        except (KeyError, IndexError, TypeError):
            return str(msg)
    return str(response)


def _summarize(text: str, limit: int = 200) -> str:
    text = text.strip().replace("\n", " ")
    return text if len(text) <= limit else text[:limit] + "..."


class _SyntheticAgentResult:
    """Minimal AgentResult-shaped object for decomposed answers."""

    def __init__(self, text: str):
        from .query_prompts import QueryAnswer
        self.structured_output = QueryAnswer(answer=text)
        self.message = {"content": [{"text": text}]}
