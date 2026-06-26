import os
import json
import csv
import urllib.request
from datetime import datetime, timezone, timedelta
from src.config import Config
from src.exporter import upload_to_onedrive_web

R2_SELF_REPLACED_URL = "https://pub-1c068f2df9ab42a0b9dcc5d112078269.r2.dev/self_replaced_bikes.json"
DEFAULT_HISTORY_CSV = os.path.join(Config.OUTPUT_DIR, "self_replaced_history.csv")

def sync_self_replacement_history_to_onedrive(r2_url=R2_SELF_REPLACED_URL, history_csv_path=DEFAULT_HISTORY_CSV, skip_upload=False):
    """
    R2上の自己申告バッテリー交換データ（self_replaced_bikes.json）をフェッチし、
    重複なくローカルの履歴 CSV (self_replaced_history.csv) に蓄積して OneDrive へアップロードします。
    """
    print("⏳ 自己申告データの同期（履歴蓄積）を開始します...")
    
    # 1. R2 から自己申告データをフェッチ
    try:
        if r2_url.startswith("file://"):
            from urllib.parse import urlparse
            from urllib.request import url2pathname
            local_path = url2pathname(urlparse(r2_url).path)
            # Windowsのドライブレター等によるスラッシュの補正
            if local_path.startswith('/') and len(local_path) > 2 and local_path[2] == ':':
                local_path = local_path[1:]
            with open(local_path, 'r', encoding='utf-8') as f:
                r2_data = json.load(f)
        else:
            req = urllib.request.Request(
                r2_url, 
                headers={'User-Agent': 'Mozilla/5.0'}
            )
            with urllib.request.urlopen(req, timeout=10) as response:
                if response.status != 200:
                    print(f"Warning: R2からの自己申告データの取得に失敗しました (Status: {response.status})")
                    return False
                data_str = response.read().decode('utf-8')
                r2_data = json.loads(data_str)
    except Exception as e:
        print(f"Warning: R2から自己申告データをフェッチできませんでした (初めてデプロイされた場合などは正常です): {e}")
        return False

    if not r2_data:
        print("Info: R2上の自己申告データは空です。同期をスキップします。")
        return False

    # 2. 履歴 CSV の読み込みと存在チェック
    existing_records = set()
    file_exists = os.path.exists(history_csv_path)
    
    if file_exists:
        try:
            with open(history_csv_path, 'r', encoding='utf-8-sig', newline='') as f:
                reader = csv.DictReader(f)
                for row in reader:
                    # 重複チェック用に (bike_id, timestamp) をタプルとしてセットに追加
                    bike_id = row.get('bike_id')
                    ts = row.get('timestamp')
                    if bike_id and ts:
                        try:
                            existing_records.add((bike_id, int(ts)))
                        except ValueError:
                            # タイムスタンプが不正な行はスキップして上書きや重複チェック外とする
                            pass
        except Exception as e:
            print(f"Warning: 既存の履歴 CSV の読み込み中にエラーが発生しました: {e}")

    # 3. 新規エントリの抽出
    new_rows = []
    # R2 データのフォーマット: { "bike_id": { "timestamp": int_ms, "alert_level": int, "voltage": float } }
    for bike_id, details in r2_data.items():
        ts = details.get('timestamp')
        if not ts:
            continue
        try:
            ts_int = int(ts)
        except ValueError:
            continue
        
        if (bike_id, ts_int) not in existing_records:
            # 人間が読める日本時間 (JST) の日時文字列を作成
            dt = datetime.fromtimestamp(ts_int / 1000, tz=timezone(timedelta(hours=9)))
            recorded_at = dt.strftime('%Y-%m-%d %H:%M:%S')
            
            new_rows.append({
                'bike_id': bike_id,
                'timestamp': ts_int,
                'recorded_at': recorded_at,
                'alert_level': details.get('alert_level', 0),
                'voltage': details.get('voltage')
            })

    if not new_rows:
        print("✅ 新規の自己申告データはありません。履歴は最新です。")
        return False

    # 4. 新規エントリを CSV に追記
    print(f"📝 新たに {len(new_rows)} 件の自己申告データを検出しました。履歴に追記します。")
    os.makedirs(os.path.dirname(history_csv_path), exist_ok=True)
    
    headers = ['bike_id', 'timestamp', 'recorded_at', 'alert_level', 'voltage']
    
    try:
        # utf-8-sig は Excel で開いたときに文字化けしにくくするため推奨
        with open(history_csv_path, 'a' if file_exists else 'w', encoding='utf-8-sig', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=headers)
            if not file_exists:
                writer.writeheader()
            for row in new_rows:
                writer.writerow(row)
        print(f"💾 ローカル履歴ファイルを更新しました: {history_csv_path}")
    except Exception as e:
        print(f"❌ 履歴 CSV への書き込みに失敗しました: {e}")
        return False

    # 5. OneDrive へのアップロード
    if not skip_upload:
        try:
            print(f"📁 更新された履歴ファイルを OneDrive にアップロードします...")
            success = upload_to_onedrive_web(history_csv_path)
            if success:
                print("✅ OneDrive へのアップロードが完了しました。")
                return True
            else:
                print("Warning: OneDrive へのアップロードに失敗しました。")
                return False
        except Exception as e:
            print(f"❌ OneDrive アップロード中に例外が発生しました: {e}")
            return False
    else:
        print("Info: アップロード処理をスキップしました (skip_upload=True)")
        return True
