# -*- coding: utf-8 -*-
import os
import json
import pytest
from unittest.mock import patch
from server import app, LOCATIONS_FILE

@pytest.fixture
def client():
    app.config['TESTING'] = True
    # テスト前に一時的な場所情報ファイルをクリーンアップ
    if os.path.exists(LOCATIONS_FILE):
        try:
            os.remove(LOCATIONS_FILE)
        except Exception:
            pass

    with app.test_client() as client:
        yield client

    # テスト後にクリーンアップ
    if os.path.exists(LOCATIONS_FILE):
        try:
            os.remove(LOCATIONS_FILE)
        except Exception:
            pass

@patch('server.upload_file_to_r2')
def test_receive_location_success(mock_upload, client):
    # R2アップロードはモック化
    mock_upload.return_value = True

    payload = {
        "_type": "location",
        "tid": "WA",
        "lat": 35.6812,
        "lon": 139.7671,
        "tst": 1686307200
    }

    response = client.post('/api/owntracks', json=payload)
    assert response.status_code == 200
    res_data = json.loads(response.data.decode('utf-8'))
    assert res_data["status"] == "ok"
    assert res_data["data"]["tid"] == "WA"
    assert res_data["data"]["lat"] == 35.6812
    assert res_data["data"]["lon"] == 139.7671

    # R2アップロードが呼び出されたことを検証
    mock_upload.assert_called_once_with(LOCATIONS_FILE, "worker_locations.json")

    # ファイルに正しく書き込まれたか検証
    assert os.path.exists(LOCATIONS_FILE)
    with open(LOCATIONS_FILE, 'r', encoding='utf-8') as f:
        stored_data = json.load(f)
    assert "WA" in stored_data
    assert stored_data["WA"]["lat"] == 35.6812

@patch('server.upload_file_to_r2')
def test_receive_location_missing_tid(mock_upload, client):
    payload = {
        "_type": "location",
        "lat": 35.6812,
        "lon": 139.7671
    }
    response = client.post('/api/owntracks', json=payload)
    assert response.status_code == 400
    res_data = json.loads(response.data.decode('utf-8'))
    assert res_data["status"] == "error"

def test_receive_location_invalid_type(client):
    payload = {
        "_type": "steps",
        "steps": 1200
    }
    response = client.post('/api/owntracks', json=payload)
    assert response.status_code == 200
    res_data = json.loads(response.data.decode('utf-8'))
    assert res_data["status"] == "ignored"

def test_get_locations_empty(client):
    response = client.get('/api/worker-locations')
    assert response.status_code == 200
    res_data = json.loads(response.data.decode('utf-8'))
    assert res_data == {}

@patch('server.upload_file_to_r2')
def test_get_locations_with_data(mock_upload, client):
    mock_upload.return_value = True

    # 1件登録
    payload = {
        "_type": "location",
        "tid": "WB",
        "lat": 36.5684,
        "lon": 136.6483,
        "tst": 1686307200
    }
    client.post('/api/owntracks', json=payload)

    # 取得
    response = client.get('/api/worker-locations')
    assert response.status_code == 200
    res_data = json.loads(response.data.decode('utf-8'))
    assert "WB" in res_data
    assert res_data["WB"]["lat"] == 36.5684
    assert res_data["WB"]["lon"] == 136.6483
