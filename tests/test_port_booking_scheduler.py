# -*- coding: utf-8 -*-
import json
from copy import deepcopy
from datetime import date, datetime, timezone

import pytest

from src.port_booking_scheduler import (
    _parse_holiday_csv,
    BookingApiError,
    BookingConfigError,
    BookingSessionError,
    load_config,
    next_events,
    notify_alerts,
    planned_events,
    resolve_plans,
    run_scheduler,
    write_public_status,
)


NOW = datetime(2026, 9, 11, 8, 0, tzinfo=timezone.utc)  # 17:00 JST Friday
PORT_1 = "PORT:TEST_1"
PORT_2 = "PORT:TEST_2"


def test_cabinet_csv_coverage_is_end_of_latest_listed_year():
    holidays, covered_through = _parse_holiday_csv("国民の祝日・休日月日,国民の祝日・休日名称\n2027/11/23,勤労感謝の日\n".encode("cp932"))
    assert holidays == {date(2027, 11, 23)}
    assert covered_through == date(2027, 12, 31)


def state(service="inherit", publish="inherit", parking="inherit", limit="inherit"):
    return {
        "service_state": service,
        "publish_flag": publish,
        "parking_quantity_limitation_flag": parking,
        "parking_quantity_limit": limit,
    }


def base_config():
    return {
        "version": 1,
        "recipes": {
            "closed_monday": {
                "timezone": "Asia/Tokyo",
                "events": [
                    {"id": "close", "weekday": "MON", "time": "00:00", "state": state("一時休止中")},
                    {"id": "open", "weekday": "TUE", "time": "00:00", "state": state("運用中")},
                ],
            }
        },
        "ports": [{"port_id": PORT_1, "label": "試験ポート", "recipe": "closed_monday"}],
    }


def current(port_id=PORT_1, **overrides):
    value = {
        "portId": port_id,
        "serviceState": "運用中",
        "publishFlag": True,
        "parkingQuantityLimitationFlag": False,
        "parkingQuantityLimit": 32767,
    }
    value.update(overrides)
    return value


class FakeClient:
    def __init__(self, ports=None, bookings=None, uncertain=False):
        self.ports = ports or {PORT_1: current()}
        self.bookings = bookings or {port_id: [] for port_id in self.ports}
        self.created = []
        self.uncertain = uncertain
        self.closed = False

    def get_port(self, port_id):
        return deepcopy(self.ports[port_id])

    def get_bookings(self, port_id):
        return deepcopy(self.bookings[port_id])

    def create_booking(self, planned):
        row = {"portId": planned.port_id, **planned.body()}
        if not row["parkingQuantityLimitationFlag"]:
            row["parkingQuantityLimit"] = 32767
        self.bookings[planned.port_id].append(row)
        self.created.append(row)
        if self.uncertain:
            raise BookingApiError("応答を受信できませんでした")
        return {}

    def close(self):
        self.closed = True


def plans_for(config, port_id=PORT_1, port_current=None):
    port = next(item for item in config["ports"] if item["port_id"] == port_id)
    recipe_id = port["recipe"]
    return resolve_plans(port, recipe_id, config["recipes"][recipe_id], port_current or current(port_id), NOW)


def test_next_two_events_are_close_then_reopen_in_jst():
    config = base_config()
    events = next_events("closed_monday", config["recipes"]["closed_monday"], NOW)

    assert [item["id"] for item in events] == ["close", "open"]
    assert [item["reflection_at"].isoformat() for item in events] == [
        "2026-09-14T00:00:00+09:00",
        "2026-09-15T00:00:00+09:00",
    ]


def facility_recipe():
    return {
        "type": "facility_closure",
        "timezone": "Asia/Tokyo",
        "planning_horizon_days": 62,
        "holiday_calendar": {
            "source": "cabinet_office_csv",
            "url": "https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv",
        },
        "closure": {
            "weekly_closed_weekday": "MON",
            "holiday_shift": "next_non_holiday_weekday",
            "year_end_closure": {"start": "12-29", "end": "01-03"},
        },
        "events": [
            {"id": "close", "role": "close", "time": "22:00", "state": state("一時休止中")},
            {"id": "reopen", "role": "reopen", "time": "10:00", "state": state("運用中")},
        ],
    }


