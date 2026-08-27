# -*- coding: utf-8 -*-
import os
import glob
import json
import math
import re
import pandas as pd
from datetime import datetime, timezone, timedelta
from src.config import Config, ROOT_DIR
from src.public_data_generator import generate_public_ports_data


CURRENT_AREA_NAMES = frozenset({'福井', '小松', '金沢', '上田千曲広域', '敦賀'})
AREA_CODE_ALIASES = {
    'FKI': '福井',
    'KMT': '小松',
    'KNZ': '金沢',
    'SNN': '上田千曲広域',
    'TRG': '敦賀',
}
AREA_GEOFENCES = {
    '金沢': (36.48, 36.65, 136.50, 136.75),
    '福井': (36.00, 36.15, 136.15, 136.25),
    '小松': (36.30, 36.45, 136.40, 136.50),
    '上田千曲広域': (36.30, 36.58, 138.05, 138.32),
    '敦賀': (35.50, 35.70, 136.00, 136.15),
}


def normalize_area_name(value):
    "旧管理画面のコード付きエリア名を現行ポータルの名称へ統合する。"
    name = str(value or '').strip()
    if name in CURRENT_AREA_NAMES:
        return name
    area_code = name.split('_', 1)[0].upper()
    return AREA_CODE_ALIASES.get(area_code, name)


def get_area_by_coords(lat, lon):
    "現在の対象5エリア内にある座標から現行エリア名を返す。"
    for area_name, (lat_min, lat_max, lon_min, lon_max) in AREA_GEOFENCES.items():
        if lat_min <= lat <= lat_max and lon_min <= lon <= lon_max:
            return area_name
    return None


def is_coords_in_area(area_name, lat, lon):
    normalized = normalize_area_name(area_name)
    bounds = AREA_GEOFENCES.get(normalized)
    if not bounds:
        return False
    lat_min, lat_max, lon_min, lon_max = bounds
    return lat_min <= lat <= lat_max and lon_min <= lon <= lon_max


def read_csv_safe(path):
    """エンコーコーディングを自動フォールバックしながら安全にCSVをロードします"""
    for enc in ['utf-8-sig', 'utf-8', 'cp932']:
        try:
            return pd.read_csv(path, encoding=enc)
        except Exception:
            continue
    return pd.read_csv(path)

def load_input_data(latest_vehicle_path: str = None):
    """車両データCSVおよびしきい値CSVを安全にロードします"""
    if not latest_vehicle_path:
        pattern1 = glob.glob(os.path.join(Config.OUTPUT_DIR, "車両_*.csv"))
        pattern2 = glob.glob(os.path.join(Config.OUTPUT_DIR, "車両情報_*.csv"))
        vehicle_files = [p for p in pattern1 + pattern2 if "gbfs" not in p and "onedrive" not in p]
        if not vehicle_files:
            print("Error: 車両情報CSVが見つかりません。")
            return None, None
            
        def _extract_dt(p):
            m = re.search(r'(\d{8}_\d{6})', p)
            return m.group(1) if m else ''
            
        vehicle_files.sort(key=_extract_dt)
        latest_vehicle_path = vehicle_files[-1]
    
    threshold_path = os.path.join(str(ROOT_DIR), "車両閾値設定.csv")
    if not os.path.exists(threshold_path):
        print(f"Error: 閾値設定ファイル（{threshold_path}）が見つかりません。")
        return None, None

    try:
        df_vehicle = read_csv_safe(latest_vehicle_path)
        df_threshold = read_csv_safe(threshold_path)
        return df_vehicle, df_threshold
    except Exception as e:
        print(f"Error: データのロードに失敗しました: {e}")
        return None, None

