# -*- coding: utf-8 -*-
from unittest.mock import Mock

import pytest
from selenium.webdriver.common.by import By

from src import auth


LOGIN_URL = (
    "https://mg-auth.docomo-cycle.jp/login?client_id=test"
    "&redirect_uri=https%3A%2F%2Fmg.docomo-cycle.jp%2F"
    "&response_type=code"
)


class FakeElement:
    def __init__(self, driver, role, text=""):
        self.driver = driver
        self.role = role
        self.text = text
        self.value = ""

    def is_displayed(self):
        return True

    def get_attribute(self, name):
        return self.text if name == "value" else ""

    def clear(self):
        self.value = ""

    def send_keys(self, value):
        self.value = value

    def click(self):
        if self.role == "login_submit":
            self.driver.state = "mfa"
            self.driver.current_url = "https://mg-auth.docomo-cycle.jp/mfa/email/verify"
        elif self.role == "mfa_submit":
            self.driver.state = "app"
            self.driver.current_url = "https://mg.docomo-cycle.jp/"


class FakeDriver:
    def __init__(self, state="login"):
        self.state = state
        self.current_url = (
            "https://mg.docomo-cycle.jp/" if state == "app" else LOGIN_URL
        )
        self.username = FakeElement(self, "username")
        self.password = FakeElement(self, "password")
        self.code = FakeElement(self, "code")
        self.login_submit = FakeElement(self, "login_submit", "サインイン")
        self.mfa_submit = FakeElement(self, "mfa_submit", "サインイン")

    def get(self, url):
        self.current_url = url
        self.state = "login" if "mg-auth" in url else "app"

    def find_elements(self, by, value):
        assert by == By.CSS_SELECTOR
        if value == "input[name='username']":
            return [self.username] if self.state == "login" else []
        if value == "input[name='password']":
            return [self.password] if self.state == "login" else []
        if value == "input[name='code']":
            return [self.code] if self.state == "mfa" else []
        if value == "button[type='submit'], input[type='submit']":
            if self.state == "login":
                return [self.login_submit]
            if self.state == "mfa":
                return [self.mfa_submit]
        return []


def _configure(monkeypatch):
    monkeypatch.setattr(auth.Config, "LOGIN_URL", LOGIN_URL)
    monkeypatch.setattr(auth.Config, "LOGIN_EMAIL", "user@example.com")
    monkeypatch.setattr(auth.Config, "LOGIN_PASSWORD", "password")
    monkeypatch.setattr(auth.time, "sleep", lambda _: None)


def test_is_authenticated_uses_url_and_fields(monkeypatch):
    _configure(monkeypatch)
    assert auth.is_new_portal_authenticated(FakeDriver("app")) is True
    assert auth.is_new_portal_authenticated(FakeDriver("login")) is False
    driver = FakeDriver("mfa")
    driver.current_url = "https://mg.docomo-cycle.jp/"
    assert auth.is_new_portal_authenticated(driver) is False


def test_authenticate_reuses_valid_session(monkeypatch, tmp_path):
    _configure(monkeypatch)
    driver = FakeDriver("app")
    monkeypatch.setattr(auth, "restore_session", lambda *_: True)
    save = Mock()
    monkeypatch.setattr(auth, "save_session", save)

    assert auth.authenticate_new_portal(driver, tmp_path / "session.json") is True
    save.assert_not_called()


def test_authenticate_logs_in_with_mfa_and_saves(monkeypatch, tmp_path):
    _configure(monkeypatch)
    driver = FakeDriver("login")
    monkeypatch.setattr(auth, "restore_session", lambda *_: False)
    save = Mock()
    monkeypatch.setattr(auth, "save_session", save)
    provider = Mock(return_value="123456")
    path = tmp_path / "session.json"

    assert auth.authenticate_new_portal(driver, path, code_provider=provider) is True
    assert driver.username.value == "user@example.com"
    assert driver.password.value == "password"
    assert driver.code.value == "123456"
    provider.assert_called_once()
    assert "since" in provider.call_args.kwargs
    save.assert_called_once_with(driver, path)


def test_authenticate_rejects_non_email_login(monkeypatch, tmp_path):
    _configure(monkeypatch)
    monkeypatch.setattr(auth.Config, "LOGIN_EMAIL", "legacy-id")
    monkeypatch.setattr(auth, "restore_session", lambda *_: False)

    with pytest.raises(ValueError, match="DBS_LOGIN_EMAIL"):
        auth.authenticate_new_portal(FakeDriver("login"), tmp_path / "session.json")