def test_facility_closure_shifts_holiday_monday_to_next_non_holiday_weekday():
    holidays = {date(2026, 9, 21), date(2026, 9, 22), date(2026, 9, 23)}
    events = planned_events("facility", facility_recipe(), NOW, holiday_dates=holidays)
    values = [item["reflection_at"].isoformat() for item in events[:4]]
    assert values == [
        "2026-09-13T22:00:00+09:00",
        "2026-09-15T10:00:00+09:00",
        "2026-09-23T22:00:00+09:00",
        "2026-09-25T10:00:00+09:00",
    ]


def test_year_end_and_weekly_closure_are_merged_without_conflicting_transition():
    now = datetime(2026, 12, 27, 0, 0, tzinfo=timezone.utc)  # 09:00 JST
    events = planned_events("facility", facility_recipe(), now, holiday_dates={date(2027, 1, 1)})
    assert [item["reflection_at"].isoformat() for item in events[:2]] == [
        "2026-12-27T22:00:00+09:00",
        "2027-01-05T10:00:00+09:00",
    ]


def test_explicit_state_and_inherited_fields_are_resolved_per_event():
    config = base_config()
    plan = plans_for(config)[0]

    assert plan.body() == {
        "updateReflectionDateTime": "2026-09-14T00:00:00+09:00",
        "serviceState": "一時休止中",
        "publishFlag": True,
        "parkingQuantityLimitationFlag": False,
    }


def test_dry_run_only_reports_missing_bookings():
    config = base_config()
    client = FakeClient()

    result = run_scheduler(config, now=NOW, client_factory=lambda: client, apply=False, notify=False)

    assert result["mode"] == "read_only"
    port_result = result["results"][0]
    assert port_result["port"] == "試験ポート"
    assert port_result["status"] == "planned"
    assert port_result["missing"] == ["close", "open"]
    assert port_result["booking_count"] == 0
    assert port_result["bookings"] == []
    assert port_result["expected"] == [
        {"event": "close", "reflection_at": "2026-09-14T00:00:00+09:00"},
        {"event": "open", "reflection_at": "2026-09-15T00:00:00+09:00"},
    ]
    assert len(port_result["schedule"]) > 2
    assert client.created == []
    assert client.closed is True


def test_public_status_contains_only_display_fields(tmp_path):
    config = base_config()
    plan = plans_for(config)[0]
    booking = {"portId": PORT_1, **plan.body(), "parkingQuantityLimit": 32767}
    client = FakeClient(bookings={PORT_1: [booking]})
    result = run_scheduler(config, now=NOW, client_factory=lambda: client, apply=False, notify=False)
    path = tmp_path / "port_booking_status.json"

    write_public_status(path, result)

    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["version"] == 2
    assert payload["updated_at"] == "2026-09-11T08:00:00+00:00"
    assert set(payload["ports"][0]) == {"name", "status", "booking_count", "bookings", "schedule"}
    assert "portId" not in json.dumps(payload)
    assert payload["ports"][0]["bookings"][0]["service_state"] == "一時休止中"
    assert payload["ports"][0]["schedule"][0]["reflection_status"] == "reflected"
    assert payload["ports"][0]["schedule"][1]["reflection_status"] == "missing"
    assert payload["ports"][0]["schedule"][2]["reflection_status"] == "queued"


def test_apply_creates_and_verifies_two_missing_bookings():
    config = base_config()
    client = FakeClient()

    result = run_scheduler(config, now=NOW, client_factory=lambda: client, apply=True, notify=False)

    assert result["results"][0]["status"] == "created"
    assert result["results"][0]["created"] == ["close", "open"]
    assert len(client.bookings[PORT_1]) == 2


def test_inherited_current_value_drift_stops_without_update_and_notifies():
    config = base_config()
    expected = plans_for(config)[0]
    stale = {"portId": PORT_1, **expected.body(), "publishFlag": False, "parkingQuantityLimit": 32767}
    client = FakeClient(bookings={PORT_1: [stale]})
    alerts = []

    result = run_scheduler(
        config,
        now=NOW,
        client_factory=lambda: client,
        apply=True,
        notifier=lambda items: alerts.extend(items) or "sent",
    )

    assert result["results"][0]["status"] == "conflict"
    assert result["results"][0]["reason"] == "booking_current_value_drift"
    assert client.created == []
    assert alerts == [result["results"][0]]
    assert result["notification"] == "sent"