def apply_vehicle_thresholds(df_vehicle, df_threshold):
    """車種判定およびしきい値マスタ適用、アラートレベルの決定を行います"""
    # キーの前後の空白を除去して安全にマージ
    df_vehicle['join_key'] = df_vehicle['識別番号'].astype(str).str.strip()
    df_threshold['join_key'] = df_threshold['車両識別番号'].astype(str).str.strip()
    
    # 古い形式のCSV（警告閾値カラムのみ）が読み込まれた場合の自動互換性補正
    if '警告閾値' in df_threshold.columns and '閾値_Lv1' not in df_threshold.columns:
        print("Warning: OneDrive上の車両閾値設定.csvが古い形式です。自動的に新形式に変換して処理を継続します。")
        df_threshold['車種名'] = "その他"
        v_strong = pd.to_numeric(df_threshold['警告閾値'], errors='coerce')
        df_threshold['閾値_画面強調'] = v_strong
        df_threshold['閾値_AT異常'] = v_strong - 4.0
        df_threshold['閾値_Lv1'] = v_strong + 0.5
        df_threshold['閾値_Lv2'] = v_strong + 1.2
        df_threshold['閾値_Lv3'] = v_strong + 2.0

    # 動的に取得した車種マッピングとしきい値マスタのロード
    df_bike_types = None
    df_type_master = None
    
    bikes_path = os.path.join(Config.OUTPUT_DIR, "bike_types.csv")
    master_path = os.path.join(Config.OUTPUT_DIR, "vehicle_type_master.csv")
    
    if os.path.exists(bikes_path):
        try:
            df_bike_types = read_csv_safe(bikes_path)
            df_bike_types['join_key'] = df_bike_types['識別番号'].astype(str).str.strip()
            print("Info: スクレイピングされた車種マッピングをロードしました。")
        except Exception as e:
            print(f"Warning: bike_types.csv のロードに失敗しました: {e}")
            
    if os.path.exists(master_path):
        try:
            df_type_master = read_csv_safe(master_path)
            print("Info: スクレイピングされた車種マスタをロードしました。")
        except Exception as e:
            print(f"Warning: vehicle_type_master.csv のロードに失敗しました: {e}")

    # 必要な列だけ抽出してマージ (5段階の警告閾値カラムと車種名を追加)
    th_cols = ['join_key', '車種名', '閾値_AT異常', '閾値_画面強調', '閾値_Lv1', '閾値_Lv2', '閾値_Lv3']
    df_t_subset = df_threshold[th_cols].drop_duplicates(subset=['join_key'])
    df_merged = pd.merge(df_vehicle, df_t_subset, on='join_key', how='left')
    
    # 閾値が設定されていない車両のデフォルト値を安全にフォールバック
    df_merged['車種名'] = df_merged['車種名'].fillna("その他")
    df_merged['閾値_AT異常'] = df_merged['閾値_AT異常'].fillna(21.0)
    df_merged['閾値_画面強調'] = df_merged['閾値_画面強調'].fillna(25.0)
    df_merged['閾値_Lv1'] = df_merged['閾値_Lv1'].fillna(25.5)
    df_merged['閾値_Lv2'] = df_merged['閾値_Lv2'].fillna(26.2)
    df_merged['閾値_Lv3'] = df_merged['閾値_Lv3'].fillna(27.0)
    
    df_merged['is_unregistered'] = False
    for idx, row in df_merged.iterrows():
        join_key = row['join_key']
        
        # 『車両閾値設定.csv』に定義済みの車両は、CSVに書かれた車種・閾値を最優先して上書きや自動補正を完全にバイパスします
        if join_key in df_threshold['join_key'].values:
            # PasCityC を「グリッター・EB」に正式書き換え（フロント表示用）のみ適用
            if str(row['車種名']).strip() == "PasCityC":
                df_merged.at[idx, '車種名'] = "グリッター・EB"
            continue
            
        df_merged.at[idx, 'is_unregistered'] = True
            
        # スクレイピングされた車種データがあれば最優先で適用
        scraped_model = None
        if df_bike_types is not None:
            match = df_bike_types[df_bike_types['join_key'] == join_key]
            if not match.empty:
                scraped_model = str(match.iloc[0]['車種']).strip()
                
        if scraped_model:
            df_merged.at[idx, '車種名'] = scraped_model
            model = scraped_model
        else:
            model = str(row['車種名']).strip()
            
        # TRGエリアで、且つAT種別情報がある場合は、直接端末のタイプ（丸形=グリッター・EB, 四角型=SW）から車種を決定します
        is_trg_area = (
            normalize_area_name(row.get('エリア名', '')) == '敦賀'
            or str(row.get('識別番号', '')).startswith('TRG')
        )
        if is_trg_area and 'AT種別' in df_merged.columns:
            at_val = str(row['AT種別']).strip()
            if "丸形" in at_val:
                df_merged.at[idx, '車種名'] = "グリッター・EB"
                model = "グリッター・EB"
            elif "四角型" in at_val:
                df_merged.at[idx, '車種名'] = "SW"
                model = "SW"
            
        # PasCityC を「グリッター・EB」に正式書き換え
        if model == "PasCityC":
            df_merged.at[idx, '車種名'] = "グリッター・EB"
            model = "グリッター・EB"
            
        # 車種マスタからのしきい値動的適用
        applied_thresholds = False
        is_trg = (
            normalize_area_name(row.get('エリア名', '')) == "敦賀"
            or str(row.get('識別番号', '')).startswith("TRG")
        )
        if df_type_master is not None and not is_trg:
            master_match = df_type_master[
                (df_type_master['車種名'].astype(str).str.strip() == model) |
                (df_type_master['車種名'].astype(str).str.strip() == "PasCityC" if model == "グリッター・EB" else False)
            ]
            if not master_match.empty:
                master_row = master_match.iloc[0]
                df_merged.at[idx, '閾値_AT異常'] = float(master_row['閾値_AT異常'])
                df_merged.at[idx, '閾値_画面強調'] = float(master_row['閾値_画面強調'])
                df_merged.at[idx, '閾値_Lv1'] = float(master_row['閾値_Lv1'])
                df_merged.at[idx, '閾値_Lv2'] = float(master_row['閾値_Lv2'])
                df_merged.at[idx, '閾値_Lv3'] = float(master_row['閾値_Lv3'])
                applied_thresholds = True

        # マスタにない場合のハードコーディング補正
        if not applied_thresholds:
            if model == "DD":
                df_merged.at[idx, '閾値_AT異常'] = 34.8
                df_merged.at[idx, '閾値_画面強調'] = 35.9
                df_merged.at[idx, '閾値_Lv1'] = 36.5
                df_merged.at[idx, '閾値_Lv2'] = 38.4
                df_merged.at[idx, '閾値_Lv3'] = None
            elif model == "グリッター・EB":
                df_merged.at[idx, '閾値_AT異常'] = 23.9
                df_merged.at[idx, '閾値_画面強調'] = 25.2
                df_merged.at[idx, '閾値_Lv1'] = 25.9
                df_merged.at[idx, '閾値_Lv2'] = 27.9
                df_merged.at[idx, '閾値_Lv3'] = None
            elif model == "SW":
                df_merged.at[idx, '閾値_AT異常'] = 20.5
                df_merged.at[idx, '閾値_画面強調'] = 24.5
                df_merged.at[idx, '閾値_Lv1'] = 23.9
                df_merged.at[idx, '閾値_Lv2'] = 24.7
                df_merged.at[idx, '閾値_Lv3'] = 26.3

    # 数値変換
    df_merged['電圧'] = pd.to_numeric(df_merged['電圧'], errors='coerce')
    for col in ['閾値_AT異常', '閾値_画面強調', '閾値_Lv1', '閾値_Lv2', '閾値_Lv3', 'lat', 'lon']:
        df_merged[col] = pd.to_numeric(df_merged[col], errors='coerce')
    
    # 多段階判定ロジック
    def determine_alert_level(row):
        volt = row['電圧']
        if pd.isna(volt):
            return 0, "最高"
        if volt <= row['閾値_AT異常']:
            return 5, "最低"
        elif volt <= row['閾値_画面強調']:
            return 4, "低"
        elif volt <= row['閾値_Lv1']:
            return 3, "中"
        elif volt <= row['閾値_Lv2']:
            return 2, "高"
        else:
            return 0, "最高"

    df_merged['alert_data'] = df_merged.apply(determine_alert_level, axis=1)
    df_merged['alert_level'] = df_merged['alert_data'].apply(lambda x: x[0])
    df_merged['alert_level_name'] = df_merged['alert_data'].apply(lambda x: x[1])
    df_merged['is_alert'] = df_merged['alert_level'] > 0
    
    return df_merged

