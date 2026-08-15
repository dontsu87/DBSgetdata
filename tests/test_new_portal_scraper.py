# -*- coding: utf-8 -*-
import json
import traceback

import pandas as pd
import pytest
import requests

import src.new_portal_scraper as portal
from src.new_portal_scraper import (
    PortalApiError,
    PortalSessionError,
    build_http_session,
    scrape_all_vehicles,
    scrape_all_vehicles_http,
)


class FakeDriver:
    def __init__(self, result):
        self.result = result
        self.timeout = None
        self.script = None

    def set_script_timeout(self, timeout):
        self.timeout = timeout

    def execute_async_script(self, script):
        self.script = script
        return self.result


class FakeResponse:
    def __init__(self, status_code=200, body=None, json_error=None):
        self.status_code = status_code
        self.body = body
        self.json_error = json_error

    def json(self):
        if self.json_error:
            raise self.json_error
        return self.body


class FakeHttpSession:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def vehicle(code, state="USABLE", port="駅前", voltage="41.2"):
    return {
        "vehicleUniqueCode": code,
        "vehicleState": state,
        "portName": port,
        "batteryElectricVoltage": voltage,
        "dataReceivedTs": "2026-08-02T01:00:00Z",
    }


def test_scrape_all_vehicles_http_paginates_maps_and_deduplicates(monkeypatch):
    monkeypatch.setattr(portal, "PAGE_SIZE", 2)
    monkeypatch.setattr(portal, "app_url", lambda: "https://mg.example/")
    http = FakeHttpSession([
        FakeResponse(body={"dataList": [{"areaId": "A", "areaName": "福井"}]}),
        FakeResponse(body={
            "dataList": [vehicle("A-001"), vehicle("B-002")],
            "pagination": {"total": 3},
        }),
        FakeResponse(body={
            "dataList": [vehicle("A-001", state="MANUAL_MAINTENANCE", voltage=None)],
            "pagination": {"total": 3},
        }),
    ])

    frame = scrape_all_vehicles_http(http_session=http, sleep=lambda _: None)

    assert len(http.calls) == 3
    assert all(call[1]["allow_redirects"] is False for call in http.calls)
    assert all(call[1]["timeout"] == portal.HTTP_TIMEOUT for call in http.calls)
    assert list(frame.columns) == [
        "エリア名", "識別番号", "車両状態", "ポート名", "電圧", "AT通知受信日時",
        "位置詳細取得フラグ", "位置詳細取得状態", "車両位置緯度", "車両位置経度",
        "車両位置測位日時", "車両位置標高", "車両位置速度", "車両位置方位", "車両位置衛星数",
    ]
    assert list(frame["識別番号"]) == ["B-002", "A-001"]
    assert frame.loc[1, "車両状態"] == "メンテナンス(手動)"
    assert pd.isna(frame.loc[1, "電圧"])


def test_build_http_session_restores_cookie_attributes_without_exposing_value(tmp_path):
    secret = "DO-NOT-LOG-COOKIE"
    session_file = tmp_path / "session.json"
    session_file.write_text(json.dumps({
        "all_cookies": [{
            "name": "dbspf_session",
            "value": secret,
            "domain": ".mg.example",
            "path": "/api",
            "secure": True,
            "expires": 4102444800,
        }],
    }), encoding="utf-8")

    session = build_http_session(session_file)
    cookie = next(iter(session.cookies))
    assert cookie.value == secret
    assert cookie.domain == ".mg.example"
    assert cookie.path == "/api"
    assert cookie.secure is True
    assert cookie.expires == 4102444800
    session.close()


def test_build_http_session_missing_or_invalid_is_auth_failure(tmp_path):
    with pytest.raises(PortalSessionError, match="セッション"):
        build_http_session(tmp_path / "missing.json")

    secret = "SECRET-CONTENT-MUST-NOT-LEAK"
    invalid = tmp_path / "invalid.json"
    invalid.write_text(secret, encoding="utf-8")
    with pytest.raises(PortalSessionError) as captured:
        build_http_session(invalid)
    assert secret not in str(captured.value)


@pytest.mark.parametrize("status", [401, 403, 302])
def test_http_auth_status_raises_session_error_without_cookie_leak(monkeypatch, status):
    monkeypatch.setattr(portal, "app_url", lambda: "https://mg.example/")
    secret = "COOKIE-VALUE-MUST-NOT-LEAK"
    http = FakeHttpSession([FakeResponse(status_code=status, body=secret)])
    with pytest.raises(PortalSessionError) as captured:
        scrape_all_vehicles_http(http_session=http)
    assert secret not in str(captured.value)


