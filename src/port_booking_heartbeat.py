# -*- coding: utf-8 -*-
"""既存の5分タスクから、ポート予約処理をJSTで1日おきに起動する。"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sys
from typing import Callable
from zoneinfo import ZoneInfo

from src.config import Config
from src.port_booking_scheduler import main as scheduler_main


JST = ZoneInfo("Asia/Tokyo")
RETRY_AFTER = timedelta(hours=6)


def _read_state(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {}


def _write_state(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def run_heartbeat(
    *,
    now: datetime | None = None,
    force: bool = False,
    runner: Callable[[list[str]], int] = scheduler_main,
    root: Path | None = None,
) -> int:
    project_root = root or Path(__file__).resolve().parent.parent
    config_path = project_root / "config" / "port_booking_recipes.json"
    output_root = Path(Config.OUTPUT_DIR)
    state_path = output_root / "port_booking_heartbeat_state.json"
    current = now or datetime.now(timezone.utc)
    local_now = current.replace(tzinfo=timezone.utc).astimezone(JST) if current.tzinfo is None else current.astimezone(JST)
    state = _read_state(state_path)

    if not config_path.exists():
        return 0
    if not force:
        last_success = state.get("last_success_date")
        if last_success:
            try:
                if (local_now.date() - datetime.fromisoformat(last_success).date()).days < 2:
                    return 0
            except ValueError:
                pass
        last_attempt = state.get("last_attempt_at")
        if last_attempt:
            try:
                attempted_at = datetime.fromisoformat(last_attempt).astimezone(JST)
                if local_now - attempted_at < RETRY_AFTER:
                    return 0
            except ValueError:
                pass

    exit_code = runner([
        "--config", str(config_path),
        "--apply",
        "--publish-status",
    ])
    next_state = {
        **state,
        "last_attempt_at": local_now.isoformat(timespec="seconds"),
        "last_exit_code": exit_code,
    }
    if exit_code == 0:
        next_state["last_success_date"] = local_now.date().isoformat()
    _write_state(state_path, next_state)
    return exit_code


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="ポート予約を1日おきに補充するheartbeat")
    parser.add_argument("--force", action="store_true", help="日付ゲートを無視して直ちに実行する")
    args = parser.parse_args(argv)
    return run_heartbeat(force=args.force)


if __name__ == "__main__":
    sys.exit(main())
