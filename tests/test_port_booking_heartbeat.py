# -*- coding: utf-8 -*-
import json
from datetime import datetime, timezone

from src.port_booking_heartbeat import run_heartbeat


def test_heartbeat_runs_every_other_jst_date_and_retries_failure_after_six_hours(tmp_path, monkeypatch):
    (tmp_path / "config").mkdir()
    (tmp_path / "config" / "port_booking_recipes.json").write_text("{}", encoding="utf-8")
    output = tmp_path / "output"
    monkeypatch.setattr("src.port_booking_heartbeat.Config.OUTPUT_DIR", str(output))
    calls = []
    runner = lambda args: calls.append(args) or 0

    assert run_heartbeat(now=datetime(2026, 9, 12, 0, tzinfo=timezone.utc), runner=runner, root=tmp_path) == 0
    assert run_heartbeat(now=datetime(2026, 9, 13, 14, tzinfo=timezone.utc), runner=runner, root=tmp_path) == 0
    assert len(calls) == 1
    assert run_heartbeat(now=datetime(2026, 9, 14, 0, tzinfo=timezone.utc), runner=runner, root=tmp_path) == 0
    assert len(calls) == 2

    state_path = output / "port_booking_heartbeat_state.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    state.pop("last_success_date")
    state["last_attempt_at"] = "2026-09-14T09:00:00+09:00"
    state_path.write_text(json.dumps(state), encoding="utf-8")
    failing = lambda args: calls.append(args) or 1
    assert run_heartbeat(now=datetime(2026, 9, 14, 2, tzinfo=timezone.utc), runner=failing, root=tmp_path) == 0
    assert run_heartbeat(now=datetime(2026, 9, 14, 7, tzinfo=timezone.utc), runner=failing, root=tmp_path) == 1
