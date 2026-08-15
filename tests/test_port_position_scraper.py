# -*- coding: utf-8 -*-
import json
from unittest.mock import Mock

from src import port_position_scraper as scraper
from src.new_portal_scraper import PortalApiError


def test_fetch_all_port_service_states_uses_only_area_and_bulk_gets(monkeypatch):
    calls = []

    def get_json(_session, url, **kwargs):
        calls.append((url, kwargs))
        if url.endswith("api/areas"):
            return [
                {"areaId": "area-1", "areaName": "敦賀"},
                {"areaId": "area-2", "areaName": "福井"},
            ]
        if kwargs.get("params") == {"areaIds": "area-1"}:
            return [
                {"portNameJa": "敦賀A", "serviceState": "運用中"},
                {"portNameJa": "敦賀B", "serviceState": "停止中"},
            ]
        return [{"portNameJa": "福井A", "serviceState": "運用中"}]

    monkeypatch.setattr(scraper, "_get_json", get_json)

    result = scraper.fetch_all_port_service_states(Mock(), "https://example.test/")

    assert result == {"敦賀A": "運用中", "敦賀B": "停止中", "福井A": "運用中"}
    assert len(calls) == 3
    assert all(
        url.endswith("api/areas") or url.endswith("api/ports/bulk")
        for url, _kwargs in calls
    )


def test_fetch_all_port_service_states_keeps_other_areas_on_partial_failure(monkeypatch):
    def get_json(_session, url, **kwargs):
        if url.endswith("api/areas"):
            return [
                {"areaId": "area-1", "areaName": "敦賀"},
                {"areaId": "area-2", "areaName": "福井"},
            ]
        if kwargs.get("params") == {"areaIds": "area-1"}:
            raise PortalApiError("HTTP 503")
        return [{"portNameJa": "福井A", "serviceState": "運用中"}]

    monkeypatch.setattr(scraper, "_get_json", get_json)

    assert scraper.fetch_all_port_service_states(Mock(), "https://example.test/") == {
        "福井A": "運用中"
    }


def test_fetch_all_port_service_states_raises_when_every_area_fails(monkeypatch):
    def get_json(_session, url, **_kwargs):
        if url.endswith("api/areas"):
            return [{"areaId": "area-1", "areaName": "敦賀"}]
        raise PortalApiError("HTTP 503")

    monkeypatch.setattr(scraper, "_get_json", get_json)

    import pytest

    with pytest.raises(PortalApiError, match="1件も取得できません"):
        scraper.fetch_all_port_service_states(Mock(), "https://example.test/")


def test_refresh_port_service_states_updates_only_matching_master_entries(
    monkeypatch, tmp_path
):
    master_path = tmp_path / "port_coords_master.json"
    master_path.write_text(
        json.dumps(
            {
                "敦賀A": {"lat": 35.0, "lon": 136.0, "service_state": "停止中"},
                "旧名ポート": {"lat": 36.0, "lon": 137.0, "service_state": "停止中"},
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    session = Mock()
    monkeypatch.setattr(scraper, "MASTER_PATH", master_path)
    monkeypatch.setattr(scraper, "build_http_session", Mock(return_value=session))
    monkeypatch.setattr(
        scraper,
        "fetch_all_port_service_states",
        Mock(return_value={"敦賀A": "運用中", "未登録ポート": "運用中"}),
    )

    assert scraper.refresh_port_service_states() == 1

    updated = json.loads(master_path.read_text(encoding="utf-8"))
    assert updated["敦賀A"] == {
        "lat": 35.0,
        "lon": 136.0,
        "service_state": "運用中",
    }
    assert updated["旧名ポート"]["service_state"] == "停止中"
    assert "未登録ポート" not in updated
    session.close.assert_called_once_with()
