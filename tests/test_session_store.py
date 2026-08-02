# -*- coding: utf-8 -*-
import json
from pathlib import Path

from src import session_store


LOGIN_URL = (
    "https://mg-auth.docomo-cycle.jp/login?client_id=test"
    "&redirect_uri=https%3A%2F%2Fmg.docomo-cycle.jp%2F"
    "&response_type=code"
)


class FakeDriver:
    def __init__(self):
        self.urls = []
        self.cdp_calls = []
        self.script_calls = []

    def get(self, url):
        self.urls.append(url)

    def execute_cdp_cmd(self, command, params):
        self.cdp_calls.append((command, params))
        if command == "Network.getAllCookies":
            return {
                "cookies": [{
                    "name": "cognito", "value": "secret", "domain": ".mg-auth.docomo-cycle.jp",
                    "path": "/", "secure": True, "httpOnly": True, "expires": -1,
                }]
            }
        return {"success": True}

    def execute_script(self, script, *args):
        self.script_calls.append((script, args))
        if "return o" in script:
            return {"device": "value"}
        return None


def test_app_url_uses_clean_redirect_uri():
    assert session_store.app_url(LOGIN_URL) == "https://mg.docomo-cycle.jp/"
    assert "code=" not in session_store.app_url(LOGIN_URL)


def test_save_session_uses_cdp_and_never_saves_authorization_code(tmp_path, monkeypatch):
    monkeypatch.setattr(session_store.Config, "LOGIN_URL", LOGIN_URL)
    driver = FakeDriver()
    path = tmp_path / "dbs_session.json"

    payload = session_store.save_session(driver, path)

    assert payload["url"] == "https://mg.docomo-cycle.jp/"
    assert driver.cdp_calls[0][0] == "Network.getAllCookies"
    assert driver.urls[-1] == "https://mg.docomo-cycle.jp/"
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["all_cookies"][0]["value"] == "secret"
    assert "code=" not in saved["url"]


def test_restore_session_sets_all_cookies_and_storage(tmp_path, monkeypatch):
    monkeypatch.setattr(session_store.Config, "LOGIN_URL", LOGIN_URL)
    path = tmp_path / "dbs_session.json"
    path.write_text(json.dumps({
        "url": "https://mg.docomo-cycle.jp/?code=must-not-be-used",
        "all_cookies": [{
            "name": "cognito", "value": "secret", "domain": ".mg-auth.docomo-cycle.jp",
            "path": "/", "secure": True, "httpOnly": True, "expires": -1,
        }],
        "origins": {
            "https://mg-auth.docomo-cycle.jp/": {
                "localStorage": {"device": "abc"}, "sessionStorage": {},
            }
        },
    }), encoding="utf-8")
    driver = FakeDriver()

    assert session_store.restore_session(driver, path) is True
    set_cookie = [call for call in driver.cdp_calls if call[0] == "Network.setCookie"]
    assert len(set_cookie) == 1
    assert "expires" not in set_cookie[0][1]
    assert driver.urls[-1] == "https://mg.docomo-cycle.jp/"
    assert all("code=" not in url for url in driver.urls)
    assert any(args == ("device", "abc") for _, args in driver.script_calls)


def test_restore_session_returns_false_for_missing_or_invalid_file(tmp_path):
    driver = FakeDriver()
    assert session_store.restore_session(driver, tmp_path / "missing.json") is False

    invalid = tmp_path / "invalid.json"
    invalid.write_text("not json", encoding="utf-8")
    assert session_store.restore_session(driver, invalid) is False
