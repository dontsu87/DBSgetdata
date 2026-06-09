# -*- coding: utf-8 -*-
import os
import json
from datetime import datetime
from flask import Flask, request, jsonify
from flask_cors import CORS
from src.upload_to_r2 import upload_file_to_r2

app = Flask(__name__)
# すべてのオリジンからのCORSリクエストを許可
CORS(app)

LOCATIONS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "worker_locations.json")

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

            # タイムスタンプを日時に変換
            if tst:
                updated_at = datetime.fromtimestamp(tst).strftime('%Y-%m-%d %H:%M:%S')
            else:
                updated_at = datetime.now().strftime('%Y-%m-%d %H:%M:%S')

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

            return jsonify({
                "status": "ok",
                "message": "Location updated successfully",
                "r2_uploaded": upload_success,
                "data": locations[tid]
            }), 200

        return jsonify({"status": "ignored", "message": "Not a location message type"}), 200

    except Exception as e:
        print(f"Error processing location: {e}")
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
