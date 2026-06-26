# -*- coding: utf-8 -*-
import os
import json
import threading
from datetime import datetime, timezone, timedelta
from flask import Flask, request, jsonify
from flask_cors import CORS
from src.upload_to_r2 import upload_file_to_r2

app = Flask(__name__)
# すべてのオリジンからのCORSリクエストを許可
CORS(app)

import urllib.request

LOCATIONS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "worker_locations.json")
SELF_REPLACEMENTS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "self_replaced_bikes.json")

# ファイル書き込み時の排他制御用ロック
file_lock = threading.Lock()


def restore_locations_from_r2():
    """
    R2から既存の worker_locations.json をダウンロードし、ローカルに復元する。
    """
    public_url = os.getenv("R2_PUBLIC_URL")
    if not public_url:
        print("[RESTORE] R2_PUBLIC_URL is not set. Skipping restore.")
        return

    url = f"{public_url.rstrip('/')}/worker_locations.json"
    print(f"[RESTORE] Trying to restore locations from {url}")
    try:
        req = urllib.request.Request(
            url, 
            headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
        )
        with urllib.request.urlopen(req, timeout=5) as response:
            if response.status == 200:
                data = json.loads(response.read().decode('utf-8'))
                with open(LOCATIONS_FILE, 'w', encoding='utf-8') as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                print(f"[RESTORE] Successfully restored locations file: {len(data)} workers")
            else:
                print(f"[RESTORE] R2 file not found or status: {response.status}")
    except Exception as e:
        print(f"[RESTORE] Could not restore locations from R2: {e}")


def restore_self_replacements_from_r2():
    """
    R2から既存の self_replaced_bikes.json をダウンロードし、ローカルに復元する。
    """
    public_url = os.getenv("R2_PUBLIC_URL")
    if not public_url:
        print("[RESTORE] R2_PUBLIC_URL is not set. Skipping restore.")
        return

    url = f"{public_url.rstrip('/')}/self_replaced_bikes.json"
    print(f"[RESTORE] Trying to restore self-replacements from {url}")
    try:
        req = urllib.request.Request(
            url, 
            headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
        )
        with urllib.request.urlopen(req, timeout=5) as response:
            if response.status == 200:
                data = json.loads(response.read().decode('utf-8'))
                with open(SELF_REPLACEMENTS_FILE, 'w', encoding='utf-8') as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                print(f"[RESTORE] Successfully restored self-replacements file: {len(data)} bikes")
            else:
                print(f"[RESTORE] R2 self-replacements file not found or status: {response.status}")
    except Exception as e:
        print(f"[RESTORE] Could not restore self-replacements from R2 (normal on first deploy): {e}")


# 起動時にデータを復元
restore_locations_from_r2()
restore_self_replacements_from_r2()

@app.route('/api/owntracks', methods=['POST'])
def receive_location():
    try:
        data = request.json
        if not data:
            return jsonify({"status": "error", "message": "No data received"}), 400

        # OwnTracks の location タイプのメッセージを処理
        if data.get('_type') == 'location':
            tid = data.get('tid')
            if not tid:
                return jsonify({"status": "error", "message": "Missing tracker ID (tid)"}), 400

            lat = data.get('lat')
            lon = data.get('lon')
            tst = data.get('tst')

            if lat is None or lon is None:
                return jsonify({"status": "error", "message": "Missing coordinates"}), 400

            # 日本時間 (JST = UTC+9) の設定
            JST = timezone(timedelta(hours=9))

            # タイムスタンプを日本時間に変換
            if tst:
                updated_at = datetime.fromtimestamp(tst, JST).strftime('%Y-%m-%d %H:%M:%S')
            else:
                updated_at = datetime.now(JST).strftime('%Y-%m-%d %H:%M:%S')


            # データの読み書き〜R2アップロードをスレッドロックで保護
            with file_lock:
                # 既存のデータを読み込み
                locations = {}
                if os.path.exists(LOCATIONS_FILE):
                    try:
                        with open(LOCATIONS_FILE, 'r', encoding='utf-8') as f:
                            locations = json.load(f)
                    except Exception as e:
                        print(f"Warning: Failed to load existing locations file: {e}")
                        locations = {}

                # データを更新
                locations[tid] = {
                    "tid": tid,
                    "lat": lat,
                    "lon": lon,
                    "updated_at": updated_at
                }

                # ファイルに保存
                with open(LOCATIONS_FILE, 'w', encoding='utf-8') as f:
                    json.dump(locations, f, ensure_ascii=False, indent=2)

                # Cloudflare R2 へアップロード (バックグラウンド同期)
                upload_success = False
                try:
                    upload_success = upload_file_to_r2(LOCATIONS_FILE, "worker_locations.json")
                except Exception as e:
                    print(f"Error uploading to R2: {e}")

            return jsonify([]), 200

        return jsonify([]), 200

    except Exception as e:
        print(f"Error processing location: {e}")
        # 例外時も確実に JSON を返す
        return jsonify({"status": "error", "message": str(e)}), 200