@pytest.mark.parametrize("response", [
    FakeResponse(status_code=500, body={"secret": "do-not-log"}),
    requests.ConnectionError("connection failed with COOKIE-VALUE"),
    FakeResponse(status_code=200, json_error=ValueError("COOKIE-VALUE")),
    FakeResponse(status_code=200, body={"unexpected": "shape"}),
])
def test_http_non_auth_failures_are_api_errors_without_response_content(monkeypatch, response):
    monkeypatch.setattr(portal, "app_url", lambda: "https://mg.example/")
    http = FakeHttpSession([response])
    with pytest.raises(PortalApiError) as captured:
        scrape_all_vehicles_http(http_session=http)
    formatted = "".join(traceback.format_exception(captured.value))
    assert "COOKIE-VALUE" not in formatted
    assert "do-not-log" not in formatted


def test_scrape_all_vehicles_maps_columns_states_and_voltage():
    driver = FakeDriver({
        "areaCount": 5,
        "total": 2,
        "rows": [
            {
                "areaName": "福井",
                "vehicleUniqueCode": "A-001",
                "vehicleState": "USABLE",
                "portName": "駅前",
                "batteryElectricVoltage": "41.2",
                "dataReceivedTs": "2026-08-02T01:00:00Z",
            },
            {
                "areaName": "金沢",
                "vehicleUniqueCode": "B-002",
                "vehicleState": "MANUAL_MAINTENANCE",
                "portName": "市役所",
                "batteryElectricVoltage": None,
                "dataReceivedTs": "",
            },
        ],
    })

    frame = scrape_all_vehicles(driver)

    assert driver.timeout == 180
    assert "method: 'GET'" in driver.script
    assert frame.loc[0, "車両状態"] == "利用可能"
    assert frame.loc[1, "車両状態"] == "メンテナンス(手動)"
    assert frame.loc[0, "電圧"] == pytest.approx(41.2)
    assert pd.isna(frame.loc[1, "電圧"])


def test_scrape_all_vehicles_returns_compatible_empty_frame():
    frame = scrape_all_vehicles(FakeDriver({"rows": [], "areaCount": 5}))
    assert frame.empty
    assert list(frame.columns) == [
        "エリア名", "識別番号", "車両状態", "ポート名", "電圧", "AT通知受信日時",
        "位置詳細取得フラグ", "位置詳細取得状態", "車両位置緯度", "車両位置経度",
        "車両位置測位日時", "車両位置標高", "車両位置速度", "車両位置方位", "車両位置衛星数",
    ]


def test_fetch_vehicle_location_details_collects_gps_and_audit_fields():
    rows = [
        {
            'areaName': '金沢',
            'vehicleUniqueCode': 'OUT-001',
            'portName': '',
            'attachmentId': 'AT-001',
        },
        {
            'areaName': '金沢',
            'vehicleUniqueCode': 'IN-001',
            'portName': '駅前',
            'attachmentId': 'AT-002',
        },
    ]
    http = FakeHttpSession([
        FakeResponse(body={
            'gpsInfo': {
                'gpsGlobalLocationLatitude': 36.578,
                'gpsGlobalLocationLongitude': 136.648,
                'gpsGlobalLocationDateTime': '2026-08-02T01:02:03Z',
                'gpsGlobalLocationElevation': 12.3,
                'gpsGlobalLocationGroundSpeed': 4.5,
                'gpsGlobalLocationDirection': 90,
                'gpsGlobalLocationSatellitesNumber': 8,
            },
        }),
    ])

    portal.fetch_vehicle_location_details(
        rows,
        http_session=http,
        base_url='https://mg.example/',
        known_port_names={'駅前'},
        enabled=True,
        max_per_run=10,
        delay_ms=0,
    )

    assert len(http.calls) == 1
    assert http.calls[0][0].endswith('/api/attachments/AT-001')
    assert rows[0]['vehicleLocationFetchFlag'] == 1
    assert rows[0]['vehicleLocationFetchStatus'] == '取得成功'
    assert rows[0]['vehicleGpsLatitude'] == pytest.approx(36.578)
    assert rows[0]['vehicleGpsLongitude'] == pytest.approx(136.648)
    assert rows[1]['vehicleLocationFetchFlag'] == 0
    assert rows[1]['vehicleLocationFetchStatus'] == '対象外'



