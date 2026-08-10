# -*- coding: utf-8 -*-
import json
from datetime import datetime, timezone

from src.failure_notifier import (
    build_message,
    classify_failure,
    notify_scraper_failure,
)


NOW = datetime(2026, 8, 10, 10, 0, 0, tzinfo=timezone.utc)


def test_classifies_onedrive_guest_error_without_using_raw_error():
    category = classify_failure(
        "OneDrive の画面が返りました。共有リンクのパスワードまたは有効期限を確認してください。"
    )
    assert category == "onedrive_link"

    _, message = build_message(RuntimeError("secret-token must not be sent"), now=NOW)
    assert "secret-token" not in message


def test_notifies_reason_and_records_state(tmp_path):
    sent = []

    def sender(url, text):
        sent.append((url, text))

    state_path = tmp_path / "scraper_failure_alert.json"
    assert notify_scraper_failure(
        RuntimeError("OneDrive の画面が返りました"),
        webhook_url="https://hooks.example.invalid/test",
        state_path=state_path,
        now=NOW,
        sender=sender,
    ) is True
    assert len(sent) == 1
    assert "共有リンク" in sent[0][1]
    assert "secret" not in sent[0][1]
    assert json.loads(state_path.read_text(encoding="utf-8"))["category"] == "onedrive_link"


def test_suppresses_same_reason_within_cooldown(tmp_path):
    sent = []
    sender = lambda url, text: sent.append(text)
    state_path = tmp_path / "scraper_failure_alert.json"
    error = RuntimeError("OneDrive の画面が返りました")

    assert notify_scraper_failure(
        error,
        webhook_url="https://hooks.example.invalid/test",
        state_path=state_path,
        now=NOW,
        sender=sender,
    ) is True
    assert notify_scraper_failure(
        error,
        webhook_url="https://hooks.example.invalid/test",
        state_path=state_path,
        now=NOW.replace(minute=20),
        sender=sender,
    ) is False
    assert len(sent) == 1


def test_missing_webhook_does_not_attempt_send(tmp_path, monkeypatch):
    called = []
    monkeypatch.delenv("SLACK_WEBHOOK_URL", raising=False)
    assert notify_scraper_failure(
        RuntimeError("failure"),
        webhook_url="",
        state_path=tmp_path / "state.json",
        now=NOW,
        sender=lambda url, text: called.append(text),
    ) is False
    assert called == []
