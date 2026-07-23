# -*- coding: utf-8 -*-
import os
import json
import pytest
from unittest.mock import patch
from server import app, LOCATIONS_FILE, SELF_REPLACEMENTS_FILE, SMS_CODE_FILE

@pytest.fixture
def client():
    app.config['TESTING'] = True
    # テスト前に一時的な場所情報ファイルと自己申告ファイル、SMSコードファイルをクリーンアップ
    for file_path in [LOCATIONS_FILE, SELF_REPLACEMENTS_FILE, SMS_CODE_FILE]:
        if os.path.exists(file_path):
            try:
                os.remove(file_path)
            except Exception:
                pass

    with app.test_client() as client:
        yield client

    # テスト後にクリーンアップ
    for file_path in [LOCATIONS_FILE, SELF_REPLACEMENTS_FILE, SMS_CODE_FILE]:
        if os.path.exists(file_path):
            try:
                os.remove(file_path)
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
    assert res_data == []

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
    assert res_data == []

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

@patch('server.upload_file_to_r2')
def test_receive_self_replacement_check_success(mock_upload, client):
    mock_upload.return_value = True

    payload = {
        "bike_id": "KNZ0099",
        "action": "check",
        "alert_level": 2,
        "voltage": 23.5
    }

    response = client.post('/api/self-replacement', json=payload)
    assert response.status_code == 200
    res_data = json.loads(response.data.decode('utf-8'))
    assert res_data["status"] == "success"
    assert "KNZ0099" in res_data["data"]
    assert res_data["data"]["KNZ0099"]["alert_level"] == 2
    assert res_data["data"]["KNZ0099"]["voltage"] == 23.5

    mock_upload.assert_called_once_with(SELF_REPLACEMENTS_FILE, "self_replaced_bikes.json")

@patch('server.upload_file_to_r2')
def test_receive_self_replacement_uncheck_success(mock_upload, client):
    mock_upload.return_value = True

    # 1. まず check する
    payload_check = {
        "bike_id": "KNZ0099",
        "action": "check",
        "alert_level": 2,
        "voltage": 23.5
    }
    client.post('/api/self-replacement', json=payload_check)

    # 2. 次に uncheck する
    payload_uncheck = {
        "bike_id": "KNZ0099",
        "action": "uncheck"
    }
    response = client.post('/api/self-replacement', json=payload_uncheck)
    assert response.status_code == 200
    res_data = json.loads(response.data.decode('utf-8'))
    assert res_data["status"] == "success"
    assert "KNZ0099" not in res_data["data"]

def test_receive_self_replacement_missing_params(client):
    # bike_id が無い
    payload_missing_id = {
        "action": "check",
        "alert_level": 2
    }
    response = client.post('/api/self-replacement', json=payload_missing_id)
    assert response.status_code == 400

    # action が無い
    payload_missing_action = {
        "bike_id": "KNZ0099",
        "alert_level": 2
    }
    response = client.post('/api/self-replacement', json=payload_missing_action)
    assert response.status_code == 400

@patch('server.upload_file_to_r2')
def test_get_self_replacements(mock_upload, client):
    mock_upload.return_value = True

    # データ登録
    payload = {
        "bike_id": "KNZ0100",
        "action": "check",
        "alert_level": 1,
        "voltage": 24.2
    }
    client.post('/api/self-replacement', json=payload)

    # 取得
    response = client.get('/api/self-replacement')
    assert response.status_code == 200
    res_data = json.loads(response.data.decode('utf-8'))
    assert "KNZ0100" in res_data
    assert res_data["KNZ0100"]["alert_level"] == 1


def test_sms_code_flow_success(client):
    secret = "dbs-sms-secret"
    
    # 1. 保存前は空であること
    response = client.get(f'/api/sms-code?secret={secret}')
    assert response.status_code == 200
    res_data = json.loads(response.data.decode('utf-8'))
    assert res_data["code"] is None

    # 2. 正常なコードの保存
    payload = {
        "code": "123456",
        "secret": secret
    }
    response = client.post('/api/sms-code', json=payload)
    assert response.status_code == 200
    res_data = json.loads(response.data.decode('utf-8'))
    assert res_data["status"] == "success"

    # 3. 正常なコードの取得
    response = client.get(f'/api/sms-code?secret={secret}')
    assert response.status_code == 200
    res_data = json.loads(response.data.decode('utf-8'))
    assert res_data["code"] == "123456"

    # 4. コードの削除
    response = client.delete(f'/api/sms-code?secret={secret}')
    assert response.status_code == 200
    res_data = json.loads(response.data.decode('utf-8'))
    assert res_data["status"] == "success"

    # 5. 削除後は空であること
    response = client.get(f'/api/sms-code?secret={secret}')
    assert response.status_code == 200
    res_data = json.loads(response.data.decode('utf-8'))
    assert res_data["code"] is None


def test_sms_code_unauthorized(client):
    secret = "dbs-sms-secret"
    wrong_secret = "wrong-secret"

    # 1. POST時の認証エラー
    payload = {
        "code": "123456",
        "secret": wrong_secret
    }
    response = client.post('/api/sms-code', json=payload)
    assert response.status_code == 401

    # 正しいシークレットで一度保存
    payload["secret"] = secret
    client.post('/api/sms-code', json=payload)

    # 2. GET時の認証エラー
    response = client.get(f'/api/sms-code?secret={wrong_secret}')
    assert response.status_code == 401

    # 3. DELETE時の認証エラー
    response = client.delete(f'/api/sms-code?secret={wrong_secret}')
    assert response.status_code == 401


def test_sms_code_invalid_format(client):
    secret = "dbs-sms-secret"

    # 数字以外
    payload = {
        "code": "123a56",
        "secret": secret
    }
    response = client.post('/api/sms-code', json=payload)
    assert response.status_code == 400

    # 短すぎる
    payload["code"] = "123"
    response = client.post('/api/sms-code', json=payload)
    assert response.status_code == 400

    # 長すぎる
    payload["code"] = "123456789"
    response = client.post('/api/sms-code', json=payload)
    assert response.status_code == 400


def test_sms_code_expired(client):
    secret = "dbs-sms-secret"

    # コードを保存
    payload = {
        "code": "654321",
        "secret": secret
    }
    response = client.post('/api/sms-code', json=payload)
    assert response.status_code == 200

    # ファイルを手動で書き換えて、タイムスタンプを過去（6分前＝360秒前）にする
    assert os.path.exists(SMS_CODE_FILE)
    with open(SMS_CODE_FILE, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    # タイムスタンプを過去に改ざん
    from datetime import datetime, timezone
    data["received_at"] = datetime.now(timezone.utc).timestamp() - 360

    with open(SMS_CODE_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f)

    # 取得すると期限切れのため None が返ることを確認
    response = client.get(f'/api/sms-code?secret={secret}')
    assert response.status_code == 200
    res_data = json.loads(response.data.decode('utf-8'))
    assert res_data["code"] is None
