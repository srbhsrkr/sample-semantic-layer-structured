"""
Unit tests for the query-agent supervisor loop, schema digest, and
structured-output models (picks 1, 2, 3).
"""

import json
import os
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "agents"))


# ---------------------------------------------------------------------------
# Pick 2 — schema digest
# ---------------------------------------------------------------------------

def test_schema_digest_includes_class_and_columns():
    from ontology_query_agent.schema_digest import build_schema_digest

    ontology = {
        "classes": {
            "http://ex.com/Customer": {
                "label": "Customer",
                "comment": "A person who holds at least one policy",
            }
        },
        "properties": {
            "http://ex.com/firstName": {
                "label": "first_name",
                "comment": "Customer's given name",
            }
        },
        "mappings": {
            "http://ex.com/Customer": {"table": "db.customers"},
            "http://ex.com/firstName": {"column": "customers.first_name"},
        },
    }
    digest = build_schema_digest(ontology)
    assert "TABLE db.customers (Customer)" in digest
    assert "A person who holds at least one policy" in digest
    assert "first_name" in digest
    assert "Customer's given name" in digest


def test_schema_digest_skips_classes_without_table_mapping():
    from ontology_query_agent.schema_digest import build_schema_digest

    ontology = {
        "classes": {
            "http://ex.com/Abstract": {"label": "Abstract"},
        },
        "properties": {},
        "mappings": {},
    }
    digest = build_schema_digest(ontology)
    assert "Abstract" not in digest
    assert digest == ""


def test_schema_digest_truncates_huge_ontologies():
    from ontology_query_agent.schema_digest import (
        MAX_DIGEST_CHARS,
        build_schema_digest,
    )

    classes = {
        f"http://ex.com/Class{i}": {"label": f"Class{i}", "comment": "X" * 200}
        for i in range(500)
    }
    mappings = {f"http://ex.com/Class{i}": {"table": f"db.t{i}"} for i in range(500)}
    digest = build_schema_digest({"classes": classes, "properties": {}, "mappings": mappings})
    assert len(digest) <= MAX_DIGEST_CHARS + 100  # plus the truncation marker
    assert "[truncated]" in digest


def test_schema_digest_from_json_handles_invalid_input():
    from ontology_query_agent.schema_digest import build_schema_digest_from_json

    assert build_schema_digest_from_json("") == ""
    assert build_schema_digest_from_json("not-json") == ""


# ---------------------------------------------------------------------------
# Pick 1 — supervisor state + runner
# ---------------------------------------------------------------------------

def test_supervisor_state_retry_budget():
    from ontology_query_agent.supervisor import (
        MAX_QUERY_ATTEMPTS,
        MAX_REPLAN_ATTEMPTS,
        SupervisorState,
    )

    # Budget is intentionally tight (2 attempts) to keep latency bounded — see
    # supervisor.py docstring for rationale. Bump consciously, not by accident.
    assert MAX_QUERY_ATTEMPTS == 2

    s = SupervisorState(session_id="abc", question="how many customers?")
    assert s.can_retry()
    assert s.can_replan()
    s.query_attempts = MAX_QUERY_ATTEMPTS
    assert not s.can_retry()
    s.replan_attempts = MAX_REPLAN_ATTEMPTS
    assert not s.can_replan()


def _make_response(answer_text: str):
    """Build a fake AgentResult with .structured_output and .message."""
    from ontology_query_agent.query_prompts import QueryAnswer

    return SimpleNamespace(
        structured_output=QueryAnswer(answer=answer_text),
        message={"content": [{"text": answer_text}]},
    )


def test_run_supervised_stops_on_first_success(monkeypatch):
    from ontology_query_agent import supervisor_runner
    from ontology_query_agent.supervisor import SupervisorDecision, SupervisorState

    fake_agent = MagicMock(return_value=_make_response("There are 42 customers."))

    monkeypatch.setattr(
        supervisor_runner,
        "evaluate_answer",
        lambda q, t, c, m: SupervisorDecision(
            satisfied=True, reason="answer is grounded", next_action="stop"
        ),
    )

    state = SupervisorState(session_id="s1", question="how many customers?")
    out = supervisor_runner.run_supervised(
        user_input="[ontology: x]\nhow many customers?",
        question="how many customers?",
        state=state,
        agent_factory=lambda: fake_agent,
        model_factory=lambda: MagicMock(),
        state_resetter=lambda sid: None,
        cached_state_getter=lambda: {},
    )
    assert out.structured_output.answer == "There are 42 customers."
    assert state.query_attempts == 1
    assert fake_agent.call_count == 1