def test_inherited_parking_limit_drift_also_stops_without_update():
    config = base_config()
    before = current(parkingQuantityLimitationFlag=True, parkingQuantityLimit=20)
    expected = plans_for(config, port_current=before)[0]
    stale = {"portId": PORT_1, **expected.body()}
    after = current(parkingQuantityLimitationFlag=True, parkingQuantityLimit=25)
    client = FakeClient(ports={PORT_1: after}, bookings={PORT_1: [stale]})

    result = run_scheduler(config, now=NOW, client_factory=lambda: client, apply=True, notify=False)

    assert result["results"][0]["status"] == "conflict"
    assert result["results"][0]["reason"] == "booking_current_value_drift"
    assert client.created == []


def test_explicit_future_state_may_differ_from_current_without_conflict():
    config = base_config()
    plans = plans_for(config)
    bookings = [{"portId": PORT_1, **plan.body(), "parkingQuantityLimit": 32767} for plan in plans]
    client = FakeClient(bookings={PORT_1: bookings})

    result = run_scheduler(config, now=NOW, client_factory=lambda: client, apply=True, notify=False)

    assert result["results"][0]["status"] == "in_sync"
    assert client.created == []


def test_unexpected_user_booking_stops_the_whole_port():
    config = base_config()
    client = FakeClient(bookings={PORT_1: [{
        "portId": PORT_1,
        "updateReflectionDateTime": "2026-09-13T00:00:00+09:00",
        "serviceState": "運用中",
        "publishFlag": True,
        "parkingQuantityLimitationFlag": False,
        "parkingQuantityLimit": 32767,
    }]})

    result = run_scheduler(config, now=NOW, client_factory=lambda: client, apply=True, notify=False)

    assert result["results"][0]["reason"] == "unexpected_booking"
    assert client.created == []


def test_ambiguous_post_is_not_repeated_when_get_finds_exact_booking():
    config = base_config()
    client = FakeClient(uncertain=True)

    result = run_scheduler(config, now=NOW, client_factory=lambda: client, apply=True, notify=False)

    assert result["results"][0]["status"] == "created"
    assert len(client.created) == 2


def test_different_ports_can_use_different_recipes():
    config = base_config()
    config["recipes"]["friday"] = {
        "timezone": "Asia/Tokyo",
        "events": [{"id": "night", "weekday": "FRI", "time": "23:00", "state": state("停止中", False)}],
    }
    config["ports"].append({"port_id": PORT_2, "label": "別ポート", "recipe": "friday"})
    client = FakeClient(ports={PORT_1: current(), PORT_2: current(PORT_2)}, bookings={PORT_1: [], PORT_2: []})

    result = run_scheduler(config, now=NOW, client_factory=lambda: client, apply=False, notify=False)

    assert [item["port"] for item in result["results"]] == ["試験ポート", "別ポート"]
    assert result["results"][1]["missing"] == ["night", "night"]


def test_config_rejects_unknown_state_and_non_quarter_hour(tmp_path):
    config = base_config()
    config["recipes"]["closed_monday"]["events"][0]["state"]["service_state"] = "不明"
    path = tmp_path / "config.json"
    path.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(BookingConfigError, match="service_state"):
        load_config(path)

    config = base_config()
    config["recipes"]["closed_monday"]["events"][0]["time"] = "00:01"
    path.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(BookingConfigError, match="15分"):
        load_config(path)


def test_notification_is_deduplicated_for_thirty_minutes(tmp_path):
    sent = []
    alert = [{"port": "試験ポート", "status": "conflict", "reason": "unexpected_booking"}]
    state_path = tmp_path / "alert.json"

    first = notify_alerts(
        alert, webhook_url="https://hooks.example.invalid/test", state_path=state_path,
        sender=lambda url, text: sent.append((url, text)), now=NOW,
    )
    second = notify_alerts(
        alert, webhook_url="https://hooks.example.invalid/test", state_path=state_path,
        sender=lambda url, text: sent.append((url, text)), now=NOW.replace(minute=20),
    )

    assert first == "sent"
    assert second == "suppressed"
    assert len(sent) == 1
    assert "unexpected_booking" in sent[0][1]


def test_session_failure_is_reported_and_notified_for_each_enabled_port():
    config = base_config()
    config["ports"].append({"port_id": PORT_2, "label": "無効ポート", "recipe": "closed_monday", "enabled": False})
    alerts = []

    result = run_scheduler(
        config,
        now=NOW,
        client_factory=lambda: (_ for _ in ()).throw(BookingSessionError("invalid")),
        notifier=lambda items: alerts.extend(items) or "sent",
    )

    assert result["results"] == [{"port": "試験ポート", "status": "error", "reason": "session_error"}]
    assert alerts == result["results"]
    assert result["notification"] == "sent"