def sync_port_area_master(df_merged):
    """管理ポータルの完全スナップショットからエリア対応を作る。

    以前はGBFSを座標ジオフェンスで自動学習していたが、隣接自治体の
    ステーションを誤って上田千曲へ取り込めるため、表示用のポート台帳は
    `port_coords_master.json`（管理ポータル取得結果）だけを正本とする。
    """
    del df_merged  # エリア・ポート対応は車両行ではなく管理ポータルを正本とする
    portal_ports = load_public_port_coords()
    master_data = {"ports": {}, "stations": {}}

    for port_name, item in portal_ports.items():
        area_name = normalize_area_name(item.get("area_name"))
        if not area_name or area_name == "その他":
            continue
        master_data["ports"][port_name] = area_name
        station_id = str(item.get("station_id") or "").strip()
        if station_id:
            master_data["stations"][station_id] = area_name

    if not portal_ports:
        print("Warning: 管理ポータルのポートスナップショットが空です。空ポートは追加しません。")
    else:
        print(f"Success: 管理ポータルのポートスナップショットを使用します（{len(portal_ports)}件）。")

    return master_data, portal_ports

def load_public_port_coords():
    """管理ポータルの完全スナップショットをロードします。"""
    coords = {}
    path = os.path.join(str(ROOT_DIR), "port_coords_master.json")
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
                for p_name, item in data.items():
                    if not isinstance(item, dict):
                        continue
                    try:
                        lat = float(item.get("lat"))
                        lon = float(item.get("lon"))
                    except (TypeError, ValueError):
                        continue
                    if not math.isfinite(lat) or not math.isfinite(lon) or lat == 0.0 or lon == 0.0:
                        continue
                    item_copy = dict(item)
                    item_copy["lat"] = lat
                    item_copy["lon"] = lon
                    item_copy["snapshot_key"] = str(item_copy.get("snapshot_key") or p_name).strip()
                    item_copy["area_name"] = normalize_area_name(item_copy.get("area_name"))
                    item_copy["station_id"] = str(item_copy.get("station_id") or "").strip()
                    item_copy["service_state"] = item_copy.get("service_state") or None
                    item_copy["publish_flag"] = item_copy.get("publish_flag")
                    try:
                        item_copy["rack_count"] = max(0, int(float(item_copy["rack_count"])))
                    except (KeyError, TypeError, ValueError):
                        item_copy["rack_count"] = 0
                    coords[str(p_name).strip()] = item_copy
        except Exception as e:
            print(f"Warning: port_coords_master.json からの座標マスタ読み込みに失敗しました: {e}")
    return coords

