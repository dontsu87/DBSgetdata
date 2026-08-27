import os
import shutil
import pandas as pd
from datetime import datetime, timedelta
import pytest

from src.stationary_tracker import (
    update_stationary_state,
    load_stationary_state,
    haversine_distance,
    STATIONARY_STATE_FILENAME,
)


def test_haversine_distance():
    # 同一地点なら 0
    assert haversine_distance(36.5, 136.6, 36.5, 136.6) == 0.0
    # 約111km (緯度1度)
    d = haversine_distance(36.0, 136.0, 37.0, 136.0)
    assert 110000 < d < 112000


def test_stationary_tracker_lifecycle(tmp_path):
    output_dir = str(tmp_path)
    state_file = os.path.join(output_dir, STATIONARY_STATE_FILENAME)

    t0 = datetime(2026, 8, 27, 10, 0, 0)
    t1 = t0 + timedelta(minutes=5)
    t2 = t0 + timedelta(minutes=10)
    t3 = t0 + timedelta(hours=2, minutes=5)

    # 1回目: 利用中自転車が観測される (36.593298, 136.66964)
    df0 = pd.DataFrame([{
        "識別番号": "BIKE-001",
        "車両状態": "利用中",
        "車両位置緯度": 36.593298,
        "車両位置経度": 136.66964,
    }])
    res0 = update_stationary_state(df0, output_dir, now_dt=t0)
    assert res0.loc[0, "静止開始日時"] == "2026-08-27 10:00:00"
    assert res0.loc[0, "静止継続時間(秒)"] == ""  # 0秒は空文字

    # 2回目: 5分後、同一地点にとどまっている (移動距離 5m 以内)
    df1 = pd.DataFrame([{
        "識別番号": "BIKE-001",
        "車両状態": "利用中",
        "車両位置緯度": 36.593300,
        "車両位置経度": 136.66965,
    }])
    res1 = update_stationary_state(df1, output_dir, now_dt=t1)
    assert res1.loc[0, "静止開始日時"] == "2026-08-27 10:00:00"
    assert res1.loc[0, "静止継続時間(秒)"] == 300  # 5分 = 300秒

    # 3回目: 2時間5分後、まだ同一地点にとどまっている
    res3 = update_stationary_state(df1, output_dir, now_dt=t3)
    assert res3.loc[0, "静止開始日時"] == "2026-08-27 10:00:00"
    assert res3.loc[0, "静止継続時間(秒)"] == 7500  # 2時間5分 = 7500秒

    # 4回目: 大きく移動した (500m先へ) -> 静止タイマーリセット
    t4 = t3 + timedelta(minutes=5)
    df4 = pd.DataFrame([{
        "識別番号": "BIKE-001",
        "車両状態": "利用中",
        "車両位置緯度": 36.598000,
        "車両位置経度": 136.675000,
    }])
    res4 = update_stationary_state(df4, output_dir, now_dt=t4)
    assert res4.loc[0, "静止開始日時"] == t4.strftime("%Y-%m-%d %H:%M:%S")
    assert res4.loc[0, "静止継続時間(秒)"] == ""  # リセットされて0秒

    # 5回目: 返却されて「利用可能」になった -> 追跡ステートから削除
    t5 = t4 + timedelta(minutes=5)
    df5 = pd.DataFrame([{
        "識別番号": "BIKE-001",
        "車両状態": "利用可能",
        "車両位置緯度": 36.598000,
        "車両位置経度": 136.675000,
    }])
    res5 = update_stationary_state(df5, output_dir, now_dt=t5)
    assert res5.loc[0, "静止開始日時"] == ""
    assert res5.loc[0, "静止継続時間(秒)"] == ""
    state_after = load_stationary_state(state_file)
    assert "BIKE-001" not in state_after
