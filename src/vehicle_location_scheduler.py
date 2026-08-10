# -*- coding: utf-8 -*-
"""車両位置詳細の1時間周期制御と、5分更新間の位置キャッシュ。"""

import csv
import json
import time
from pathlib import Path


HOURLY_STATE_FILENAME = "vehicle_location_hourly_state.json"
LOCATION_CACHE_FILENAME = "vehicle_location_cache.json"
DEFAULT_INTERVAL_SEC = 60 * 60

LOCATION_COLUMNS = (
    "位置詳細取得フラグ",
    "位置詳細取得状態",
    "車両位置緯度",
    "車両位置経度",
    "車両位置測位日時",
    "車両位置標高",
    "車両位置速度",
    "車両位置方位",
    "車両位置衛星数",
)


def _json_path(output_dir, filename):
    return Path(output_dir) / filename


def _read_object(path):
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _json_safe(value):
    """Pandas/NumPyスカラーを標準JSON型へ変換します。"""
    if value is None:
        return None
    if hasattr(value, "item"):
        try:
            value = value.item()
        except (TypeError, ValueError):
            pass
    try:
        if value != value:
            return None
    except (TypeError, ValueError):
        pass
    return value

def _write_object(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def load_mismatch_vehicle_ids(output_dir):
    """直近CSVのポート位置不整合フラグから、次回5分取得の対象IDを読み込みます。"""
    files = sorted(Path(output_dir).glob("車両情報_*.csv"))
    if not files:
        return set()
    latest = files[-1]
    try:
        with latest.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if "識別番号" not in (reader.fieldnames or []):
                return set()
            if "ポート位置不整合" not in (reader.fieldnames or []):
                return set()
            return {
                str(row.get("識別番号", "")).strip()
                for row in reader
                if str(row.get("ポート位置不整合", "")).strip().lower()
                in ("true", "1", "yes", "on", "ポート位置不整合")
            }
    except (OSError, UnicodeError, csv.Error):
        return set()

def should_skip_scrape(output_dir, *, now=None):
    """全車両取得直後の10分クールダウン中か判定します。"""
    state = _read_object(_json_path(output_dir, HOURLY_STATE_FILENAME))
    try:
        cooldown_until = float(state.get("cooldown_until_epoch", 0))
        current = time.time() if now is None else float(now)
    except (TypeError, ValueError):
        return False
    return current < cooldown_until

def should_fetch_all_locations(output_dir, *, now=None, interval_sec=DEFAULT_INTERVAL_SEC):
    """前回成功した全車両位置取得から1時間以上経過しているか判定します。

    状態ファイルがまだ無い場合は、初回の5分更新を重くしないためFalseです。
    初回成功後に ``mark_location_fetch_completed`` が状態を作成します。
    """
    state = _read_object(_json_path(output_dir, HOURLY_STATE_FILENAME))
    last_completed = state.get("last_completed_epoch")
    try:
        last_completed = float(last_completed)
        interval_sec = max(0, float(interval_sec))
    except (TypeError, ValueError):
        return False
    current = time.time() if now is None else float(now)
    return current - last_completed >= interval_sec


def extend_scrape_cooldown(output_dir, *, now=None, cooldown_sec, cooldown_started_at=None):
    """全車両取得の周期(last_completed_epoch)には触れず、通常スクレイピングの
    クールダウン(cooldown_until_epoch)だけを延長する。

    他の重い処理（例: ポート位置の定期更新）が完了した直後に、5分周期の
    通常スクレイピングと重ならないよう一時的に間隔を空けたい場合に使う。
    既存のクールダウンがこれより長く残っている場合は短縮しない。
    """
    path = _json_path(output_dir, HOURLY_STATE_FILENAME)
    state = _read_object(path)
    current = time.time() if now is None else float(now)
    try:
        cooldown_sec = max(0, float(cooldown_sec))
    except (TypeError, ValueError):
        cooldown_sec = 0
    if not cooldown_sec:
        return
    cooldown_base = current if cooldown_started_at is None else float(cooldown_started_at)
    new_until = cooldown_base + cooldown_sec

    try:
        existing_until = float(state.get("cooldown_until_epoch"))
    except (TypeError, ValueError):
        existing_until = 0
    state["cooldown_until_epoch"] = max(existing_until, new_until)
    _write_object(path, state)


def has_location_fetch_schedule(output_dir):
    "初回の基準時刻が既に保存されているか確認します。"
    state = _read_object(_json_path(output_dir, HOURLY_STATE_FILENAME))
    try:
        float(state.get("last_completed_epoch"))
    except (TypeError, ValueError):
        return False
    return True


def mark_location_fetch_completed(
    output_dir,
    *,
    now=None,
    cooldown_sec=0,
    cooldown_started_at=None,
):
    """位置詳細を含むスクレイピングが正常完了した時刻を保存します。

    ``cooldown_started_at`` を指定した場合、全車両取得後の待機時間は
    取得完了時ではなく取得開始時から数えます。
    """
    current = time.time() if now is None else float(now)
    try:
        cooldown_sec = max(0, float(cooldown_sec))
    except (TypeError, ValueError):
        cooldown_sec = 0
    state = {"last_completed_epoch": current}
    if cooldown_sec:
        cooldown_base = current if cooldown_started_at is None else float(cooldown_started_at)
        state["cooldown_until_epoch"] = cooldown_base + cooldown_sec
    _write_object(_json_path(output_dir, HOURLY_STATE_FILENAME), state)


def merge_cached_vehicle_locations(frame, output_dir):
    """今回取得しなかった車両へ、直近の位置詳細を引き継ぎます。"""
    if frame is None or frame.empty or "識別番号" not in frame.columns:
        return frame

    cache = _read_object(_json_path(output_dir, LOCATION_CACHE_FILENAME))
    for column in LOCATION_COLUMNS:
        if column not in frame.columns:
            frame[column] = "" if column == "位置詳細取得状態" else None

    for index, row in frame.iterrows():
        vehicle_id = str(row.get("識別番号", "")).strip()
        cached = cache.get(vehicle_id)
        if not vehicle_id or not isinstance(cached, dict):
            continue

        try:
            current_flag = int(row.get("位置詳細取得フラグ", 0) or 0)
        except (TypeError, ValueError):
            current_flag = 0
        if current_flag == 1:
            continue

        copied = False
        for column in LOCATION_COLUMNS:
            if column not in cached:
                continue
            value = cached[column]
            if value is None or value == "":
                continue
            frame.at[index, column] = value
            copied = True
        if copied:
            frame.at[index, "位置詳細取得状態"] = "キャッシュ"

    return frame


def update_vehicle_location_cache(frame, output_dir, *, now=None):
    """今回の詳細取得成功分だけをキャッシュへ保存します。"""
    if frame is None or frame.empty or "識別番号" not in frame.columns:
        return

    cache_path = _json_path(output_dir, LOCATION_CACHE_FILENAME)
    cache = _read_object(cache_path)
    cached_at = time.time() if now is None else float(now)
    for _, row in frame.iterrows():
        vehicle_id = str(row.get("識別番号", "")).strip()
        if not vehicle_id:
            continue
        try:
            fetched = int(row.get("位置詳細取得フラグ", 0) or 0) == 1
        except (TypeError, ValueError):
            fetched = False
        if not fetched:
            continue
        cache[vehicle_id] = {
            column: _json_safe(row.get(column))
            for column in LOCATION_COLUMNS
            if column in frame.columns
        }
        cache[vehicle_id]["cached_at_epoch"] = cached_at

    _write_object(cache_path, cache)