def cleanup_expired_self_replacements(self_replacements):
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    expired_keys = []
    for bike_id, item in self_replacements.items():
        timestamp = item.get("timestamp", 0)
        # 2時間 (7,200,000 ms) 以上経過したものを期限切れとする
        if now_ms - timestamp > 7200000 or now_ms - timestamp < 0:
            expired_keys.append(bike_id)
    
    for key in expired_keys:
        del self_replacements[key]
    return len(expired_keys) > 0


@app.route('/api/self-replacement', methods=['POST'])
def receive_self_replacement():
    try:
        data = request.json
        if not data:
            return jsonify({"status": "error", "message": "No data received"}), 400

        bike_id = data.get('bike_id')
        action = data.get('action') # 'check' or 'uncheck'
        
        if not bike_id:
            return jsonify({"status": "error", "message": "Missing bike_id"}), 400
        if not action or action not in ['check', 'uncheck']:
            return jsonify({"status": "error", "message": "Invalid or missing action"}), 400

        alert_level = data.get('alert_level', 0)
        voltage = data.get('voltage')

        with file_lock:
            # 既存のデータを読み込み
            self_replacements = {}
            if os.path.exists(SELF_REPLACEMENTS_FILE):
                try:
                    with open(SELF_REPLACEMENTS_FILE, 'r', encoding='utf-8') as f:
                        self_replacements = json.load(f)
                except Exception as e:
                    print(f"Warning: Failed to load self-replacements: {e}")
                    self_replacements = {}

            # 期限切れをクリーンアップ
            cleanup_expired_self_replacements(self_replacements)

            if action == 'check':
                # 新規追加（または更新）
                self_replacements[bike_id] = {
                    "timestamp": int(datetime.now(timezone.utc).timestamp() * 1000),
                    "alert_level": alert_level,
                    "voltage": float(voltage) if voltage is not None else None
                }
                print(f"[SELF-REPLACE] Checked bike: {bike_id}")
            else: # 'uncheck'
                # 削除
                if bike_id in self_replacements:
                    del self_replacements[bike_id]
                    print(f"[SELF-REPLACE] Unchecked bike: {bike_id}")

            # 保存
            with open(SELF_REPLACEMENTS_FILE, 'w', encoding='utf-8') as f:
                json.dump(self_replacements, f, ensure_ascii=False, indent=2)

            # R2 へアップロード
            try:
                upload_file_to_r2(SELF_REPLACEMENTS_FILE, "self_replaced_bikes.json")
            except Exception as e:
                print(f"Error uploading self-replacements to R2: {e}")

        return jsonify({"status": "success", "data": self_replacements}), 200

    except Exception as e:
        print(f"Error processing self-replacement: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/self-replacement', methods=['GET'])
def get_self_replacements():
    try:
        self_replacements = {}
        with file_lock:
            if os.path.exists(SELF_REPLACEMENTS_FILE):
                try:
                    with open(SELF_REPLACEMENTS_FILE, 'r', encoding='utf-8') as f:
                        self_replacements = json.load(f)
                except Exception as e:
                    print(f"Warning: Failed to load self-replacements for GET: {e}")
                    self_replacements = {}
            
            # クリーンアップして必要なら保存
            if cleanup_expired_self_replacements(self_replacements):
                with open(SELF_REPLACEMENTS_FILE, 'w', encoding='utf-8') as f:
                    json.dump(self_replacements, f, ensure_ascii=False, indent=2)
                try:
                    upload_file_to_r2(SELF_REPLACEMENTS_FILE, "self_replaced_bikes.json")
                except Exception as e:
                    print(f"Error uploading self-replacements to R2 on GET cleanup: {e}")

        return jsonify(self_replacements), 200
    except Exception as e:
        print(f"Error reading self-replacements: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/worker-locations', methods=['GET'])
def get_locations():
    try:
        if os.path.exists(LOCATIONS_FILE):
            with open(LOCATIONS_FILE, 'r', encoding='utf-8') as f:
                locations = json.load(f)
            return jsonify(locations), 200
        else:
            return jsonify({}), 200
    except Exception as e:
        print(f"Error reading locations: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500

if __name__ == '__main__':
    # 環境変数 PORT を優先 (デフォルト 5000)
    port = int(os.environ.get("PORT", 5000))
    # 全てのインターフェースで待ち受け
    app.run(host='0.0.0.0', port=port, debug=True)