def test_run_supervised_retries_with_hint(monkeypatch):
    from ontology_query_agent import supervisor_runner
    from ontology_query_agent.supervisor import SupervisorDecision, SupervisorState

    responses = [
        _make_response("(no rows)"),
        _make_response("There are 42 customers."),
    ]
    fake_agent = MagicMock(side_effect=responses)

    decisions = iter([
        SupervisorDecision(
            satisfied=False, reason="empty result", next_action="retry",
            hint_for_retry="widen the date filter",
        ),
        SupervisorDecision(satisfied=True, reason="ok", next_action="stop"),
    ])
    monkeypatch.setattr(
        supervisor_runner, "evaluate_answer", lambda *a, **kw: next(decisions)
    )

    state = SupervisorState(session_id="s2", question="active customers?")
    seen_inputs = []
    fake_agent.side_effect = lambda inp: (seen_inputs.append(inp), responses.pop(0))[1]

    out = supervisor_runner.run_supervised(
        user_input="[ontology: x]\nactive customers?",
        question="active customers?",
        state=state,
        agent_factory=lambda: fake_agent,
        model_factory=lambda: MagicMock(),
        state_resetter=lambda sid: None,
        cached_state_getter=lambda: {},
    )

    assert state.query_attempts == 2
    # Second invocation must have the hint appended
    assert any("supervisor_hint" in s for s in seen_inputs)
    assert "widen the date filter" in seen_inputs[1]
    assert out.structured_output.answer == "There are 42 customers."


def test_run_supervised_decomposes_when_judge_says_so(monkeypatch):
    from ontology_query_agent import supervisor_runner
    from ontology_query_agent.supervisor import (
        DecompositionPlan,
        SubQuery,
        SupervisorDecision,
        SupervisorState,
    )

    main_resp = _make_response("ran out of context")
    sub_resp_1 = _make_response("Customer count: 100")
    sub_resp_2 = _make_response("Policy count: 250")

    call_log = []

    def fake_agent_callable(inp):
        call_log.append(inp)
        if "[supervisor_hint" not in inp and "Customer count" not in inp:
            if len(call_log) == 1:
                return main_resp
        if "first sub-query" in inp:
            return sub_resp_1
        return sub_resp_2

    fake_agent = MagicMock(side_effect=fake_agent_callable)

    decisions = iter([
        SupervisorDecision(
            satisfied=False,
            reason="too complex, multi-hop",
            next_action="decompose",
        ),
    ])
    monkeypatch.setattr(
        supervisor_runner, "evaluate_answer", lambda *a, **kw: next(decisions)
    )
    monkeypatch.setattr(
        supervisor_runner,
        "decompose_question",
        lambda q, schema, mf: DecompositionPlan(
            sub_queries=[
                SubQuery(
                    purpose="count customers",
                    natural_language="first sub-query: count of customers",
                    join_key="customer_id",
                ),
                SubQuery(
                    purpose="count policies",
                    natural_language="second sub-query: count of policies",
                    join_key="policy_id",
                ),
            ],
            merge_key="customer_id",
            rationale="multi-hop",
        ),
    )

    state = SupervisorState(session_id="s3", question="how many policies per customer?")
    out = supervisor_runner.run_supervised(
        user_input="[ontology: x]\nhow many policies per customer?",
        question="how many policies per customer?",
        state=state,
        agent_factory=lambda: fake_agent,
        model_factory=lambda: MagicMock(),
        state_resetter=lambda sid: None,
        cached_state_getter=lambda: {"schema_digest": "TABLE db.customers"},
    )

    assert state.replan_attempts == 1
    # Final answer should be the synthetic merged answer text
    assert "count customers" in out.structured_output.answer
    assert "count policies" in out.structured_output.answer


def test_run_supervised_exhausts_budget_without_loop(monkeypatch):
    from ontology_query_agent import supervisor_runner
    from ontology_query_agent.supervisor import (
        MAX_QUERY_ATTEMPTS,
        SupervisorDecision,
        SupervisorState,
    )

    fake_agent = MagicMock(return_value=_make_response("still bad"))
    monkeypatch.setattr(
        supervisor_runner,
        "evaluate_answer",
        lambda *a, **kw: SupervisorDecision(
            satisfied=False, reason="bad", next_action="retry"
        ),
    )

    state = SupervisorState(session_id="s4", question="x")
    supervisor_runner.run_supervised(
        user_input="[ontology: y]\nx",
        question="x",
        state=state,
        agent_factory=lambda: fake_agent,
        model_factory=lambda: MagicMock(),
        state_resetter=lambda sid: None,
        cached_state_getter=lambda: {},
    )
    assert state.query_attempts == MAX_QUERY_ATTEMPTS


# ---------------------------------------------------------------------------
# Pick 2 / 3 — Pydantic models
# ---------------------------------------------------------------------------