def _normalize_station_id(value):
    value = str(value or "").strip()
    if not value:
        return ""
    try:
        return f"{int(value):08d}"
    except (TypeError, ValueError):
        return value


def _find_port_snapshot_entry(portal_ports, port_name, station_id=None, area_name=None):
    """表示名が重複する場合もstation_id/エリアで正しいポートを選ぶ。"""
    if not isinstance(portal_ports, dict) or not port_name:
        return {}

    target_station_id = _normalize_station_id(station_id)
    direct = portal_ports.get(port_name)
    if isinstance(direct, dict):
        direct_station_id = _normalize_station_id(direct.get("station_id"))
        if not target_station_id or not direct_station_id or direct_station_id == target_station_id:
            return direct

    candidates = [
        item for item in portal_ports.values()
        if isinstance(item, dict) and item.get("port_name") == port_name
    ]
    if target_station_id:
        station_matches = [
            item for item in candidates
            if _normalize_station_id(item.get("station_id")) == target_station_id
        ]
        if station_matches:
            return station_matches[0]
    if area_name and len(candidates) > 1:
        area_matches = [
            item for item in candidates
            if normalize_area_name(item.get("area_name")) == normalize_area_name(area_name)
        ]
        if area_matches:
            return area_matches[0]
    return candidates[0] if candidates else {}

def is_empty_coord(val):
    if val is None or pd.isna(val):
        return True
    s = str(val).strip()
    return s in ('', 'nan', 'None', '0', '0.0', '0.000000')

