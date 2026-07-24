# -*- coding: utf-8 -*-
import os
import glob
import json
import pandas as pd
from datetime import datetime, timezone, timedelta
from src.config import Config, ROOT_DIR
from src.public_data_generator import generate_public_ports_data


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
        vehicle_files = sorted(glob.glob(os.path.join(Config.OUTPUT_DIR, "車両情報_*.csv")))
        if not vehicle_files:
            print("Error: 車両情報CSVが見つかりません。")
            return None, None
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
        is_trg_area = "TRG" in str(row.get('エリア名', '')) or "Tokyo Ring" in str(row.get('エリア名', '')) or str(row.get('識別番号', '')).startswith("TRG")
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
        is_trg = "TRG" in str(row.get('エリア名', '')) or "Tokyo Ring" in str(row.get('エリア名', ''))
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
    """ポート・エリアマスタ (port_area_master.json) のロードと自動学習、クレンジングを行います"""
    master_path = os.path.join(str(ROOT_DIR), "port_area_master.json")
    master_data = {"ports": {}, "stations": {}}
    
    if os.path.exists(master_path):
        try:
            with open(master_path, "r", encoding="utf-8") as f:
                master_data = json.load(f)
            if "ports" not in master_data: master_data["ports"] = {}
            if "stations" not in master_data: master_data["stations"] = {}
        except Exception as e:
            print(f"Warning: マスタファイルのロードに失敗しました (再構築します): {e}")

    # 今回の車両情報からポート名・station_idとエリアの対応関係を自動学習
    for idx, row in df_merged.iterrows():
        p_name = str(row['ポート名']).strip()
        a_name = str(row['エリア名']).strip() if not pd.isna(row['エリア名']) else "その他"
        s_id = row['station_id']
        
        if p_name and a_name and a_name != "その他":
            master_data["ports"][p_name] = a_name
        if not pd.isna(s_id) and a_name and a_name != "その他":
            try:
                s_id_str = f"{int(s_id):08d}"
                master_data["stations"][s_id_str] = a_name
            except (ValueError, TypeError):
                pass

    # 最新のGBFS JSONデータを探索して読み込み
    gbfs_files = sorted(glob.glob(os.path.join(Config.OUTPUT_DIR, "gbfs_stations_*.json")))
    latest_gbfs_path = gbfs_files[-1] if gbfs_files else None
    
    gbfs_stations = []
    gbfs_active_names = set()
    gbfs_active_ids = set()
    
    if latest_gbfs_path:
        try:
            with open(latest_gbfs_path, "r", encoding="utf-8") as f:
                gbfs_stations = json.load(f)
            for s in gbfs_stations:
                s_id_raw = s.get("station_id", "").strip()
                if not s_id_raw:
                    continue
                try:
                    s_id = f"{int(s_id_raw):08d}"
                except ValueError:
                    s_id = s_id_raw
                s_name = s.get("name", "").strip()
                if s_name:
                    gbfs_active_names.add(s_name)
                if s_id and s_id != "00000000":
                    gbfs_active_ids.add(s_id)
            print(f"Success: 最新のGBFSデータをロードしました (ステーション数: {len(gbfs_stations)})")
        except Exception as e:
            print(f"Warning: GBFSデータのロードに失敗しました: {e}")

    # 撤去・改名ポートの自動消し込み (クレンジング)
    if gbfs_stations:
        stale_ports = [p for p in master_data["ports"].keys() if p not in gbfs_active_names]
        stale_stations = [s for s in master_data["stations"].keys() if s not in gbfs_active_ids]
        
        gps_active_ports = set()
        for idx, row in df_merged.iterrows():
            lat = row['lat']
            lon = row['lon']
            has_gps = not (pd.isna(lat) or pd.isna(lon) or lat == 0.0 or lon == 0.0)
            if not has_gps:
                p_name = str(row['ポート名']).strip()
                gps_active_ports.add(p_name)
        
        deleted_ports_count = 0
        deleted_stations_count = 0
        
        for p in stale_ports:
            if p not in gps_active_ports:
                del master_data["ports"][p]
                deleted_ports_count += 1
        for s in stale_stations:
            del master_data["stations"][s]
            deleted_stations_count += 1
            
        if deleted_ports_count or deleted_stations_count:
            print(f"Info: 不要な古いポート情報をマスタから自動消し込みしました (ポート名: {deleted_ports_count}件, ID: {deleted_stations_count}件)")

    # ジオフェンシングによるエリア判定
    def get_area_by_coords(lat, lon):
        if 36.48 <= lat <= 36.65 and 136.50 <= lon <= 136.75:
            return "KNZ_金沢市公共シェアサイクルまちのり事務局"
        elif 36.0 <= lat <= 36.15 and 136.15 <= lon <= 136.25:
            return "FKI_ふくチャリ"
        elif 36.3 <= lat <= 36.45 and 136.4 <= lon <= 136.5:
            return "KMT_こまつシェアサイクル"
        return None

    # GBFSポートをもとに、マスタへのジオフェンス初回学習
    for s in gbfs_stations:
        s_id_raw = s.get("station_id", "").strip()
        if not s_id_raw:
            continue
        try:
            s_id_str = f"{int(s_id_raw):08d}"
        except ValueError:
            s_id_str = s_id_raw
            
        s_name = s.get("name", "").strip()
        s_lat = float(s.get("lat", 0.0))
        s_lon = float(s.get("lon", 0.0))
        
        if s_name not in master_data["ports"] or s_id_str not in master_data["stations"]:
            area = get_area_by_coords(s_lat, s_lon)
            if area:
                if s_name: master_data["ports"][s_name] = area
                if s_id_str and s_id_str != "00000000": master_data["stations"][s_id_str] = area

    # マスタファイルの保存
    try:
        with open(master_path, "w", encoding="utf-8") as f:
            json.dump(master_data, f, ensure_ascii=False, indent=2)
        print(f"Success: 学習型マスタファイルを更新しました: {master_path}")
    except Exception as e:
        print(f"Error: マスタファイルの書き込みに失敗しました: {e}")
        
    return master_data, gbfs_stations