def test_column_choice_validation():
    from pydantic import ValidationError

    from ontology_query_agent.supervisor import ColumnChoice

    ok = ColumnChoice(
        table="db.customers",
        column="first_name",
        ontology_term_uri="http://ex.com/firstName",
        confidence=0.9,
    )
    assert ok.confidence == 0.9
    with pytest.raises(ValidationError):
        ColumnChoice(
            table="db.customers",
            ontology_term_uri="http://ex.com/firstName",
            confidence=1.5,  # out of range
        )


def test_decomposition_plan_requires_at_least_one_subquery():
    from pydantic import ValidationError

    from ontology_query_agent.supervisor import DecompositionPlan

    with pytest.raises(ValidationError):
        DecompositionPlan(sub_queries=[])


# ---------------------------------------------------------------------------
# Safety override — judge said "retry" but SQL ran cleanly without a hint
# ---------------------------------------------------------------------------

def _cached_with_query_result(row_count: int = 0, error: str = "") -> dict:
    payload: dict = {"sql_query": "SELECT COUNT(*) FROM x", "row_count": row_count}
    if error:
        payload = {"error": error}
    return {"query_result": json.dumps(payload)}


def test_safety_override_coerces_retry_to_stop_when_sql_ran_cleanly():
    """0-row count on a clean SQL run is a valid answer — judge over-eager."""
    from ontology_query_agent.supervisor import SupervisorDecision
    from ontology_query_agent.supervisor_runner import _apply_safety_overrides

    judge_says = SupervisorDecision(
        satisfied=False,
        reason="0 rows looks suspicious",
        next_action="retry",
        hint_for_retry="",  # no actionable hint
    )
    out = _apply_safety_overrides(judge_says, _cached_with_query_result(row_count=0))
    assert out.next_action == "stop"
    assert "override" in out.reason.lower()


def test_safety_override_keeps_retry_when_judge_has_actionable_hint():
    """If the judge gave a concrete hint, we trust it and let the retry happen."""
    from ontology_query_agent.supervisor import SupervisorDecision
    from ontology_query_agent.supervisor_runner import _apply_safety_overrides

    judge_says = SupervisorDecision(
        satisfied=False,
        reason="wrong catalog",
        next_action="retry",
        hint_for_retry="Try catalog s3tablescatalog/...",
    )
    out = _apply_safety_overrides(judge_says, _cached_with_query_result(row_count=0))
    assert out.next_action == "retry"


def test_safety_override_keeps_retry_when_sql_failed():
    """If the SQL itself errored, retrying may help — don't override."""
    from ontology_query_agent.supervisor import SupervisorDecision
    from ontology_query_agent.supervisor_runner import _apply_safety_overrides

    judge_says = SupervisorDecision(
        satisfied=False, reason="SQL error", next_action="retry", hint_for_retry=""
    )
    cached = _cached_with_query_result(error="TABLE_NOT_FOUND")
    out = _apply_safety_overrides(judge_says, cached)
    assert out.next_action == "retry"


def test_safety_override_passthrough_for_non_retry_actions():
    """stop/decompose/clarify are never coerced."""
    from ontology_query_agent.supervisor import SupervisorDecision
    from ontology_query_agent.supervisor_runner import _apply_safety_overrides

    for act in ("stop", "decompose", "clarify"):
        d = SupervisorDecision(satisfied=True, reason="ok", next_action=act)
        assert _apply_safety_overrides(d, _cached_with_query_result()).next_action == act


def test_run_supervised_stops_after_one_clean_retry_with_no_hint(monkeypatch):
    """End-to-end: judge says retry without a hint, SQL ran cleanly → loop stops."""
    from ontology_query_agent import supervisor_runner
    from ontology_query_agent.supervisor import SupervisorDecision, SupervisorState

    fake_agent = MagicMock(return_value=_make_response("0 active riders found."))

    # Judge would say retry-without-hint; the deterministic override coerces to stop.
    monkeypatch.setattr(
        supervisor_runner,
        "evaluate_answer",
        lambda q, t, c, m: supervisor_runner._apply_safety_overrides(
            SupervisorDecision(
                satisfied=False, reason="suspicious 0",
                next_action="retry", hint_for_retry="",
            ),
            c,
        ),
    )

    state = SupervisorState(session_id="r1", question="active riders 12mo?")
    out = supervisor_runner.run_supervised(
        user_input="[ontology: x]\nactive riders 12mo?",
        question="active riders 12mo?",
        state=state,
        agent_factory=lambda: fake_agent,
        model_factory=lambda: MagicMock(),
        state_resetter=lambda sid: None,
        cached_state_getter=lambda: _cached_with_query_result(row_count=0),
    )
    assert state.query_attempts == 1
    assert out.structured_output.answer == "0 active riders found."