def aggregate_ports_data(df_merged, master_data, portal_ports):
    """車両をポート単位へ集計し、管理ポータルの空ポートを追加します。"""
    ports_data = {}
    public_port_coords = load_public_port_coords()
    if not isinstance(portal_ports, dict):
        portal_ports = public_port_coords
    
    for idx, row in df_merged.iterrows():
        raw_port_name = str(row['ポート名']).strip() if not pd.isna(row.get('ポート名')) else ""
        area_name = normalize_area_name(row['エリア名']) if not pd.isna(row.get('エリア名')) else "その他"

        is_no_port = is_empty_coord(raw_port_name) or raw_port_name in ('nan', 'None', 'ポート外', '位置情報なし')
        if is_no_port:
            port_name = f"{area_name}_ポート外"
        else:
            port_name = raw_port_name

        portal_item = (
            _find_port_snapshot_entry(
                public_port_coords,
                port_name,
                row.get("station_id"),
                area_name,
            )
            if not is_no_port else {}
        )
        port_key = str(portal_item.get("snapshot_key") or port_name).strip()

        lat = row.get('lat')
        lon = row.get('lon')

        # 1. 管理ポータルの完全スナップショットからのフォールバック（実在ポートのみ）
        # 個々の車両GPS（2）より先に、ポータルが返したポート座標を優先する。
        if not is_no_port and (is_empty_coord(lat) or is_empty_coord(lon)) and portal_item:
            lat = portal_item["lat"]
            lon = portal_item["lon"]

        service_state = portal_item.get("service_state") if portal_item else None
        publish_flag = portal_item.get("publish_flag") if portal_item else None

        # 2. 車両位置緯度・経度からのフォールバック（マスタにも無い未知ポートの最終手段）
        # ポート単位の最初の行の車両GPSを採用するため、その車両が位置不整合（誤配置）だと
        # ポート自体の表示位置が誤った位置へ引きずられる。マスタに載っているポートでは使わない。
        if is_empty_coord(lat) and '車両位置緯度' in df_merged.columns and not is_empty_coord(row.get('車両位置緯度')):
            lat = row.get('車両位置緯度')
        if is_empty_coord(lon) and '車両位置経度' in df_merged.columns and not is_empty_coord(row.get('車両位置経度')):
            lon = row.get('車両位置経度')

        # ポート外仮想ポートの場合は has_gps を False とする
        has_gps = (not is_no_port) and not (is_empty_coord(lat) or is_empty_coord(lon))
        
        bike_id = str(row['識別番号'])
        status = str(row['車両status']) if '車両status' in df_merged.columns else str(row['車両状態'])
        voltage = row['電圧']
        at_time = str(row['AT通知受信日時']) if not pd.isna(row['AT通知受信日時']) else ""
        gps_datetime = str(row['車両位置測位日時']) if '車両位置測位日時' in df_merged.columns and not pd.isna(row['車両位置測位日時']) else ""
        
        s_id = row.get('station_id')
        s_id_str = _normalize_station_id(s_id) if not pd.isna(s_id) else ""
        if not s_id_str:
            s_id_str = _normalize_station_id(portal_item.get("station_id"))

        if port_key not in ports_data:
            ports_data[port_key] = {
                "port_name": "ポート外" if is_no_port else port_name,
                "area_name": area_name,
                "station_id": s_id_str,
                "lat": float(lat) if (has_gps and lat is not None) else None,
                "lon": float(lon) if (has_gps and lon is not None) else None,
                "has_gps": has_gps,
                "service_state": service_state,
                "publish_flag": publish_flag,
                "port_name_en": portal_item.get("port_name_en") or "",
                "capacity": portal_item.get("rack_count", 0),
                "total_bikes": 0,
                "max_alert_level": 0,
                "alert_bikes_count": 0,
                "bikes": []
            }
        else:
            if not ports_data[port_key].get("station_id") and s_id_str:
                ports_data[port_key]["station_id"] = s_id_str
            
        unlocked_started_at = str(row.get('連続利用開始日時', '')).strip() if '連続利用開始日時' in df_merged.columns and not pd.isna(row.get('連続利用開始日時')) else ""
        try:
            consecutive_use_duration = int(row.get('同一ポート継続利用時間(秒)', 0)) if '同一ポート継続利用時間(秒)' in df_merged.columns and not pd.isna(row.get('同一ポート継続利用時間(秒)')) and str(row.get('同一ポート継続利用時間(秒)')).strip() != "" else 0
        except Exception:
            consecutive_use_duration = 0

        stationary_started_at = str(row.get('静止開始日時', '')).strip() if '静止開始日時' in df_merged.columns and not pd.isna(row.get('静止開始日時')) else ""
        try:
            stationary_duration = int(row.get('静止継続時間(秒)', 0)) if '静止継続時間(秒)' in df_merged.columns and not pd.isna(row.get('静止継続時間(秒)')) and str(row.get('静止継続時間(秒)')).strip() != "" else 0
        except Exception:
            stationary_duration = 0

        replace_original_volt = row.get('交換前電圧')
        replace_increased_volt = row.get('交換後電圧')
        replaced_at = str(row.get('交換日時', '')).strip() if '交換日時' in df_merged.columns and not pd.isna(row.get('交換日時')) else ""
        
        try:
            replace_orig_val = float(replace_original_volt) if replace_original_volt is not None and not pd.isna(replace_original_volt) and str(replace_original_volt).strip() != "" else None
        except Exception:
            replace_orig_val = None
            
        try:
            replace_incr_val = float(replace_increased_volt) if replace_increased_volt is not None and not pd.isna(replace_increased_volt) and str(replace_increased_volt).strip() != "" else None
        except Exception:
            replace_incr_val = None

        bike_info = {
            "bike_id": bike_id,
            "status": status,
            "model_name": str(row['車種名']),
            "voltage": float(voltage) if not pd.isna(voltage) else None,
            "alert_level": int(row['alert_level']),
            "alert_level_name": str(row['alert_level_name']),
            "is_unregistered": bool(row.get('is_unregistered', False)),
            "thresholds": {
                "at_error": float(row['閾値_AT異常']),
                "strong": float(row['閾値_画面強調']),
                "lv1": float(row['閾値_Lv1']),
                "lv2": float(row['閾値_Lv2']),
                "lv3": float(row['閾値_Lv3']) if pd.notna(row['閾値_Lv3']) else None
            },
            "at_time": at_time,
            "gps_datetime": gps_datetime,
            "unlocked_started_at": unlocked_started_at,
            "consecutive_use_duration": consecutive_use_duration,
            "stationary_started_at": stationary_started_at,
            "stationary_duration": stationary_duration,
            "replace_original_volt": replace_orig_val,
            "replace_increased_volt": replace_incr_val,
            "replaced_at": replaced_at,
            "area_name": normalize_area_name(row['エリア名']) if not pd.isna(row['エリア名']) else "その他",
            "port_position_mismatch": (
                str(row.get('ポート位置不整合', '')).strip().lower()
                in ('true', '1', 'yes', 'on', 'ポート位置不整合')
            ),
            "vehicle_lat": float(row.get('車両位置緯度')) if ('車両位置緯度' in df_merged.columns and not is_empty_coord(row.get('車両位置緯度'))) else None,
            "vehicle_lon": float(row.get('車両位置経度')) if ('車両位置経度' in df_merged.columns and not is_empty_coord(row.get('車両位置経度'))) else None,
            "lat": float(row.get('車両位置緯度')) if ('車両位置緯度' in df_merged.columns and not is_empty_coord(row.get('車両位置緯度'))) else (float(row.get('lat')) if (not is_empty_coord(row.get('lat'))) else None),
            "lon": float(row.get('車両位置経度')) if ('車両位置経度' in df_merged.columns and not is_empty_coord(row.get('車両位置経度'))) else (float(row.get('lon')) if (not is_empty_coord(row.get('lon'))) else None),
        }
        
        ports_data[port_key]["bikes"].append(bike_info)
        ports_data[port_key]["total_bikes"] += 1

        if row['is_alert']:
            ports_data[port_key]["alert_bikes_count"] += 1
            if row['alert_level'] > ports_data[port_key]["max_alert_level"]:
                ports_data[port_key]["max_alert_level"] = int(row['alert_level'])

    # 管理ポータルのスナップショットから、車両が0台のポートも追加する。
    # GBFSの名称・座標・ジオフェンスは表示用台帳に使用しない。
    portal_merged_count = 0
    for s_name, item in portal_ports.items():
        if s_name in ports_data:
            continue
        display_name = str(item.get("port_name") or s_name).strip()
        area = normalize_area_name(item.get("area_name"))
        if not area or area == "その他":
            continue
        try:
            s_lat = float(item.get("lat"))
            s_lon = float(item.get("lon"))
        except (TypeError, ValueError):
            continue
        if not math.isfinite(s_lat) or not math.isfinite(s_lon) or s_lat == 0.0 or s_lon == 0.0:
            continue

        ports_data[s_name] = {
            "port_name": display_name,
            "area_name": area,
            "station_id": str(item.get("station_id") or "").strip(),
            "lat": s_lat,
            "lon": s_lon,
            "has_gps": True,
            "service_state": item.get("service_state"),
            "publish_flag": item.get("publish_flag"),
            "port_name_en": item.get("port_name_en") or "",
            "capacity": item.get("rack_count", 0),
            "total_bikes": 0,
            "max_alert_level": 0,
            "alert_bikes_count": 0,
            "bikes": []
        }
        portal_merged_count += 1
    print(f"Success: 管理ポータルから駐輪台数0台のポートを {portal_merged_count} 件マージしました")
        
    return ports_data

