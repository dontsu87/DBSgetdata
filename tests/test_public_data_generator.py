# -*- coding: utf-8 -*-
import pytest
import os
import json
from src.public_data_generator import generate_public_ports_data, get_port_name_en

def test_get_port_name_en():
    assert get_port_name_en("04.ドコモ東北ビル") == "ドコモ東北ビル"
    assert get_port_name_en("01.金沢駅") == "金沢駅"
    assert get_port_name_en("A1-テストポート") == "テストポート"

def test_generate_public_ports_data(tmp_path):
    sample_ports_data = {
        "04.ドコモ東北ビル": {
            "port_name": "04.ドコモ東北ビル",
            "area_name": "KNZ_金沢",
            "station_id": "00000001",
            "lat": 38.269793,
            "lon": 140.874203,
            "capacity": 20,
            "total_bikes": 3,
            "bikes": [
                {"bike_id": "TEST1", "status": "利用可能", "voltage": 25.5},
                {"bike_id": "TEST2", "status": "点検中", "voltage": 23.0},
                {"bike_id": "TEST3", "status": "available", "voltage": 26.0}
            ]

        },
        "位置情報なしポート": {
            "port_name": "位置情報なしポート",
            "area_name": "KNZ_金沢",
            "station_id": "00000002",
            "lat": None,
            "lon": None,
            "total_bikes": 2
        },
        "保管倉庫_出雲倉庫": {
            "port_name": "保管倉庫_出雲倉庫",
            "area_name": "SPS_出雲・松江・境港",
            "station_id": "00000003",
            "lat": 35.360000,
            "lon": 132.750000,
            "publish_flag": False,
            "service_state": "運用中",
            "capacity": 10,
            "total_bikes": 5
        },
        "停止中ポート": {
            "port_name": "停止中ポート",
            "area_name": "KNZ_金沢",
            "station_id": "00000004",
            "lat": 36.560000,
            "lon": 136.650000,
            "publish_flag": True,
            "service_state": "停止中",
            "capacity": 10,
            "total_bikes": 0
        },
        "KNZ_ポート外": {
            "port_name": "KNZ_ポート外",
            "area_name": "KNZ_金沢",
            "station_id": "",
            "lat": 36.560000,
            "lon": 136.650000,
            "publish_flag": True,
            "service_state": "運用中",
            "capacity": 0,
            "total_bikes": 1
        }
    }
    
    json_path, js_path = generate_public_ports_data(sample_ports_data)
    
    assert json_path is not None
    assert os.path.exists(json_path)
    
    with open(json_path, "r", encoding="utf-8") as f:
        payload = json.load(f)
        
    ports = payload["ports"]
    assert len(ports) == 1 # 位置情報なしは除外されるため1個
    
    p = ports[0]
    assert p["port_name"] == "04.ドコモ東北ビル"
    assert p["bikes_available"] == 2  # 「点検中」が除外され「利用可能」「available」の2台のみカウント

    assert p["capacity"] == 20
    assert "bikes" not in p # 機密情報（バッテリーやID）が含まれていないこと
    assert "voltage" not in p
