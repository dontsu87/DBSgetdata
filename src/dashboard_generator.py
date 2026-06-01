# -*- coding: utf-8 -*-
import os
import glob
import json
import pandas as pd
from datetime import datetime
from src.config import Config

def generate_dashboard_json(latest_vehicle_path: str = None) -> str:
    """
    最新の車両情報CSVと手動メンテ用『車両閾値設定.csv』を安全にマージし、
    警告対象の車両情報をポート単位で集計した軽量な dashboard_data.json を生成します。
    引数:
        latest_vehicle_path (str): 処理対象の車両情報CSVの絶対パス。省略時は最新を自動検索。
    戻り値:
        str: 生成された dashboard_data.json の絶対パス。失敗時は None。
    """
    print("--- 可視化ダッシュボード用JSONデータの生成を開始します ---")
    
    # 1. パスの決定
    if not latest_vehicle_path:
        vehicle_files = sorted(glob.glob(os.path.join(Config.OUTPUT_DIR, "車両情報_*.csv")))
        if not vehicle_files:
            print("Error: 車両情報CSVが見つかりません。")
            return None
        latest_vehicle_path = vehicle_files[-1]
    
    from src.config import ROOT_DIR
    threshold_path = os.path.join(str(ROOT_DIR), "車両閾値設定.csv")
    if not os.path.exists(threshold_path):
        print(f"Error: 閾値設定ファイル（{threshold_path}）が見つかりません。")
        return None, None

    # 2. データのロード
    try:
        df_vehicle = pd.read_csv(latest_vehicle_path)
        df_threshold = pd.read_csv(threshold_path)
    except Exception as e:
        print(f"Error: データのロードに失敗しました: {e}")
        return None, None

    # 3. データの結合とクレンジング
    try:
        # キーの前後の空白を除去して安全にマージ
        df_vehicle['join_key'] = df_vehicle['識別番号'].astype(str).str.strip()
        df_threshold['join_key'] = df_threshold['車両識別番号'].astype(str).str.strip()
        
        # 古い形式のCSV（警告閾値カラムのみ）が読み込まれた場合の自動互換性補正
        if '警告閾値' in df_threshold.columns and '閾値_Lv1' not in df_threshold.columns:
            print("Warning: OneDrive上の車両閾値設定.csvが古い形式です。自動的に新形式に変換して処理を継続します。")
            df_threshold['車種名'] = "その他"
            # 古い「警告閾値」を「閾値_画面強調」として扱い、他を自動算出
            v_strong = pd.to_numeric(df_threshold['警告閾値'], errors='coerce')
            df_threshold['閾値_画面強調'] = v_strong
            df_threshold['閾値_AT異常'] = v_strong - 4.0
            df_threshold['閾値_Lv1'] = v_strong + 0.5
            df_threshold['閾値_Lv2'] = v_strong + 1.2
            df_threshold['閾値_Lv3'] = v_strong + 2.0

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
        
        # --- 金沢(KNZ)のDDおよびPasCityCマスタ値強制保護機能 ---
        # OneDrive等のCSV上に誤った大きな値が入っている場合でも、添付画像の仕様通りに強制補正します
        for idx, row in df_merged.iterrows():
            model = str(row['車種名']).strip()
            # DDの補正
            if model == "DD":
                df_merged.at[idx, '閾値_AT異常'] = 18.0
                df_merged.at[idx, '閾値_画面強調'] = 24.5
                df_merged.at[idx, '閾値_Lv1'] = 35.1
                df_merged.at[idx, '閾値_Lv2'] = 35.8
                df_merged.at[idx, '閾値_Lv3'] = 37.5
            # PasCityCの補正
            elif model == "PasCityC":
                df_merged.at[idx, '閾値_AT異常'] = 24.0
                df_merged.at[idx, '閾値_画面強調'] = 24.0
                df_merged.at[idx, '閾値_Lv1'] = 24.6
                df_merged.at[idx, '閾値_Lv2'] = 25.3
                df_merged.at[idx, '閾値_Lv3'] = 26.4

        # 数値変換
        df_merged['電圧'] = pd.to_numeric(df_merged['電圧'], errors='coerce')
        for col in ['閾値_AT異常', '閾値_画面強調', '閾値_Lv1', '閾値_Lv2', '閾値_Lv3', 'lat', 'lon']:
            df_merged[col] = pd.to_numeric(df_merged[col], errors='coerce')
        
        # --- 多段階判定ロジック ---
        # 電圧値に基づき、最も深刻度が高い警告レベル（1=Lv3〜5=AT異常、0=正常）を動的に決定します
        def determine_alert_level(row):
            volt = row['電圧']
            if pd.isna(volt):
                return 0, "正常"
            
            # 深刻度順（高い順）に判定
            if volt <= row['閾値_AT異常']:
                return 5, "AT異常"
            elif volt <= row['閾値_画面強調']:
                return 4, "電圧閾値"
            elif volt <= row['閾値_Lv1']:
                return 3, "Lv.1"
            elif volt <= row['閾値_Lv2']:
                return 2, "Lv.2"
            elif volt <= row['閾値_Lv3']:
                return 1, "Lv.3"
            else:
                return 0, "正常"

        # 判定の適用
        df_merged['alert_data'] = df_merged.apply(determine_alert_level, axis=1)
        df_merged['alert_level'] = df_merged['alert_data'].apply(lambda x: x[0])
        df_merged['alert_level_name'] = df_merged['alert_data'].apply(lambda x: x[1])
        df_merged['is_alert'] = df_merged['alert_level'] > 0
        
    except Exception as e:
        print(f"Error: 結合・フィルタリング処理中にエラーが発生しました: {e}")
        return None, None

    # 4. ポートごとの集計処理
    ports_data = {}
    
    for idx, row in df_merged.iterrows():
        port_name = str(row['ポート名']).strip()
        
        # 位置情報がない特殊ポート（ポート外や倉庫など）は緯度経度がNaNになります
        lat = row['lat']
        lon = row['lon']
        
        has_gps = not (pd.isna(lat) or pd.isna(lon) or lat == 0.0 or lon == 0.0)
        
        bike_id = str(row['識別番号'])
        status = str(row['車両状態'])
        voltage = row['電圧']
        at_time = str(row['AT通知受信日時']) if not pd.isna(row['AT通知受信日時']) else ""
        
        if port_name not in ports_data:
            ports_data[port_name] = {
                "port_name": port_name,
                "area_name": str(row['エリア名']).strip() if not pd.isna(row['エリア名']) else "その他",
                "lat": float(lat) if has_gps else None,
                "lon": float(lon) if has_gps else None,
                "has_gps": has_gps,
                "total_bikes": 0,
                "max_alert_level": 0,  # ポート内にある最も深刻度の高いアラートレベル
                "alert_bikes_count": 0, # アラート対象車両の総数
                "bikes": []
            }
            
        bike_info = {
            "bike_id": bike_id,
            "status": status,
            "model_name": str(row['車種名']),
            "voltage": float(voltage) if not pd.isna(voltage) else None,
            "alert_level": int(row['alert_level']),
            "alert_level_name": str(row['alert_level_name']),
            "thresholds": {
                "at_error": float(row['閾値_AT異常']),
                "strong": float(row['閾値_画面強調']),
                "lv1": float(row['閾値_Lv1']),
                "lv2": float(row['閾値_Lv2']),
                "lv3": float(row['閾値_Lv3'])
            },
            "at_time": at_time
        }
        
        ports_data[port_name]["bikes"].append(bike_info)
        ports_data[port_name]["total_bikes"] += 1
        
        if row['is_alert']:
            ports_data[port_name]["alert_bikes_count"] += 1
            # 最も高い深刻度レベルを追従
            if row['alert_level'] > ports_data[port_name]["max_alert_level"]:
                ports_data[port_name]["max_alert_level"] = int(row['alert_level'])

    # 5. 可視化に必要なデータ（警告車両のみに絞り込み、軽量化）
    output_ports = []
    total_alerts = 0
    
    # 深刻度ごとの総集計カウンタ
    summary_counts = {
        "at_error": 0,
        "strong": 0,
        "lv1": 0,
        "lv2": 0,
        "lv3": 0
    }
    
    for port_name, p_info in ports_data.items():
        # 絞り込みを行わず、正常電圧（レベル0）の自転車情報も含めて全て保持
        # 全体カウンタの集計（警告対象レベル1〜5のみカウント）
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

    # 全体のサマリー情報を作成 (日本時間 JST タイムゾーンを明示的に取得)
    from datetime import timezone, timedelta
    jst = timezone(timedelta(hours=9))
    updated_at_str = datetime.now(jst).strftime("%Y-%m-%d %H:%M:%S")

    dashboard_payload = {
        "updated_at": updated_at_str,
        "total_ports_count": len(output_ports),
        "total_alert_bikes": total_alerts,
        "summary_counts": summary_counts,
        "ports": output_ports
    }

    # 6. JSONファイルの書き出し
    json_filename = "dashboard_data.json"
    json_path = os.path.join(str(ROOT_DIR), json_filename)
    
    try:
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(dashboard_payload, f, ensure_ascii=False, indent=2)
        print(f"Success: ダッシュボード用JSONを生成しました (警告車両総数: {total_alerts}台): {json_path}")
    except Exception as e:
        print(f"Error: JSON出力に失敗しました: {e}")
        json_path = None

    # 7. CORSセキュリティ制限回避用の JS ファイルの書き出し (ダブルクリック受入用)
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