def export_dashboard_files(ports_data):
    """dashboard_data.json および dashboard_data.js を書き出します"""
    output_ports = []
    total_alerts = 0
    
    summary_counts = {
        "at_error": 0,
        "strong": 0,
        "lv1": 0,
        "lv2": 0,
        "lv3": 0
    }
    
    for port_name, p_info in ports_data.items():
        p_info["bikes"].sort(key=lambda b: str(b.get("bike_id", "")))
        for bike in p_info["bikes"]:
            lvl = bike["alert_level"]
            if lvl == 5:
                summary_counts["at_error"] += 1
            elif lvl == 4:
                summary_counts["strong"] += 1
            elif lvl == 3:
                summary_counts["lv1"] += 1
            elif lvl == 2:
                summary_counts["lv2"] += 1
            elif lvl == 1:
                summary_counts["lv3"] += 1
                
        total_alerts += p_info["alert_bikes_count"]
        output_ports.append(p_info)

    jst = timezone(timedelta(hours=9))
    updated_at_str = datetime.now(jst).strftime("%Y-%m-%d %H:%M:%S")

    dashboard_payload = {
        "updated_at": updated_at_str,
        "total_ports_count": len(output_ports),
        "total_alert_bikes": total_alerts,
        "summary_counts": summary_counts,
        "ports": output_ports
    }

    json_filename = "dashboard_data.json"
    json_path = os.path.join(str(ROOT_DIR), json_filename)
    
    try:
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(dashboard_payload, f, ensure_ascii=False, indent=2)
        print(f"Success: ダッシュボード用JSONを生成しました (警告車両総数: {total_alerts}台): {json_path}")
    except Exception as e:
        print(f"Error: JSON出力に失敗しました: {e}")
        json_path = None

    js_filename = "dashboard_data.js"
    js_path = os.path.join(str(ROOT_DIR), js_filename)
    
    try:
        with open(js_path, "w", encoding="utf-8") as f:
            f.write("window.dashboardData = ")
            json.dump(dashboard_payload, f, ensure_ascii=False, indent=2)
            f.write(";")
        print(f"Success: セキュリティ制限回避用JSを生成しました: {js_path}")
    except Exception as e:
        print(f"Error: JS出力に失敗しました: {e}")
        js_path = None

    return json_path, js_path

def generate_dashboard_json(latest_vehicle_path: str = None) -> str:
    """
    最新の車両情報CSVと手動メンテ用『車両閾値設定.csv』を安全にマージし、
    警告対象の車両情報をポート単位で集計した軽量な dashboard_data.json を生成します。
    """
    print("--- 可視化ダッシュボード用JSONデータの生成を開始します ---")
    
    # 1. データのロード
    df_vehicle, df_threshold = load_input_data(latest_vehicle_path)
    if df_vehicle is None or df_threshold is None:
        return None, None
        
    # 2. 車両閾値適用・警告判定
    df_merged = apply_vehicle_thresholds(df_vehicle, df_threshold)
    if df_merged is None:
        return None, None
        
    # 3. ポート・エリアマスタ同期
    master_data, portal_ports = sync_port_area_master(df_merged)
    
    # 4. ポートごとの集計処理
    ports_data = aggregate_ports_data(df_merged, master_data, portal_ports)
    
    # 4.5 利用者向け公開ポートデータの生成
    try:
        generate_public_ports_data(ports_data)
    except Exception as e:
        print(f"Warning: 利用者向け公開ポートデータの生成に失敗しました: {e}")

    # 5. ファイル出力
    return export_dashboard_files(ports_data)
