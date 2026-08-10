# -*- coding: utf-8 -*-
from unittest.mock import Mock

import pandas as pd
import pytest

import main
from src.new_portal_scraper import PortalApiError, PortalSessionError


def prepare(monkeypatch):
    monkeypatch.setattr(main.Config, "LOGIN_URL", "https://mg-auth.example/login")
    monkeypatch.setattr(main.Config, "RUN_MODE", "")
    monkeypatch.setattr(main.Config, "validate", Mock())
    monkeypatch.setattr(main, "should_skip_scrape", Mock(return_value=False))
    monkeypatch.setattr(
        main,
        "login_and_get_areas",
        Mock(side_effect=AssertionError("旧ログイン経路を呼んではいけません")),
    )


def test_run_scraping_valid_session_never_builds_browser(monkeypatch):
    prepare(monkeypatch)
    build_driver = Mock(side_effect=AssertionError("ブラウザを起動してはいけません"))
    monkeypatch.setattr(main, "build_driver", build_driver)
    authenticate = Mock()
    monkeypatch.setattr(main, "authenticate_new_portal", authenticate)
    frame = pd.DataFrame({"識別番号": ["A-001"]})
    scrape = Mock(return_value=frame)
    monkeypatch.setattr(main, "scrape_all_vehicles_http", scrape)
    finalize = Mock()
    monkeypatch.setattr(main, "_finalize_scraping", finalize)

    main.run_scraping(is_worker=False)

    scrape.assert_called_once_with()
    build_driver.assert_not_called()
    authenticate.assert_not_called()
    finalize.assert_called_once()
    assert finalize.call_args.args[0] == [frame]


def test_run_scraping_skips_during_post_full_cooldown(monkeypatch):
    prepare(monkeypatch)
    monkeypatch.setattr(main, "should_skip_scrape", Mock(return_value=True))
    scrape = Mock(side_effect=AssertionError("クールダウン中は取得しない"))
    monkeypatch.setattr(main, "scrape_all_vehicles_http", scrape)
    assert main.run_scraping(is_worker=False) is False
    scrape.assert_not_called()


def test_run_scraping_hourly_mode_removes_location_cap_and_sets_cooldown(monkeypatch):
    prepare(monkeypatch)
    monkeypatch.setattr(main, "should_fetch_all_locations", Mock(return_value=True))
    frame = pd.DataFrame({"識別番号": ["A-001"]})
    scrape = Mock(return_value=frame)
    monkeypatch.setattr(main, "scrape_all_vehicles_http", scrape)
    monkeypatch.setattr(main, "_finalize_scraping", Mock(return_value="output.csv"))
    update_cache = Mock()
    mark_completed = Mock()
    monkeypatch.setattr(main, "update_vehicle_location_cache", update_cache)
    monkeypatch.setattr(main, "mark_location_fetch_completed", mark_completed)

    assert main.run_scraping(is_worker=False) is True
    scrape.assert_called_once_with(
        include_port_vehicles=True,
        unlimited_location=True,
    )
    mark_completed.assert_called_once_with(
        main.Config.OUTPUT_DIR,
        cooldown_sec=main.Config.VEHICLE_LOCATION_POST_FULL_COOLDOWN_SEC,
    )

def test_run_scraping_auth_failure_refreshes_once_then_retries_http(monkeypatch):
    prepare(monkeypatch)
    driver = Mock()
    build_driver = Mock(return_value=driver)
    monkeypatch.setattr(main, "build_driver", build_driver)
    authenticate = Mock()
    monkeypatch.setattr(main, "authenticate_new_portal", authenticate)
    frame = pd.DataFrame({"識別番号": ["A-001"]})
    scrape = Mock(side_effect=[PortalSessionError("expired"), frame])
    monkeypatch.setattr(main, "scrape_all_vehicles_http", scrape)
    finalize = Mock()
    monkeypatch.setattr(main, "_finalize_scraping", finalize)

    main.run_scraping(is_worker=False)

    assert scrape.call_count == 2
    build_driver.assert_called_once_with()
    authenticate.assert_called_once_with(driver)
    driver.quit.assert_called_once_with()
    finalize.assert_called_once()


def test_run_scraping_second_auth_failure_does_not_loop(monkeypatch):
    prepare(monkeypatch)
    driver = Mock()
    monkeypatch.setattr(main, "build_driver", Mock(return_value=driver))
    monkeypatch.setattr(main, "authenticate_new_portal", Mock())
    scrape = Mock(side_effect=PortalSessionError("still expired"))
    monkeypatch.setattr(main, "scrape_all_vehicles_http", scrape)
    finalize = Mock()
    monkeypatch.setattr(main, "_finalize_scraping", finalize)

    with pytest.raises(PortalSessionError, match="still expired"):
        main.run_scraping(is_worker=False)

    assert scrape.call_count == 2
    main.build_driver.assert_called_once_with()
    main.authenticate_new_portal.assert_called_once_with(driver)
    driver.quit.assert_called_once_with()
    finalize.assert_not_called()


def test_run_scraping_authentication_error_still_quits_browser(monkeypatch):
    prepare(monkeypatch)
    driver = Mock()
    monkeypatch.setattr(main, "build_driver", Mock(return_value=driver))
    monkeypatch.setattr(
        main,
        "authenticate_new_portal",
        Mock(side_effect=RuntimeError("login failed")),
    )
    monkeypatch.setattr(
        main,
        "scrape_all_vehicles_http",
        Mock(side_effect=PortalSessionError("expired")),
    )
    finalize = Mock()
    monkeypatch.setattr(main, "_finalize_scraping", finalize)

    with pytest.raises(RuntimeError, match="login failed"):
        main.run_scraping(is_worker=False)

    driver.quit.assert_called_once_with()
    finalize.assert_not_called()


def test_run_scraping_non_auth_failure_never_builds_browser(monkeypatch):
    prepare(monkeypatch)
    build_driver = Mock(side_effect=AssertionError("ブラウザを起動してはいけません"))
    monkeypatch.setattr(main, "build_driver", build_driver)
    monkeypatch.setattr(
        main,
        "scrape_all_vehicles_http",
        Mock(side_effect=PortalApiError("HTTP 500")),
    )
    finalize = Mock()
    monkeypatch.setattr(main, "_finalize_scraping", finalize)

    with pytest.raises(PortalApiError, match="HTTP 500"):
        main.run_scraping(is_worker=False)

    build_driver.assert_not_called()
    finalize.assert_not_called()