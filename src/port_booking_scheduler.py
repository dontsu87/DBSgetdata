# -*- coding: utf-8 -*-
"""管理ポータルの2枠を使い、ポートごとの次回予約を安全に補充する。"""

from __future__ import annotations

import argparse
import csv
from contextlib import contextmanager
import hashlib
import json
import os
import sys
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote, urljoin, urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import requests

from src.config import Config
from src.new_portal_scraper import PortalSessionError, build_http_session
from src.session_store import SESSION_FILE, app_url


MAX_BOOKINGS = 2
DEFAULT_PLANNING_HORIZON_DAYS = 62
HTTP_TIMEOUT = 30
ALLOWED_SERVICE_STATES = {
    "運用中",
    "運用中（貸出制限中）",
    "一時駐輪用",
    "一時休止中",
    "停止中",
}
WEEKDAYS = {
    "MON": 0, "TUE": 1, "WED": 2, "THU": 3,
    "FRI": 4, "SAT": 5, "SUN": 6,
}
BOOKING_FIELDS = (
    "serviceState",
    "publishFlag",
    "parkingQuantityLimitationFlag",
)


class BookingConfigError(ValueError):
    pass


class BookingApiError(RuntimeError):
    pass


class BookingSessionError(BookingApiError):
    pass


class BookingBusyError(RuntimeError):
    pass


@dataclass(frozen=True)
class PlannedBooking:
    port_id: str
    port_label: str
    recipe_id: str
    event_id: str
    reflection_at: datetime
    state: dict[str, Any]

    @property
    def reflection_iso(self) -> str:
        return self.reflection_at.isoformat(timespec="seconds")

    def body(self) -> dict[str, Any]:
        value = {
            "updateReflectionDateTime": self.reflection_iso,
            **self.state,
        }
        if not value["parkingQuantityLimitationFlag"]:
            value.pop("parkingQuantityLimit", None)
        return value


