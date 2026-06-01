# -*- coding: utf-8 -*-
import os
import json
import urllib.request
import urllib.error
import pandas as pd
from datetime import datetime
from src.config import Config

API_URL = "https://api-public.odpt.org/api/v4/gbfs/docomo-cycle/station_information.json"

def retrieve_gbfs_stations():
    """
    GBFSのステーション情報APIからデータを取得し、JSON及びCSV形式でローカルに保存します。
    戻り値:
        tuple (str, str): 保存されたJSONファイルパス, CSVファイルパスのタプル。失敗時は (None, None)。
    """
    print("--- GBFS API からポート情報の取得を開始します ---")
    print(f"URL: {API_URL}")

    # 保存先ディレクトリの確保
    os.makedirs(Config.OUTPUT_DIR, exist_ok=True)

    # 1. APIからデータ取得
    req = urllib.request.Request(
        API_URL, 
        headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
    )
    
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            status = response.getcode()
            if status != 200:
                print(f"Error: APIの取得に失敗しました。ステータスコード: {status}")
                return None, None
            
            raw_data = response.read().decode('utf-8')
            data = json.loads(raw_data)
    except urllib.error.URLError as e:
        print(f"Error: ネットワークエラーまたはAPIの接続に失敗しました: {e}")
        return None, None
    except json.JSONDecodeError as e:
        print(f"Error: 取得したデータのJSONデコードに失敗しました: {e}")
        return None, None
    except Exception as e:
        print(f"Error: 予期しないエラーが発生しました: {e}")
        return None, None

    # 2. データの解析と整形
    stations = data.get("data", {}).get("stations", [])
    if not stations:
        print("Warning: 取得したデータ内に stations が見つからないか、空です。")
        return None, None

    print(f"Success: 合計 {len(stations)} 個のポート情報を取得しました。データをパース中...")

    # 保存用のリストを作成
    parsed_stations = []
    for s in stations:
        parsed_stations.append({
            "station_id": s.get("station_id", ""),
            "name": s.get("name", ""),
            "lat": s.get("lat", 0.0),
            "lon": s.get("lon", 0.0),
            "capacity": s.get("capacity", 0)
        })

    # 3. ローカルにJSONとして保存
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    json_filename = f"gbfs_stations_{timestamp}.json"
    json_path = os.path.join(Config.OUTPUT_DIR, json_filename)
    
    try:
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(parsed_stations, f, ensure_ascii=False, indent=2)
        print(f"Success: JSONファイルを保存しました: {json_path}")
    except Exception as e:
        print(f"Error: JSONファイルの保存に失敗しました: {e}")
        json_path = None

    # 4. ローカルにCSVとして保存
    csv_filename = f"gbfs_stations_{timestamp}.csv"
    csv_path = os.path.join(Config.OUTPUT_DIR, csv_filename)
    
    try:
        df = pd.DataFrame(parsed_stations)
        # BOM付きUTF-8でExcel文字化けを防ぐ
        df.to_csv(csv_path, index=False, encoding="utf-8-sig")
        print(f"Success: CSVファイルを保存しました: {csv_path}")
    except Exception as e:
        print(f"Error: CSVファイルの保存に失敗しました: {e}")
        csv_path = None

    return json_path, csv_path
