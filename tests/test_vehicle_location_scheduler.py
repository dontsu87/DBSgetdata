# -*- coding: utf-8 -*-
import json

import pandas as pd

from src.vehicle_location_scheduler import (
    LOCATION_CACHE_FILENAME,
    HOURLY_STATE_FILENAME,
    mark_location_fetch_completed,
    merge_cached_vehicle_locations,
    should_skip_scrape,
    should_fetch_all_locations,
    update_vehicle_location_cache,
)


def test_hourly_schedule_does_not_repeat_before_one_hour(tmp_path):
    assert should_fetch_all_locations(tmp_path, now=100) is False
    mark_location_fetch_completed(tmp_path, now=100)
    assert should_fetch_all_locations(tmp_path, now=100 + 3599) is False
    assert should_fetch_all_locations(tmp_path, now=100 + 3600) is True


def test_full_fetch_cooldown_uses_fetch_start_time(tmp_path):
    mark_location_fetch_completed(
        tmp_path,
        now=200,
        cooldown_started_at=100,
        cooldown_sec=600,
    )
    assert should_skip_scrape(tmp_path, now=699) is True
    assert should_skip_scrape(tmp_path, now=700) is False

def test_location_cache_preserves_port_vehicle_between_five_minute_runs(tmp_path):
    fetched = pd.DataFrame([
        {
            "識別番号": "KNZ-001",
            "位置詳細取得フラグ": 1,
            "位置詳細取得状態": "取得成功",
            "車両位置緯度": 36.577,
            "車両位置経度": 136.648,
            "車両位置測位日時": "2026-08-10T01:00:00Z",
        }
    ])
    update_vehicle_location_cache(fetched, tmp_path, now=100)

    next_frame = pd.DataFrame([
        {
            "識別番号": "KNZ-001",
            "位置詳細取得フラグ": 0,
            "位置詳細取得状態": "対象外",
            "車両位置緯度": None,
            "車両位置経度": None,
        }
    ])
    merged = merge_cached_vehicle_locations(next_frame, tmp_path)
    assert merged.loc[0, "位置詳細取得状態"] == "キャッシュ"
    assert merged.loc[0, "車両位置緯度"] == 36.577
    assert merged.loc[0, "車両位置経度"] == 136.648

    assert json.loads((tmp_path / LOCATION_CACHE_FILENAME).read_text(encoding="utf-8"))["KNZ-001"]["cached_at_epoch"] == 100
    assert not (tmp_path / HOURLY_STATE_FILENAME).exists()
