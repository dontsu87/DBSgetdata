# -*- coding: utf-8 -*-
"""スクレイパー失敗をSlackへ安全に通知する小さなアダプター。"""

import json
import os
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from src.config import Config


ALERT_COOLDOWN = timedelta(minutes=30)
JST = timezone(timedelta(hours=9))
STATE_PATH = Path(Config.OUTPUT_DIR) / "scraper_failure_alert.json"


def classify_failure(error) -> str:
    """例外を通知カテゴリへ分類します。例外本文は通知へ含めません。"""
    text = str(error or "").lower()
    if any(
        marker in text
        for marker in (
            "onedrive",
            "sharepoint",
            "共有リンク",
            "ゲストアクセス",
            "guestaccess",
        )
    ):
        return "onedrive_link"
    if any(marker in text for marker in ("認証コード", "mfa", "verification code")):
        return "mfa_code"
    if any(marker in text for marker in ("ポータル", "portal", "cognito", "session")):
        return "portal_auth"
    return "scraper"


REASONS = {
    "onedrive_link": (
        "MFA認証コードの共有リンクがOneDrive/SharePointのゲストアクセスまたは"
        "エラー画面を返し、ファイル本文を取得できませんでした。"
        "共有リンクの有効期限・リンク削除/権限・外部共有設定を確認してください。"
    ),
    "mfa_code": (
        "MFA認証コードを有効な状態で取得できませんでした。"
        "メール到着、本文形式、受信時刻、コードの有効期限を確認してください。"
    ),
    "portal_auth": "管理ポータルのセッションまたは再認証に失敗しました。",
    "scraper": "スクレイピング処理が失敗しました。タスクと直近ログを確認してください。",
}


def build_message(error, now=None) -> tuple[str, str]:
    """通知カテゴリと、秘密情報を含まないSlack本文を返します。"""
    category = classify_failure(error)
    current = now or datetime.now(JST)
    if current.tzinfo is None:
        current = current.replace(tzinfo=JST)
    message = (
        "⚠️ 【DBSスクレイパー障害】自動取得に失敗しました。\n"
        f"発生時刻: `{current.astimezone(JST).isoformat(timespec='seconds')}`\n"
        f"理由: {REASONS[category]}\n"
        "次回の定期実行で再試行します。"
    )
    return category, message


def _post(webhook_url: str, text: str) -> None:
    payload = json.dumps({"text": text}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        webhook_url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        response.read()


def _read_state(path: Path) -> dict:
    try:
        if path.exists():
            with path.open("r", encoding="utf-8") as handle:
                value = json.load(handle)
                return value if isinstance(value, dict) else {}
    except Exception:
        pass
    return {}


def _write_state(path: Path, category: str, now: datetime) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8") as handle:
            json.dump(
                {"category": category, "alerted_at": now.astimezone(timezone.utc).isoformat()},
                handle,
                ensure_ascii=False,
            )
    except Exception as error:
        print(f"Warning: Slack通知状態を保存できませんでした: {error}")


def notify_scraper_failure(error, *, webhook_url=None, state_path=None, now=None, sender=None) -> bool:
    """失敗理由をSlackへ通知します。通知済みの同一理由は30分抑止します。"""
    webhook_url = webhook_url or os.getenv("SLACK_WEBHOOK_URL", "")
    if not webhook_url:
        print("Warning: SLACK_WEBHOOK_URLが未設定のため、障害通知を送信できません。")
        return False

    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    category, message = build_message(error, current)
    path = Path(state_path) if state_path else STATE_PATH
    previous = _read_state(path)
    try:
        previous_at = datetime.fromisoformat(previous.get("alerted_at", ""))
        if previous.get("category") == category:
            if previous_at.tzinfo is None:
                previous_at = previous_at.replace(tzinfo=timezone.utc)
            if current - previous_at < ALERT_COOLDOWN:
                print(f"Info: 同じ障害理由のSlack通知を抑止しました（カテゴリ: {category}）。")
                return False
    except (TypeError, ValueError):
        pass

    try:
        (sender or _post)(webhook_url, message)
    except Exception as send_error:
        print(f"Warning: Slack障害通知の送信に失敗しました: {send_error}")
        return False

    _write_state(path, category, current)
    print(f"Info: Slackへ障害理由を通知しました（カテゴリ: {category}）。")
    return True
