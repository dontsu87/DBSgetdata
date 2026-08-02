# -*- coding: utf-8 -*-
import pytest

from src.config import Config


def test_validate_new_portal_does_not_require_legacy_accounts(monkeypatch, tmp_path):
    monkeypatch.setattr(Config, "LOGIN_URL", "https://mg-auth.example/login")
    monkeypatch.setattr(Config, "LOGIN_EMAIL", "user@example.com")
    monkeypatch.setattr(Config, "LOGIN_PASSWORD", "password")
    monkeypatch.setattr(Config, "WORKER_ACCOUNT", "")
    monkeypatch.setattr(Config, "WORKER_PASSWORD", "")
    monkeypatch.setattr(Config, "WORKER_TOP_PAGE", "")
    monkeypatch.setattr(Config, "OUTPUT_DIR", str(tmp_path))

    Config.validate(is_worker=True)


def test_validate_new_portal_reports_new_credentials(monkeypatch, tmp_path):
    monkeypatch.setattr(Config, "LOGIN_URL", "https://mg-auth.example/login")
    monkeypatch.setattr(Config, "LOGIN_EMAIL", "")
    monkeypatch.setattr(Config, "LOGIN_PASSWORD", "")
    monkeypatch.setattr(Config, "OUTPUT_DIR", str(tmp_path))

    with pytest.raises(ValueError) as error:
        Config.validate(is_worker=True)

    assert "DBS_LOGIN_EMAIL" in str(error.value)
    assert "DBS_LOGIN_PASSWORD" in str(error.value)
