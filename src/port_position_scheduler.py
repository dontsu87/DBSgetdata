# -*- coding: utf-8 -*-
"""ポート位置情報のポータルAPI定期更新（既定1日1回）の間隔制御。

車両位置の1時間周期制御（vehicle_location_scheduler.py）と同じ状態ファイル
方式を、別の状態ファイルで独立して使う。
"""

import json
import time
from pathlib import Path

STATE_FILENAME = "port_position_refresh_state.json"
DEFAULT_INTERVAL_SEC = 24 * 60 * 60


def _json_path(output_dir, filename=STATE_FILENAME):
    return Path(output_dir) / filename


def _read_object(path):
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _write_object(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def should_refresh_port_positions(output_dir, *, now=None, interval_sec=DEFAULT_INTERVAL_SEC):
    """前回成功した更新から interval_sec 以上経過しているか判定する。

    状態ファイルがまだ無い場合（初回）はTrue。
    """
    state = _read_object(_json_path(output_dir))
    last_completed = state.get("last_completed_epoch")
    if last_completed is None:
        return True
    try:
        last_completed = float(last_completed)
        interval_sec = max(0, float(interval_sec))
    except (TypeError, ValueError):
        return True
    current = time.time() if now is None else float(now)
    return current - last_completed >= interval_sec


def mark_port_position_refresh_completed(output_dir, *, now=None):
    current = time.time() if now is None else float(now)
    _write_object(_json_path(output_dir), {"last_completed_epoch": current})
