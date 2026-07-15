import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import json
import tempfile
from unittest.mock import patch
from datetime import datetime, timezone, timedelta
from main import check_maintenance_mode

def test_check_maintenance_mode():
    with tempfile.TemporaryDirectory() as tmpdir:
        temp_json = os.path.join(tmpdir, "announcement.json")
        
        # Case 1: メンテナンスが無効（enabled = False）
        data_disabled = {
            "maintenance": {
                "enabled": False,
                "message": "メンテナンス中",
                "start_time": "2026-07-31T21:00:00+09:00"
            }
        }
        with open(temp_json, "w", encoding="utf-8") as f:
            json.dump(data_disabled, f)
            
        with patch("os.path.join", return_value=temp_json), patch("os.path.exists", return_value=True):
            assert check_maintenance_mode() is False

        # Case 2: メンテナンスが有効かつ開始前
        future_time = (datetime.now(timezone.utc) + timedelta(days=1)).astimezone(timezone(timedelta(hours=9)))
        data_future = {
            "maintenance": {
                "enabled": True,
                "message": "メンテナンス中",
                "start_time": future_time.isoformat()
            }
        }
        with open(temp_json, "w", encoding="utf-8") as f:
            json.dump(data_future, f)
            
        with patch("os.path.join", return_value=temp_json), patch("os.path.exists", return_value=True):
            assert check_maintenance_mode() is False

        # Case 3: メンテナンスが有効かつ開始後
        past_time = (datetime.now(timezone.utc) - timedelta(days=1)).astimezone(timezone(timedelta(hours=9)))
        data_past = {
            "maintenance": {
                "enabled": True,
                "message": "メンテナンス中",
                "start_time": past_time.isoformat()
            }
        }
        with open(temp_json, "w", encoding="utf-8") as f:
            json.dump(data_past, f)
            
        with patch("os.path.join", return_value=temp_json), patch("os.path.exists", return_value=True):
            assert check_maintenance_mode() is True
