# -*- coding: utf-8 -*-
import os
import json
import pytest
from main import check_maintenance_mode


def test_maintenance_mode_enabled_past_start_time(tmp_path, monkeypatch):
    """開始時刻が過去かつenabled: trueの場合、Trueを返すかテスト"""
    announcement_data = {
        "maintenance": {
            "enabled": True,
            "message": "障害対応テスト",
            "start_time": "2020-01-01T00:00:00+09:00"
        }
    }
    json_file = tmp_path / "announcement.json"
    json_file.write_text(json.dumps(announcement_data, ensure_ascii=False), encoding="utf-8")

    monkeypatch.delenv("DBS_DISABLE_SCRAPING", raising=False)
    monkeypatch.delenv("DBS_MAINTENANCE_MODE", raising=False)

    assert check_maintenance_mode(json_file) is True


def test_maintenance_mode_disabled(tmp_path, monkeypatch):
    """enabled: falseの場合、Falseを返すかテスト"""
    announcement_data = {
        "maintenance": {
            "enabled": False,
            "message": "通常運用中",
            "start_time": "2020-01-01T00:00:00+09:00"
        }
    }
    json_file = tmp_path / "announcement.json"
    json_file.write_text(json.dumps(announcement_data, ensure_ascii=False), encoding="utf-8")

    monkeypatch.delenv("DBS_DISABLE_SCRAPING", raising=False)
    monkeypatch.delenv("DBS_MAINTENANCE_MODE", raising=False)

    assert check_maintenance_mode(json_file) is False


def test_frontend_maintenance_can_keep_scraping_enabled(tmp_path, monkeypatch):
    """フロント保守表示中でもscraping_disabled: falseなら収集を継続する"""
    announcement_data = {
        "maintenance": {
            "enabled": True,
            "worker_location_only": True,
            "scraping_disabled": False,
            "message": "作業員位置情報以外は休止中",
            "start_time": "2020-01-01T00:00:00+09:00"
        }
    }
    json_file = tmp_path / "announcement.json"
    json_file.write_text(json.dumps(announcement_data, ensure_ascii=False), encoding="utf-8")

    monkeypatch.delenv("DBS_DISABLE_SCRAPING", raising=False)
    monkeypatch.delenv("DBS_MAINTENANCE_MODE", raising=False)

    assert check_maintenance_mode(json_file) is False


def test_maintenance_mode_no_start_time(tmp_path, monkeypatch):
    """start_timeなしでenabled: trueの場合、Trueを返すかテスト"""
    announcement_data = {
        "maintenance": {
            "enabled": True,
            "message": "緊急停止"
        }
    }
    json_file = tmp_path / "announcement.json"
    json_file.write_text(json.dumps(announcement_data, ensure_ascii=False), encoding="utf-8")

    monkeypatch.delenv("DBS_DISABLE_SCRAPING", raising=False)
    monkeypatch.delenv("DBS_MAINTENANCE_MODE", raising=False)

    assert check_maintenance_mode(json_file) is True


def test_maintenance_mode_env_variable(tmp_path, monkeypatch):
    """環境変数 DBS_DISABLE_SCRAPING=true でTrueを返すかテスト"""
    monkeypatch.setenv("DBS_DISABLE_SCRAPING", "true")
    assert check_maintenance_mode() is True