def aggregate_ports_data(df_merged, master_data, gbfs_stations):
    """ポート単位の集計処理および空ポートのマージを行います"""
    ports_data = {}
    
    for idx, row in df_merged.iterrows():
        port_name = str(row['ポート名']).strip()
        lat = row['lat']
        lon = row['lon']
        has_gps = not (pd.isna(lat) or pd.isna(lon) or lat == 0.0 or lon == 0.0)
        
        bike_id = str(row['識別番号'])
        status = str(row['車両status']) if '車両status' in df_merged.columns else str(row['車両状態'])
        voltage = row['電圧']
        at_time = str(row['AT通知受信日時']) if not pd.isna(row['AT通知受信日時']) else ""
        
        s_id = row.get('station_id')
        s_id_str = ""
        if not pd.isna(s_id):
            try:
                s_id_str = f"{int(s_id):08d}"
            except (ValueError, TypeError):
                s_id_str = str(s_id).strip()

        if port_name not in ports_data:
            ports_data[port_name] = {
                "port_name": port_name,
                "area_name": str(row['エリア名']).strip() if not pd.isna(row['エリア名']) else "その他",
                "station_id": s_id_str,
                "lat": float(lat) if has_gps else None,
                "lon": float(lon) if has_gps else None,
                "has_gps": has_gps,
                "total_bikes": 0,
                "max_alert_level": 0,
                "alert_bikes_count": 0,
                "bikes": []
            }
        else:
            if not ports_data[port_name].get("station_id") and s_id_str:
                ports_data[port_name]["station_id"] = s_id_str
            
        unlocked_started_at = str(row.get('連続利用開始日時', '')).strip() if '連続利用開始日時' in df_merged.columns and not pd.isna(row.get('連続利用開始日時')) else ""
        try:
            consecutive_use_duration = int(row.get('同一ポート継続利用時間(秒)', 0)) if '同一ポート継続利用時間(秒)' in df_merged.columns and not pd.isna(row.get('同一ポート継続利用時間(秒)')) and str(row.get('同一ポート継続利用時間(秒)')).strip() != "" else 0
        except Exception:
            consecutive_use_duration = 0

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
            "unlocked_started_at": unlocked_started_at,
            "consecutive_use_duration": consecutive_use_duration,
            "replace_original_volt": replace_orig_val,
            "replace_increased_volt": replace_incr_val,
            "replaced_at": replaced_at,
            "area_name": str(row['エリア名']).strip() if not pd.isna(row['エリア名']) else "その他",
            "lat": float(lat) if has_gps else None,
            "lon": float(lon) if has_gps else None
        }
        
        ports_data[port_name]["bikes"].append(bike_info)
        ports_data[port_name]["total_bikes"] += 1
        
        if row['is_alert']:
            ports_data[port_name]["alert_bikes_count"] += 1
            if row['alert_level'] > ports_data[port_name]["max_alert_level"]:
                ports_data[port_name]["max_alert_level"] = int(row['alert_level'])

    # GBFSデータの0台ポートをマージ
    gbfs_merged_count = 0
    if gbfs_stations:
        for s in gbfs_stations:
            s_id_raw = s.get("station_id", "").strip()
            if not s_id_raw:
                continue
            try:
                s_id = f"{int(s_id_raw):08d}"
            except ValueError:
                s_id = s_id_raw
                
            s_name = s.get("name", "").strip()
            s_lat = float(s.get("lat", 0.0))
            s_lon = float(s.get("lon", 0.0))
            
            if s_name in ports_data:
                continue
                
            area = master_data["stations"].get(s_id) or master_data["ports"].get(s_name)
            if not area:
                continue
            
            # 地理的ジオフェンスガード
            is_valid_coords = False
            if "KNZ" in area:
                is_valid_coords = (36.48 <= s_lat <= 36.65 and 136.50 <= s_lon <= 136.75)
            elif "FKI" in area:
                is_valid_coords = (36.0 <= s_lat <= 36.15 and 136.15 <= s_lon <= 136.25)
            elif "KMT" in area:
                is_valid_coords = (36.3 <= s_lat <= 36.45 and 136.4 <= s_lon <= 136.5)
            elif "TRG" in area:
                is_valid_coords = (35.5 <= s_lat <= 35.7 and 136.0 <= s_lon <= 136.15)
                
            if not is_valid_coords:
                continue
            
            ports_data[s_name] = {
                "port_name": s_name,
                "area_name": area,
                "station_id": s_id,
                "lat": s_lat,
                "lon": s_lon,
                "has_gps": True,
                "total_bikes": 0,
                "max_alert_level": 0,
                "alert_bikes_count": 0,
                "bikes": []
            }
            gbfs_merged_count += 1
        print(f"Success: GBFSから駐輪台数0台のポートを {gbfs_merged_count} 件マージしました")
        
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
    master_data, gbfs_stations = sync_port_area_master(df_merged)
    
    # 4. ポートごとの集計処理
    ports_data = aggregate_ports_data(df_merged, master_data, gbfs_stations)
    
    # 4.5 利用者向け公開ポートデータの生成
    try:
        generate_public_ports_data(ports_data, gbfs_stations)
    except Exception as e:
        print(f"Warning: 利用者向け公開ポートデータの生成に失敗しました: {e}")

    # 5. ファイル出力
    return export_dashboard_files(ports_data)