def _require_dict(value: Any, where: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise BookingConfigError(f"{where} はオブジェクトで指定してください。")
    return value


def _require_port_id(value: Any, where: str) -> str:
    if not isinstance(value, str) or not value.startswith("PORT:"):
        raise BookingConfigError(f"{where}.port_id が不正です。")
    allowed = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:_-")
    if not value or any(character not in allowed for character in value):
        raise BookingConfigError(f"{where}.port_id が不正です。")
    return value


def load_config(path: str | Path) -> dict[str, Any]:
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise BookingConfigError("予約設定ファイルをUTF-8 JSONとして読み込めません。") from error
    root = _require_dict(value, "設定")
    if root.get("version") != 1:
        raise BookingConfigError("設定versionは1を指定してください。")
    recipes = _require_dict(root.get("recipes"), "recipes")
    ports = root.get("ports")
    if not recipes or not isinstance(ports, list) or not ports:
        raise BookingConfigError("recipesとportsを1件以上指定してください。")

    for recipe_id, recipe_value in recipes.items():
        recipe = _require_dict(recipe_value, f"recipes.{recipe_id}")
        try:
            ZoneInfo(str(recipe.get("timezone", "Asia/Tokyo")))
        except ZoneInfoNotFoundError as error:
            raise BookingConfigError(f"recipes.{recipe_id}.timezone が不正です。") from error
        recipe_type = recipe.get("type", "weekly_events")
        if recipe_type not in ("weekly_events", "facility_closure"):
            raise BookingConfigError(f"recipes.{recipe_id}.type が不正です。")
        events = recipe.get("events")
        if not isinstance(events, list) or not events:
            raise BookingConfigError(f"recipes.{recipe_id}.eventsを1件以上指定してください。")
        seen_ids: set[str] = set()
        for index, event_value in enumerate(events):
            event = _require_dict(event_value, f"recipes.{recipe_id}.events[{index}]")
            event_id = event.get("id")
            if not isinstance(event_id, str) or not event_id or event_id in seen_ids:
                raise BookingConfigError(f"recipes.{recipe_id}のevent idが不正または重複しています。")
            seen_ids.add(event_id)
            if recipe_type == "weekly_events" and str(event.get("weekday", "")).upper() not in WEEKDAYS:
                raise BookingConfigError(f"{event_id}.weekday はMONからSUNで指定してください。")
            try:
                parsed_time = datetime.strptime(str(event.get("time", "")), "%H:%M")
            except ValueError as error:
                raise BookingConfigError(f"{event_id}.time はHH:MMで指定してください。") from error
            if parsed_time.minute % 15:
                raise BookingConfigError(f"{event_id}.time は15分単位で指定してください。")
            state = _require_dict(event.get("state"), f"{event_id}.state")
            _validate_state_spec(state, event_id)
        horizon = recipe.get("planning_horizon_days", DEFAULT_PLANNING_HORIZON_DAYS)
        if isinstance(horizon, bool) or not isinstance(horizon, int) or not 1 <= horizon <= 366:
            raise BookingConfigError(f"recipes.{recipe_id}.planning_horizon_days は1から366で指定してください。")
        if recipe_type == "facility_closure":
            closure = _require_dict(recipe.get("closure"), f"recipes.{recipe_id}.closure")
            if str(closure.get("weekly_closed_weekday", "")).upper() not in WEEKDAYS:
                raise BookingConfigError(f"recipes.{recipe_id}.closure.weekly_closed_weekday が不正です。")
            if closure.get("holiday_shift") not in (None, "next_non_holiday_weekday"):
                raise BookingConfigError(f"recipes.{recipe_id}.closure.holiday_shift が不正です。")
            calendar = _require_dict(recipe.get("holiday_calendar"), f"recipes.{recipe_id}.holiday_calendar")
            if calendar.get("source") != "cabinet_office_csv" or not str(calendar.get("url", "")).startswith("https://www8.cao.go.jp/"):
                raise BookingConfigError(f"recipes.{recipe_id}.holiday_calendar は内閣府CSVを指定してください。")

    seen_ports: set[str] = set()
    for index, port_value in enumerate(ports):
        port = _require_dict(port_value, f"ports[{index}]")
        port_id = _require_port_id(port.get("port_id"), f"ports[{index}]")
        if port_id in seen_ports:
            raise BookingConfigError("同じport_idを複数回指定できません。")
        seen_ports.add(port_id)
        if port.get("recipe") not in recipes:
            raise BookingConfigError(f"ports[{index}].recipe がrecipesに存在しません。")
    return root


def _validate_state_spec(state: dict[str, Any], event_id: str) -> None:
    required = {
        "service_state",
        "publish_flag",
        "parking_quantity_limitation_flag",
    }
    if set(state) - (required | {"parking_quantity_limit"}):
        raise BookingConfigError(f"{event_id}.state に未知の項目があります。")
    if not required.issubset(state):
        raise BookingConfigError(f"{event_id}.state の必須項目が不足しています。")
    service = state["service_state"]
    if service != "inherit" and service not in ALLOWED_SERVICE_STATES:
        raise BookingConfigError(f"{event_id}.service_state が不正です。")
    for key in ("publish_flag", "parking_quantity_limitation_flag"):
        if state[key] != "inherit" and not isinstance(state[key], bool):
            raise BookingConfigError(f"{event_id}.{key} はtrue/false/inheritで指定してください。")
    limit = state.get("parking_quantity_limit", "inherit")
    if limit != "inherit" and (isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 32767):
        raise BookingConfigError(f"{event_id}.parking_quantity_limit が不正です。")


def _next_occurrence(now: datetime, weekday: int, time_text: str) -> datetime:
    hour, minute = (int(part) for part in time_text.split(":"))
    days = (weekday - now.weekday()) % 7
    candidate = now.replace(hour=hour, minute=minute, second=0, microsecond=0) + timedelta(days=days)
    if candidate <= now:
        candidate += timedelta(days=7)
    return candidate


def _parse_holiday_csv(content: bytes) -> tuple[set[date], date]:
    try:
        text = content.decode("cp932")
    except UnicodeDecodeError as error:
        raise BookingConfigError("内閣府祝日CSVをCP932として読めません。") from error
    holidays: set[date] = set()
    for row in csv.reader(text.splitlines()):
        if not row:
            continue
        try:
            holidays.add(datetime.strptime(row[0].strip(), "%Y/%m/%d").date())
        except ValueError:
            continue
    if not holidays:
        raise BookingConfigError("内閣府祝日CSVに日付がありません。")
    return holidays, max(holidays)


def load_holidays(recipe: dict[str, Any], through: date) -> set[date]:
    calendar = recipe["holiday_calendar"]
    cache_value = calendar.get("cache_path")
    cache_path = Path(cache_value) if cache_value else Path(Config.OUTPUT_DIR) / "cache" / "cabinet_office_holidays.csv"
    content: bytes | None = None
    try:
        request = urllib.request.Request(str(calendar["url"]), headers={"User-Agent": "DBSgetdata/port-booking-scheduler"})
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
            content = response.read()
        holidays, covered_through = _parse_holiday_csv(content)
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = cache_path.with_suffix(cache_path.suffix + ".tmp")
        temporary.write_bytes(content)
        os.replace(temporary, cache_path)
    except Exception as download_error:
        try:
            content = cache_path.read_bytes()
            holidays, covered_through = _parse_holiday_csv(content)
        except Exception as cache_error:
            raise BookingConfigError("内閣府祝日CSVを取得できず、有効なキャッシュもありません。") from download_error
    if covered_through < through:
        raise BookingConfigError(
            f"内閣府祝日CSVの収録期限({covered_through.isoformat()})が計画期間({through.isoformat()})に届きません。"
        )
    return holidays


def _time_value(text: str) -> time:
    return datetime.strptime(text, "%H:%M").time()


def _facility_events(recipe: dict[str, Any], local_now: datetime, holidays: set[date]) -> list[dict[str, Any]]:
    closure = recipe["closure"]
    horizon_end = local_now.date() + timedelta(days=recipe.get("planning_horizon_days", DEFAULT_PLANNING_HORIZON_DAYS))
    scan_start = local_now.date() - timedelta(days=8)
    scan_end = horizon_end + timedelta(days=8)
    closed_dates: set[date] = set()
    weekday = WEEKDAYS[str(closure["weekly_closed_weekday"]).upper()]
    cursor = scan_start
    while cursor <= scan_end:
        if cursor.weekday() == weekday:
            closed = cursor
            if cursor in holidays and closure.get("holiday_shift") == "next_non_holiday_weekday":
                closed += timedelta(days=1)
                while closed.weekday() >= 5 or closed in holidays:
                    closed += timedelta(days=1)
            closed_dates.add(closed)
        cursor += timedelta(days=1)

    year_end = closure.get("year_end_closure")
    if isinstance(year_end, dict):
        start_month, start_day = (int(value) for value in str(year_end["start"]).split("-"))
        end_month, end_day = (int(value) for value in str(year_end["end"]).split("-"))
        for year in range(scan_start.year - 1, scan_end.year + 1):
            start = date(year, start_month, start_day)
            end_year = year + 1 if (end_month, end_day) < (start_month, start_day) else year
            end = date(end_year, end_month, end_day)
            day = start
            while day <= end:
                if scan_start <= day <= scan_end:
                    closed_dates.add(day)
                day += timedelta(days=1)

    role_events = {str(event.get("role")): event for event in recipe["events"]}
    if set(role_events) != {"close", "reopen"}:
        raise BookingConfigError("facility_closureのeventsにはcloseとreopenを1件ずつ指定してください。")
    ordered = sorted(closed_dates)
    ranges: list[tuple[date, date]] = []
    for day in ordered:
        if ranges and day == ranges[-1][1] + timedelta(days=1):
            ranges[-1] = (ranges[-1][0], day)
        else:
            ranges.append((day, day))
    candidates = []
    for start, end in ranges:
        for role, event, event_day in (
            ("close", role_events["close"], start - timedelta(days=1)),
            ("reopen", role_events["reopen"], end + timedelta(days=1)),
        ):
            reflection_at = datetime.combine(event_day, _time_value(event["time"]), tzinfo=local_now.tzinfo)
            if local_now < reflection_at <= datetime.combine(horizon_end, time.max, tzinfo=local_now.tzinfo):
                candidates.append({**event, "id": f"{event['id']}:{start.isoformat()}", "reflection_at": reflection_at})
    return sorted(candidates, key=lambda item: (item["reflection_at"], item["id"]))


def planned_events(
    recipe_id: str,
    recipe: dict[str, Any],
    now: datetime,
    *,
    holiday_dates: set[date] | None = None,
) -> list[dict[str, Any]]:
    zone = ZoneInfo(str(recipe.get("timezone", "Asia/Tokyo")))
    local_now = now.replace(tzinfo=zone) if now.tzinfo is None else now.astimezone(zone)
    horizon_days = recipe.get("planning_horizon_days", DEFAULT_PLANNING_HORIZON_DAYS)
    horizon_end = local_now + timedelta(days=horizon_days)
    if recipe.get("type", "weekly_events") == "facility_closure":
        holidays = holiday_dates if holiday_dates is not None else load_holidays(recipe, horizon_end.date() + timedelta(days=8))
        return _facility_events(recipe, local_now, holidays)
    candidates = []
    for event in recipe["events"]:
        occurrence = _next_occurrence(local_now, WEEKDAYS[str(event["weekday"]).upper()], event["time"])
        while occurrence <= horizon_end:
            candidates.append({**event, "reflection_at": occurrence})
            occurrence += timedelta(days=7)
    return sorted(candidates, key=lambda item: (item["reflection_at"], item["id"]))


def next_events(recipe_id: str, recipe: dict[str, Any], now: datetime, *, holiday_dates: set[date] | None = None) -> list[dict[str, Any]]:
    selected = planned_events(recipe_id, recipe, now, holiday_dates=holiday_dates)[:MAX_BOOKINGS]
    if len(selected) < MAX_BOOKINGS:
        raise BookingConfigError(f"recipe {recipe_id} は次の予約を2件生成できません。")
    if len({item["reflection_at"] for item in selected}) != len(selected):
        raise BookingConfigError(f"recipe {recipe_id} の次回イベント日時が重複しています。")
    return selected


def _inherit_or_value(spec: Any, current: Any) -> tuple[Any, bool]:
    return (current, True) if spec == "inherit" else (spec, False)


def resolve_plans(
    port: dict[str, Any],
    recipe_id: str,
    recipe: dict[str, Any],
    current: dict[str, Any],
    now: datetime,
    *,
    include_horizon: bool = False,
    holiday_dates: set[date] | None = None,
) -> list[PlannedBooking]:
    mapping = {
        "service_state": "serviceState",
        "publish_flag": "publishFlag",
        "parking_quantity_limitation_flag": "parkingQuantityLimitationFlag",
    }
    plans = []
    events = planned_events(recipe_id, recipe, now, holiday_dates=holiday_dates) if include_horizon else next_events(
        recipe_id, recipe, now, holiday_dates=holiday_dates
    )
    for event in events:
        resolved: dict[str, Any] = {}
        for config_key, api_key in mapping.items():
            value, _ = _inherit_or_value(event["state"][config_key], current.get(api_key))
            resolved[api_key] = value
        if resolved["serviceState"] not in ALLOWED_SERVICE_STATES:
            raise BookingApiError("現在の運用状態を安全に継承できません。")
        if not isinstance(resolved["publishFlag"], bool) or not isinstance(resolved["parkingQuantityLimitationFlag"], bool):
            raise BookingApiError("現在の公開設定または駐輪台数制限を安全に継承できません。")
        if resolved["parkingQuantityLimitationFlag"]:
            limit_spec = event["state"].get("parking_quantity_limit", "inherit")
            limit, _ = _inherit_or_value(limit_spec, current.get("parkingQuantityLimit"))
            if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 32767:
                raise BookingApiError("駐輪台数上限を安全に継承できません。")
            resolved["parkingQuantityLimit"] = limit
        plans.append(PlannedBooking(
            port_id=port["port_id"],
            port_label=str(port.get("label") or port["port_id"]),
            recipe_id=recipe_id,
            event_id=event["id"],
            reflection_at=event["reflection_at"],
            state=resolved,
        ))
    return plans


def _parse_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _same_booking(actual: dict[str, Any], planned: PlannedBooking) -> bool:
    actual_time = _parse_datetime(actual.get("updateReflectionDateTime"))
    if actual_time is None or actual_time.astimezone(timezone.utc) != planned.reflection_at.astimezone(timezone.utc):
        return False
    expected = planned.body()
    for key in BOOKING_FIELDS:
        if actual.get(key) != expected[key]:
            return False
    if expected.get("parkingQuantityLimitationFlag") and actual.get("parkingQuantityLimit") != expected.get("parkingQuantityLimit"):
        return False
    return True


def _at_same_time(actual: dict[str, Any], planned: PlannedBooking) -> bool:
    actual_time = _parse_datetime(actual.get("updateReflectionDateTime"))
    return bool(actual_time and actual_time.astimezone(timezone.utc) == planned.reflection_at.astimezone(timezone.utc))


def public_booking_summary(item: dict[str, Any]) -> dict[str, Any]:
    """公開画面へ渡してよい予約項目だけを抜き出す。"""
    return {
        "update_reflection_datetime": item.get("updateReflectionDateTime"),
        "service_state": item.get("serviceState"),
        "publish_flag": item.get("publishFlag"),
        "parking_quantity_limitation_flag": item.get("parkingQuantityLimitationFlag"),
        "parking_quantity_limit": item.get("parkingQuantityLimit"),
    }


def public_planned_summary(plan: PlannedBooking, actual: list[dict[str, Any]], portal_window: bool) -> dict[str, Any]:
    if any(_same_booking(item, plan) for item in actual):
        reflection_status = "reflected"
    elif any(_at_same_time(item, plan) for item in actual):
        reflection_status = "mismatch"
    else:
        reflection_status = "missing" if portal_window else "queued"
    return {
        "update_reflection_datetime": plan.reflection_iso,
        "service_state": plan.state.get("serviceState"),
        "publish_flag": plan.state.get("publishFlag"),
        "parking_quantity_limitation_flag": plan.state.get("parkingQuantityLimitationFlag"),
        "parking_quantity_limit": plan.state.get("parkingQuantityLimit"),
        "reflection_status": reflection_status,
    }


class PortalBookingClient:
    def __init__(self, http_session=None, base_url: str | None = None, timeout: int = HTTP_TIMEOUT):
        try:
            self.session = http_session or build_http_session(SESSION_FILE)
        except PortalSessionError as error:
            raise BookingSessionError("保存済みセッションが無効です。") from error
        self._owns_session = http_session is None
        self.base_url = base_url or app_url()
        self.timeout = timeout

    def close(self) -> None:
        if self._owns_session:
            self.session.close()

    def _json(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        endpoint = urlparse(path).path
        try:
            response = self.session.request(
                method,
                urljoin(self.base_url, path.lstrip("/")),
                json=body,
                timeout=self.timeout,
                allow_redirects=False,
            )
        except requests.RequestException as error:
            raise BookingApiError(f"{method} {endpoint} の通信に失敗しました。") from error
        if response.status_code in (401, 403, 301, 302, 303, 307, 308):
            raise BookingSessionError(f"{method} {endpoint}: 認証セッションが無効です。")
        if not 200 <= response.status_code < 300:
            raise BookingApiError(f"{method} {endpoint}: HTTP {response.status_code}")
        if not response.content:
            return None
        try:
            return response.json()
        except ValueError as error:
            raise BookingApiError(f"{method} {endpoint}: JSON応答が不正です。") from error

    @staticmethod
    def _port_path(port_id: str) -> str:
        _require_port_id(port_id, "API")
        return quote(port_id, safe=":_-")

    def get_port(self, port_id: str) -> dict[str, Any]:
        body = self._json("GET", f"/api/ports/{self._port_path(port_id)}")
        if not isinstance(body, dict):
            raise BookingApiError("ポート詳細の応答形式が不正です。")
        return body

    def get_bookings(self, port_id: str) -> list[dict[str, Any]]:
        body = self._json("GET", f"/api/ports/{self._port_path(port_id)}/bookings")
        if not isinstance(body, list) or any(not isinstance(item, dict) for item in body):
            raise BookingApiError("予約一覧の応答形式が不正です。")
        return body

    def create_booking(self, planned: PlannedBooking) -> Any:
        return self._json(
            "POST",
            f"/api/ports/{self._port_path(planned.port_id)}/bookings",
            planned.body(),
        )


def reconcile_port(
    port: dict[str, Any],
    recipe_id: str,
    recipe: dict[str, Any],
    client: PortalBookingClient,
    now: datetime,
    apply: bool,
) -> dict[str, Any]:
    label = str(port.get("label") or port["port_id"])
    current = client.get_port(port["port_id"])
    if current.get("portId") not in (None, port["port_id"]):
        return {"port": label, "status": "conflict", "reason": "port_identity_mismatch"}
    bookings = client.get_bookings(port["port_id"])
    all_plans = resolve_plans(port, recipe_id, recipe, current, now, include_horizon=True)
    plans = all_plans[:MAX_BOOKINGS]
    def with_bookings(value: dict[str, Any], source: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        actual = bookings if source is None else source
        return {
            **value,
            "booking_count": len(actual),
            "bookings": [public_booking_summary(item) for item in actual],
            "schedule": [
                public_planned_summary(plan, actual, index < MAX_BOOKINGS)
                for index, plan in enumerate(all_plans)
            ],
        }
    if len(bookings) > MAX_BOOKINGS:
        return with_bookings({"port": label, "status": "conflict", "reason": "too_many_bookings"})
    expected_summary = [
        {"event": plan.event_id, "reflection_at": plan.reflection_iso}
        for plan in plans
    ]

    expected_times = {plan.reflection_at.astimezone(timezone.utc) for plan in plans}
    unexpected = [
        item for item in bookings
        if (_parse_datetime(item.get("updateReflectionDateTime")) is None
            or _parse_datetime(item["updateReflectionDateTime"]).astimezone(timezone.utc) not in expected_times)
    ]
    if unexpected:
        return with_bookings({"port": label, "status": "conflict", "reason": "unexpected_booking", "expected": expected_summary})

    missing = []
    for plan in plans:
        at_time = [item for item in bookings if _at_same_time(item, plan)]
        if len(at_time) > 1:
            return with_bookings({"port": label, "status": "conflict", "reason": "duplicate_booking_time"})
        if at_time and not _same_booking(at_time[0], plan):
            return with_bookings({
                "port": label,
                "status": "conflict",
                "reason": "booking_current_value_drift",
                "event": plan.event_id,
                "expected": expected_summary,
            })
        if not at_time:
            missing.append(plan)

    if len(bookings) + len(missing) > MAX_BOOKINGS:
        return with_bookings({"port": label, "status": "conflict", "reason": "booking_capacity"})
    if not apply:
        return with_bookings({
            "port": label,
            "status": "planned" if missing else "in_sync",
            "missing": [plan.event_id for plan in missing],
            "expected": expected_summary,
        })

    created = []
    for plan in missing:
        latest = client.get_bookings(port["port_id"])
        if any(not any(_same_booking(item, expected) for expected in plans) for item in latest):
            return with_bookings({"port": label, "status": "conflict", "reason": "booking_changed_before_create", "created": created}, latest)
        if any(_same_booking(item, plan) for item in latest):
            continue
        if len(latest) >= MAX_BOOKINGS:
            return with_bookings({"port": label, "status": "conflict", "reason": "booking_capacity", "created": created}, latest)
        try:
            client.create_booking(plan)
        except BookingApiError:
            # 応答喪失時の二重登録を防ぐ。反映済みなら成功として扱う。
            after_error = client.get_bookings(port["port_id"])
            if not any(_same_booking(item, plan) for item in after_error):
                raise
        verified = client.get_bookings(port["port_id"])
        if not any(_same_booking(item, plan) for item in verified):
            raise BookingApiError("予約登録後の再取得で完全一致を確認できません。")
        created.append(plan.event_id)
    final_bookings = client.get_bookings(port["port_id"])
    return with_bookings({
        "port": label,
        "status": "created" if created else "in_sync",
        "created": created,
        "expected": expected_summary,
    }, final_bookings)


def notify_alerts(
    alerts: list[dict[str, Any]],
    *,
    webhook_url: str | None = None,
    state_path: str | Path | None = None,
    sender: Callable[[str, str], None] | None = None,
    now: datetime | None = None,
) -> str:
    if not alerts:
        return "not_needed"
    webhook = webhook_url if webhook_url is not None else os.getenv("SLACK_WEBHOOK_URL", "")
    if not webhook:
        return "unavailable"
    summaries = sorted(f"{item.get('port', 'unknown')}:{item.get('reason', 'error')}" for item in alerts)
    fingerprint = hashlib.sha256("\n".join(summaries).encode("utf-8")).hexdigest()
    path = Path(state_path) if state_path else Path(Config.OUTPUT_DIR) / "port_booking_alert.json"
    previous = {}
    try:
        previous = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    except (OSError, UnicodeError, json.JSONDecodeError):
        previous = {}
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    try:
        previous_at = datetime.fromisoformat(str(previous.get("alerted_at", "")))
        if previous.get("fingerprint") == fingerprint and current - previous_at < timedelta(minutes=30):
            return "suppressed"
    except (TypeError, ValueError):
        pass
    message = "⚠️ 【DBSポート予約】自動更新を停止しました。\n" + "\n".join(
        f"・{summary}" for summary in summaries
    ) + "\n管理ポータルの予約内容と現在値を確認してください。"

    def default_sender(url: str, text: str) -> None:
        request = urllib.request.Request(
            url,
            data=json.dumps({"text": text}, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            response.read()

    try:
        (sender or default_sender)(webhook, message)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"fingerprint": fingerprint, "alerted_at": current.isoformat()}, ensure_ascii=False, indent=2), encoding="utf-8")
        return "sent"
    except Exception:
        return "failed"


@contextmanager
def scheduler_lock(path: str | Path):
    """同じ端末上の多重起動を、プロセス存続中だけ排他する。"""
    lock_path = Path(path)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = lock_path.open("a+b")
    try:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise BookingBusyError("別プロセスでポート予約を確認中です。") from error
        yield
    finally:
        try:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        handle.close()


def write_run_result(path: str | Path, result: dict[str, Any]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    payload = {"recorded_at": datetime.now(timezone.utc).isoformat(), **result}
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, target)


def write_public_status(path: str | Path, result: dict[str, Any]) -> None:
    """内部IDや通知理由を含めず、URL表示用の最小スナップショットを書く。"""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    payload = {
        "version": 2,
        "updated_at": result.get("checked_at"),
        "ports": [
            {
                "name": item.get("port"),
                "status": item.get("status"),
                "booking_count": item.get("booking_count", len(item.get("bookings", []))),
                "bookings": item.get("bookings", []),
                "schedule": item.get("schedule", item.get("bookings", [])),
            }
            for item in result.get("results", [])
            if item.get("status") not in ("disabled", "error")
        ],
    }
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, target)


def run_scheduler(
    config: dict[str, Any],
    *,
    now: datetime | None = None,
    apply: bool = False,
    client_factory: Callable[[], PortalBookingClient] = PortalBookingClient,
    notify: bool = True,
    notifier: Callable[[list[dict[str, Any]]], str] | None = None,
) -> dict[str, Any]:
    current = now or datetime.now(timezone.utc)
    results = []
    try:
        client = client_factory()
    except BookingSessionError:
        results = [
            {"port": str(port.get("label") or port["port_id"]), "status": "error", "reason": "session_error"}
            for port in config["ports"] if port.get("enabled", True) is not False
        ]
        alerts = list(results)
        notification = "disabled"
        if notify:
            notification = (notifier or notify_alerts)(alerts)
        return {
            "mode": "apply" if apply else "read_only",
            "checked_at": current.astimezone(timezone.utc).isoformat(),
            "results": results,
            "notification": notification,
        }
    try:
        for port in config["ports"]:
            if port.get("enabled", True) is False:
                results.append({"port": str(port.get("label") or port["port_id"]), "status": "disabled"})
                continue
            recipe_id = port["recipe"]
            try:
                results.append(reconcile_port(port, recipe_id, config["recipes"][recipe_id], client, current, apply))
            except BookingApiError:
                results.append({"port": str(port.get("label") or port["port_id"]), "status": "error", "reason": "portal_api_error"})
    finally:
        client.close()
    alerts = [item for item in results if item["status"] in ("conflict", "error")]
    notification = "disabled"
    if notify:
        notification = (notifier or notify_alerts)(alerts)
    return {
        "mode": "apply" if apply else "read_only",
        "checked_at": current.astimezone(timezone.utc).isoformat(),
        "results": results,
        "notification": notification,
    }


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="管理ポータルのポート予約を照合・補充します。")
    parser.add_argument("--config", required=True, help="UTF-8 JSON設定ファイル")
    parser.add_argument("--apply", action="store_true", help="不足予約を空き枠へ登録する")
    parser.add_argument("--no-notify", action="store_true", help="Slack通知を行わない")
    parser.add_argument("--state-output", help="照合結果JSONの保存先")
    parser.add_argument("--public-status-output", help="URL表示用JSONの保存先")
    parser.add_argument("--publish-status", action="store_true", help="URL表示用JSONをR2へ公開する")
    args = parser.parse_args(argv)
    try:
        config = load_config(args.config)
        output_root = Path(Config.OUTPUT_DIR)
        with scheduler_lock(output_root / "port_booking_scheduler.lock"):
            result = run_scheduler(config, apply=args.apply, notify=not args.no_notify)
            write_run_result(
                args.state_output or output_root / "port_booking_scheduler_state.json",
                result,
            )
            public_status_path = Path(args.public_status_output) if args.public_status_output else output_root / "port_booking_status.json"
            write_public_status(public_status_path, result)
            if args.publish_status:
                from src.upload_to_r2 import upload_file_to_r2
                if not upload_file_to_r2(
                    str(public_status_path),
                    "port_booking_status.json",
                    cache_control="public, max-age=60",
                ):
                    print(json.dumps({"status": "publish_error"}, ensure_ascii=False))
                    return 5
    except BookingConfigError as error:
        print(json.dumps({"status": "config_error", "message": str(error)}, ensure_ascii=False))
        return 2
    except BookingBusyError as error:
        print(json.dumps({"status": "busy", "message": str(error)}, ensure_ascii=False))
        return 4
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if any(item["status"] in ("conflict", "error") for item in result["results"]) else 0


if __name__ == "__main__":
    sys.exit(main())
