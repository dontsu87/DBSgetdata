# -*- coding: utf-8 -*-
import json
from datetime import datetime, timezone

from src import monitor_dbs


NOW = datetime(2026, 8, 4, 9, 0, 0, tzinfo=timezone.utc)


def write_announcement(tmp_path, maintenance):
    path = tmp_path / "announcement.json"
    path.write_text(
        json.dumps({"maintenance": maintenance}, ensure_ascii=False),
        encoding="utf-8",
    )
    return path


def test_scraping_disabled_pauses_monitor_after_start(tmp_path):
    path = write_announcement(
        tmp_path,
        {
            "enabled": True,
            "scraping_disabled": True,
            "start_time": "2026-08-04T11:59:00+09:00",
        },
    )

    assert monitor_dbs.is_scraping_maintenance_active(path, NOW) is True


def test_frontend_only_maintenance_keeps_monitor_running(tmp_path):
    path = write_announcement(
        tmp_path,
        {
            "enabled": True,
            "scraping_disabled": False,
            "start_time": "2026-08-04T00:00:00+09:00",
        },
    )

    assert monitor_dbs.is_scraping_maintenance_active(path, NOW) is False


def test_legacy_enabled_flag_still_pauses_monitor(tmp_path):
    path = write_announcement(
        tmp_path,
        {
            "enabled": True,
            "start_time": "2026-08-04T00:00:00+09:00",
        },
    )

    assert monitor_dbs.is_scraping_maintenance_active(path, NOW) is True


def test_future_maintenance_does_not_pause_monitor(tmp_path):
    path = write_announcement(
        tmp_path,
        {
            "enabled": True,
            "scraping_disabled": True,
            "start_time": "2026-08-04T19:00:00+09:00",
        },
    )

    assert monitor_dbs.is_scraping_maintenance_active(path, NOW) is False


def test_invalid_maintenance_config_keeps_monitor_running(tmp_path, capsys):
    path = tmp_path / "announcement.json"
    path.write_text("{broken", encoding="utf-8")

    assert monitor_dbs.is_scraping_maintenance_active(path, NOW) is False
    assert "monitoring continues" in capsys.readouterr().err


def test_main_skips_before_requiring_slack_secret(tmp_path, monkeypatch, capsys):
    path = write_announcement(
        tmp_path,
        {
            "enabled": True,
            "scraping_disabled": True,
            "start_time": "2020-01-01T00:00:00+09:00",
        },
    )
    monkeypatch.setattr(monitor_dbs, "ANNOUNCEMENT_PATH", path)
    monkeypatch.delenv("SLACK_WEBHOOK_URL", raising=False)

    monitor_dbs.main()

    assert "Slack heartbeat alert is paused" in capsys.readouterr().out
