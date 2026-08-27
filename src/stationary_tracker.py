"""
車両の静止状態追跡モジュール
「利用中」車両のGPS座標の推移を監視し、同一地点（50m以内）での静止継続時間を計算・永続化する。
"""

import os
import json
import math
from datetime import datetime, timedelta
from typing import Optional
import pandas as pd


STATIONARY_STATE_FILENAME = "vehicle_stationary_state.json"
DEFAULT_STATIONARY_THRESHOLD_METERS = 50.0


def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """2つの緯度経度間の距離（メートル）を計算する"""
    R = 6371000.0  # 地球の半径（m）
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = (
        math.sin(delta_phi / 2.0) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0) ** 2
    )
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return R * c


def load_stationary_state(state_file_path: str) -> dict:
    """永続化ファイルから静止状態データを読み込む"""
    if not os.path.exists(state_file_path):
        return {}
    try:
        with open(state_file_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception as e:
        print(f"Warning: {state_file_path} の読み込みに失敗しました: {e}")
        return {}


def save_stationary_state(state_file_path: str, state: dict) -> None:
    """静止状態データを一時ファイル経由で安全に書き出す"""
    try:
        os.makedirs(os.path.dirname(state_file_path), exist_ok=True)
        tmp_path = f"{state_file_path}.tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, state_file_path)
    except Exception as e:
        print(f"Warning: {state_file_path} の保存に失敗しました: {e}")


def update_stationary_state(
    df: pd.DataFrame,
    output_dir: str,
    now_dt: Optional[datetime] = None,
    threshold_meters: float = DEFAULT_STATIONARY_THRESHOLD_METERS,
) -> pd.DataFrame:
    """
    車両DataFrameに対して、各車両の静止状態を判定・更新し、
    '静止開始日時' および '静止継続時間(秒)' カラムを追加して返す。
    """
    if now_dt is None:
        now_dt = datetime.now()
    now_str = now_dt.strftime("%Y-%m-%d %H:%M:%S")

    state_file_path = os.path.join(output_dir, STATIONARY_STATE_FILENAME)
    prev_state = load_stationary_state(state_file_path)
    new_state = dict(prev_state)

    stationary_started_list = []
    stationary_duration_list = []

    has_code = "識別番号" in df.columns
    has_state = "車両状態" in df.columns
    has_lat = "車両位置緯度" in df.columns
    has_lon = "車両位置経度" in df.columns

    for _, row in df.iterrows():
        b_id = str(row["識別番号"]).strip() if has_code and pd.notna(row["識別番号"]) else ""
        status = str(row["車両状態"]).strip() if has_state and pd.notna(row["車両状態"]) else ""
        
        lat_raw = row["車両位置緯度"] if has_lat else None
        lon_raw = row["車両位置経度"] if has_lon else None

        try:
            curr_lat = float(lat_raw) if pd.notna(lat_raw) and str(lat_raw).strip() != "" else None
            curr_lon = float(lon_raw) if pd.notna(lon_raw) and str(lon_raw).strip() != "" else None
        except (ValueError, TypeError):
            curr_lat = None
            curr_lon = None

        started_at = ""
        duration = 0

        if b_id and status in ("利用中", "USING"):
            prev_info = prev_state.get(b_id)

            if curr_lat is not None and curr_lon is not None:
                if prev_info and prev_info.get("lat") is not None and prev_info.get("lon") is not None:
                    prev_lat = float(prev_info["lat"])
                    prev_lon = float(prev_info["lon"])
                    dist = haversine_distance(curr_lat, curr_lon, prev_lat, prev_lon)

                    if dist <= threshold_meters:
                        # 50m以内: 静止継続中
                        started_at = prev_info.get("stationary_started_at") or now_str
                        try:
                            started_dt = datetime.strptime(started_at, "%Y-%m-%d %H:%M:%S")
                            duration = max(0, int((now_dt - started_dt).total_seconds()))
                        except Exception:
                            duration = 0
                            started_at = now_str
                    else:
                        # 50m超: 移動検知 -> タイマーリセット
                        started_at = now_str
                        duration = 0
                else:
                    # 前回の座標記録がない場合は現在時刻を起点とする
                    started_at = now_str
                    duration = 0

                new_state[b_id] = {
                    "lat": curr_lat,
                    "lon": curr_lon,
                    "stationary_started_at": started_at,
                    "duration_sec": duration,
                    "last_seen_at": now_str,
                }
            else:
                # GPS座標が取れなかった場合は、前回の状態があればそのまま維持
                if prev_info:
                    started_at = prev_info.get("stationary_started_at", now_str)
                    try:
                        started_dt = datetime.strptime(started_at, "%Y-%m-%d %H:%M:%S")
                        duration = max(0, int((now_dt - started_dt).total_seconds()))
                    except Exception:
                        duration = 0
                    new_state[b_id] = {
                        "lat": prev_info.get("lat"),
                        "lon": prev_info.get("lon"),
                        "stationary_started_at": started_at,
                        "duration_sec": duration,
                        "last_seen_at": now_str,
                    }
                else:
                    started_at = now_str
                    duration = 0
        else:
            # 「利用中」でない車両は追跡から削除（返却・クリーンアップ）
            if b_id in new_state:
                del new_state[b_id]

        stationary_started_list.append(started_at)
        stationary_duration_list.append(duration if duration > 0 else "")

    # 24時間以上更新のない古いレコードをクレンジング
    cleaned_state = {}
    for k, v in new_state.items():
        last_str = v.get("last_seen_at", "")
        if last_str:
            try:
                last_dt = datetime.strptime(last_str, "%Y-%m-%d %H:%M:%S")
                if (now_dt - last_dt) < timedelta(hours=24):
                    cleaned_state[k] = v
            except Exception:
                cleaned_state[k] = v
        else:
            cleaned_state[k] = v

    save_stationary_state(state_file_path, cleaned_state)

    df_copy = df.copy()
    df_copy["静止開始日時"] = stationary_started_list
    df_copy["静止継続時間(秒)"] = stationary_duration_list
    return df_copy