def test_fetch_vehicle_location_details_includes_previous_mismatch_port_bikes():
    rows = [
        {'vehicleUniqueCode': 'IN-001', 'portName': '駅前', 'attachmentId': 'AT-001'},
        {'vehicleUniqueCode': 'IN-002', 'portName': '駅前', 'attachmentId': 'AT-002'},
    ]
    http = FakeHttpSession([
        FakeResponse(body={'gpsInfo': {
            'gpsGlobalLocationLatitude': 36.577,
            'gpsGlobalLocationLongitude': 136.647,
        }}),
    ])

    portal.fetch_vehicle_location_details(
        rows,
        http_session=http,
        base_url='https://mg.example/',
        known_port_names={'駅前'},
        mismatch_vehicle_ids={'IN-001'},
        enabled=True,
        max_per_run=10,
        delay_ms=0,
    )

    assert len(http.calls) == 1
    assert http.calls[0][0].endswith('/api/attachments/AT-001')
    assert rows[0]['vehicleLocationFetchStatus'] == '取得成功'
    assert rows[1]['vehicleLocationFetchStatus'] == '対象外'


def test_fetch_vehicle_location_details_hourly_mode_includes_port_bikes_without_cap():
    rows = [
        {'vehicleUniqueCode': 'IN-001', 'portName': '駅前', 'attachmentId': 'AT-001'},
        {'vehicleUniqueCode': 'IN-002', 'portName': '駅前', 'attachmentId': 'AT-002'},
    ]
    http = FakeHttpSession([
        FakeResponse(body={'gpsInfo': {
            'gpsGlobalLocationLatitude': 36.577,
            'gpsGlobalLocationLongitude': 136.647,
        }}),
        FakeResponse(body={'gpsInfo': {
            'gpsGlobalLocationLatitude': 36.578,
            'gpsGlobalLocationLongitude': 136.648,
        }}),
    ])

    portal.fetch_vehicle_location_details(
        rows,
        http_session=http,
        base_url='https://mg.example/',
        known_port_names={'駅前'},
        enabled=True,
        max_per_run=1,
        unlimited=True,
        include_port_vehicles=True,
        delay_ms=0,
    )

    assert len(http.calls) == 2
    assert all(row['vehicleLocationFetchStatus'] == '取得成功' for row in rows)

def test_fetch_vehicle_location_details_can_be_stopped_without_detail_calls():
    rows = [{
        'vehicleUniqueCode': 'OUT-001',
        'portName': '',
        'attachmentId': 'AT-001',
    }]
    http = FakeHttpSession([])

    portal.fetch_vehicle_location_details(
        rows,
        http_session=http,
        base_url='https://mg.example/',
        known_port_names={'駅前'},
        enabled=False,
        max_per_run=10,
        delay_ms=0,
    )

    assert http.calls == []
    assert rows[0]['vehicleLocationFetchFlag'] == 0
    assert rows[0]['vehicleLocationFetchStatus'] == '停止中'


def test_scrape_all_vehicles_rejects_missing_required_fields():
    with pytest.raises(RuntimeError, match="必須項目"):
        scrape_all_vehicles(FakeDriver({"rows": [{"vehicleUniqueCode": "A-001"}]}))


def test_fetch_vehicle_location_details_targets_using_vehicles():
    rows = [
        {
            'vehicleUniqueCode': 'USING-001',
            'vehicleState': 'USING',
            'portName': '駅前',
            'attachmentId': 'AT-001',
        },
        {
            'vehicleUniqueCode': 'USABLE-002',
            'vehicleState': 'USABLE',
            'portName': '駅前',
            'attachmentId': 'AT-002',
        },
    ]
    http = FakeHttpSession([
        FakeResponse(body={'gpsInfo': {
            'gpsGlobalLocationLatitude': 36.577,
            'gpsGlobalLocationLongitude': 136.647,
        }}),
    ])

    portal.fetch_vehicle_location_details(
        rows,
        http_session=http,
        base_url='https://mg.example/',
        known_port_names={'駅前'},
        enabled=True,
        max_per_run=10,
        include_port_vehicles=False,
        mismatch_vehicle_ids=set(),
        delay_ms=0,
    )

    assert len(http.calls) == 1
    assert rows[0]['vehicleLocationFetchStatus'] == '取得成功'
    assert rows[0]['vehicleGpsLatitude'] == 36.577
    assert rows[1]['vehicleLocationFetchStatus'] == '対象外'

