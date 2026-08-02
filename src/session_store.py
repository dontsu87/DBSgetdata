# -*- coding: utf-8 -*-
"""Cognito と管理ポータルにまたがるブラウザセッションの保存・復元。"""

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from src.config import Config


DEFAULT_APP_URL = "https://mg.docomo-cycle.jp/"
SESSION_FILE = Path(Config.OUTPUT_DIR) / "dbs_session.json"


def _origin(url: str) -> str:
    parsed = urlparse(url or "")
    if not parsed.scheme or not parsed.netloc:
        return ""
    return f"{parsed.scheme}://{parsed.netloc}/"


def app_url(login_url: str = "") -> str:
    """認可コードを含まない、復元先のアプリURLを返す。"""
    login_url = login_url or Config.login_url()
    parsed = urlparse(login_url)
    redirect = parse_qs(parsed.query).get("redirect_uri", [""])[0]
    return _origin(redirect) or DEFAULT_APP_URL


def session_origins(login_url: str = "") -> list[str]:
    """認証基盤とアプリのオリジンを、重複なしで返す。"""
    login_url = login_url or Config.login_url()
    values = [_origin(login_url), app_url(login_url)]
    return list(dict.fromkeys(value for value in values if value))


def _storage(driver, kind: str) -> dict:
    try:
        return driver.execute_script(
            f"const o={{}}; for(let i=0;i<{kind}.length;i++){{"
            f"const k={kind}.key(i); o[k]={kind}.getItem(k);}} return o;"
        ) or {}
    except Exception:
        return {}


def _cookie_for_cdp(cookie: dict) -> dict:
    allowed = (
        "name", "value", "domain", "path", "secure", "httpOnly",
        "expires", "sameSite",
    )
    item = {key: cookie[key] for key in allowed if key in cookie}
    if item.get("expires", 0) <= 0:
        item.pop("expires", None)
    return item


def _write_payload(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    os.replace(temporary, path)


def save_session(driver, path: Path = SESSION_FILE) -> dict:
    """全Cookieとオリジン別Web Storageを保存する。"""
    login_url = Config.login_url()
    target_url = app_url(login_url)
    cookies = driver.execute_cdp_cmd("Network.getAllCookies", {}).get("cookies", [])
    origins = {}

    for origin_url in session_origins(login_url):
        try:
            driver.get(origin_url)
            origins[origin_url] = {
                "localStorage": _storage(driver, "localStorage"),
                "sessionStorage": _storage(driver, "sessionStorage"),
            }
        except Exception as error:
            print(f"Warning: セッション保存時に {origin_url} を採取できません: {type(error).__name__}")

    # 認可コード付きURLには戻らず、必ずクリーンなアプリURLで終える。
    driver.get(target_url)
    payload = {
        "version": 1,
        "saved_at": datetime.now(timezone.utc).isoformat(),
        "url": target_url,
        "all_cookies": cookies,
        "origins": origins,
    }
    _write_payload(Path(path), payload)
    print(f"Info: セッションを保存しました（Cookie {len(cookies)} 件）: {path}")
    return payload


def restore_session(driver, path: Path = SESSION_FILE) -> bool:
    """保存済みセッションを復元する。無い・壊れている場合は False を返す。"""
    path = Path(path)
    if not path.is_file():
        return False

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        cookies = payload.get("all_cookies") or []
        origins = payload.get("origins") or {}
        target_url = app_url(Config.login_url())

        for cookie in cookies:
            result = driver.execute_cdp_cmd("Network.setCookie", _cookie_for_cdp(cookie))
            if isinstance(result, dict) and result.get("success") is False:
                raise RuntimeError(f"Cookieを復元できません: {cookie.get('name', '(unknown)')}")

        for origin_url, values in origins.items():
            if _origin(origin_url) != origin_url:
                continue
            driver.get(origin_url)
            for kind in ("localStorage", "sessionStorage"):
                for key, value in (values.get(kind) or {}).items():
                    driver.execute_script(
                        f"{kind}.setItem(arguments[0], arguments[1]);", key, value
                    )

        driver.get(target_url)
        print(f"Info: セッションを復元しました（Cookie {len(cookies)} 件）")
        return True
    except Exception as error:
        print(f"Warning: 保存済みセッションを復元できません: {type(error).__name__}")
        return False
