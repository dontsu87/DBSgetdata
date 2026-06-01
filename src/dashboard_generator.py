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
    
    threshold_path = os.path.join(Config.OUTPUT_DIR, "車両閾値設定.csv")
    if not os.path.exists(threshold_path):
        print(f"Warning: 閾値設定ファイル（{threshold_path}）が見つかりません。新規作成します...")
        # 閾値設定ファイルがない場合は、デフォルトで25.0Vを閾値とするダミーを自動生成（または何もしない）
        try:
            df_v = pd.read_csv(latest_vehicle_path)
            bikes = df_v['識別番号'].dropna().unique()
            df_t = pd.DataFrame({
                "車両識別番号": sorted(bikes),
                "警告閾値": 25.0  # 初期デフォルト閾値
            })
            df_t.to_csv(threshold_path, index=False, encoding="utf-8-sig")
            print(f"Success: 初期閾値設定ファイルを自動生成しました: {threshold_path}")
        except Exception as e:
            print(f"Error: 初期閾値設定ファイルの生成に失敗しました: {e}")
            return None

    # 2. データのロード
    try:
        df_vehicle = pd.read_csv(latest_vehicle_path)
        df_threshold = pd.read_csv(threshold_path)
    except Exception as e:
        print(f"Error: データのロードに失敗しました: {e}")
        return None

    # 3. データの結合とクレンジング
    try:
        # キーの前後の空白を除去して安全にマージ
        df_vehicle['join_key'] = df_vehicle['識別番号'].astype(str).str.strip()
        df_threshold['join_key'] = df_threshold['車両識別番号'].astype(str).str.strip()
        
        # 必要な列だけ抽出してマージ (警告閾値カラムを追加)
        df_t_subset = df_threshold[['join_key', '警告閾値']].drop_duplicates(subset=['join_key'])
        df_merged = pd.merge(df_vehicle, df_t_subset, on='join_key', how='left')
        
        # 閾値が設定されていない車両はデフォルト 25.0V とする
        df_merged['警告閾値'] = df_merged['警告閾値'].fillna(25.0)
        
        # 数値変換とクレンジング
        df_merged['電圧'] = pd.to_numeric(df_merged['電圧'], errors='coerce')
        df_merged['警告閾値'] = pd.to_numeric(df_merged['警告閾値'], errors='coerce')
        df_merged['lat'] = pd.to_numeric(df_merged['lat'], errors='coerce')
        df_merged['lon'] = pd.to_numeric(df_merged['lon'], errors='coerce')
        
        # 電圧が閾値以下の車両を「警告対象 (is_alert=True)」とする
        df_merged['is_alert'] = df_merged['電圧'] <= df_merged['警告閾値']
    except Exception as e:
        print(f"Error: 結合・フィルタリング処理中にエラーが発生しました: {e}")
        return None

    # 4. ポートごとの集計処理
    # マップで表示しやすいよう、ポート単位で「緯度・経度・警告対象の車両一覧」を構造化します
    ports_data = {}
    
    for idx, row in df_merged.iterrows():
        port_name = str(row['ポート名']).strip()
        
        # 位置情報がない特殊ポート（ポート外や倉庫など）は緯度経度がNaNになります
        lat = row['lat']
        lon = row['lon']
        
        # 緯度経度が存在しない場合でも、集計は行う（地図には乗らないが、リストには出せるようにする）
        has_gps = not (pd.isna(lat) or pd.isna(lon) or lat == 0.0 or lon == 0.0)
        
        bike_id = str(row['識別番号'])
        status = str(row['車両状態'])
        voltage = row['電圧']
        threshold = row['警告閾値']
        is_alert = bool(row['is_alert'])
        at_time = str(row['AT通知受信日時']) if not pd.isna(row['AT通知受信日時']) else ""
        
        if port_name not in ports_data:
            ports_data[port_name] = {
                "port_name": port_name,
                "lat": float(lat) if has_gps else None,
                "lon": float(lon) if has_gps else None,
                "has_gps": has_gps,
                "total_bikes": 0,
                "alert_bikes_count": 0,
                "bikes": []
            }
            
        bike_info = {
            "bike_id": bike_id,
            "status": status,
            "voltage": float(voltage) if not pd.isna(voltage) else None,
            "threshold": float(threshold) if not pd.isna(threshold) else 25.0,
            "is_alert": is_alert,
            "at_time": at_time
        }
        
        ports_data[port_name]["bikes"].append(bike_info)
        ports_data[port_name]["total_bikes"] += 1
        if is_alert:
            ports_data[port_name]["alert_bikes_count"] += 1

    # 5. 可視化に必要なデータ（警告車両が1台以上あるポート、または全ポート）をまとめる
    # データ軽量化のため、警告がないポートも最小限の情報にしてリスト化
    output_ports = []
    total_alerts = 0
    
    for port_name, p_info in ports_data.items():
        # 警告車両のみに絞り込んだ車両リストを作成（容量削減）
        alert_bikes = [b for b in p_info["bikes"] if b["is_alert"]]
        p_info["bikes"] = alert_bikes
        
        total_alerts += p_info["alert_bikes_count"]
        output_ports.append(p_info)

    # 全体のサマリー情報を作成
    dashboard_payload = {
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "total_ports_count": len(output_ports),
        "total_alert_bikes": total_alerts,
        "ports": output_ports
    }

    # 6. JSONファイルの書き出し
    json_filename = "dashboard_data.json"
    json_path = os.path.join(Config.OUTPUT_DIR, json_filename)
    
    try:
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(dashboard_payload, f, ensure_ascii=False, indent=2)
        print(f"Success: ダッシュボード用JSONを生成しました (警告車両総数: {total_alerts}台): {json_path}")
    except Exception as e:
        print(f"Error: JSON出力に失敗しました: {e}")
        json_path = None

    # 7. CORSセキュリティ制限回避用の JS ファイルの書き出し (ダブルクリック受入用)
    js_filename = "dashboard_data.js"
    js_path = os.path.join(Config.OUTPUT_DIR, js_filename)
    
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
