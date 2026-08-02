# -*- coding: utf-8 -*-
from unittest.mock import patch

import pytest

from src.config import Config


def test_validate_missing_new_portal_variables(monkeypatch):
    monkeypatch.setattr(Config, "LOGIN_URL", "")
    monkeypatch.setattr(Config, "LOGIN_EMAIL", "")
    monkeypatch.setattr(Config, "LOGIN_PASSWORD", "")

    with pytest.raises(ValueError) as error:
        Config.validate()

    message = str(error.value)
    assert "DBS_LOGIN_URL" in message
    assert "DBS_LOGIN_EMAIL" in message
    assert "DBS_LOGIN_PASSWORD" in message


@patch("src.config.os.makedirs")
def test_validate_new_portal_success(mock_makedirs, monkeypatch):
    monkeypatch.setattr(Config, "LOGIN_URL", "https://mg-auth.example/login")
    monkeypatch.setattr(Config, "LOGIN_EMAIL", "user@example.com")
    monkeypatch.setattr(Config, "LOGIN_PASSWORD", "password")
    monkeypatch.setattr(Config, "OUTPUT_DIR", r"C:\dummy_onedrive_path")

    Config.validate(is_worker=True)

    mock_makedirs.assert_called_once_with(r"C:\dummy_onedrive_path", exist_ok=True)


def test_login_settings_never_fall_back_to_closed_portal(monkeypatch):
    monkeypatch.setattr(Config, "LOGIN_URL", "")
    monkeypatch.setattr(Config, "LOGIN_EMAIL", "")
    monkeypatch.setattr(Config, "LOGIN_PASSWORD", "")
    monkeypatch.setattr(Config, "TOP_PAGE", "https://closed-admin.example/")
    monkeypatch.setattr(Config, "WORKER_TOP_PAGE", "https://closed-worker.example/")
    monkeypatch.setattr(Config, "ACCOUNT", "legacy-admin")
    monkeypatch.setattr(Config, "WORKER_ACCOUNT", "legacy-worker")

    assert Config.login_url(is_worker=False) == ""
    assert Config.login_url(is_worker=True) == ""
    assert Config.login_credentials(is_worker=False) == ("", "")
    assert Config.login_credentials(is_worker=True) == ("", "")
