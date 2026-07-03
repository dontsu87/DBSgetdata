# -*- coding: utf-8 -*-
"""Probe management-screen traffic for possible requests-based scraping.

This module intentionally stores only sanitized request/form metadata. It does
not write cookies, credentials, raw HTML, or vehicle table contents.
"""
import json
import os
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC

from src.auth import Locators, login_and_get_areas
from src.browser import BrowserUtils, build_driver
from src.config import Config, ROOT_DIR
from src.scraper import open_vehicle_page, set_page_size_500

REDACTED = "<redacted>"


def _redact_url(url):
    if not url:
        return ""
    try:
        parts = urlsplit(url)
        query_pairs = parse_qsl(parts.query, keep_blank_values=True)
        redacted_query = urlencode([(key, REDACTED) for key, _ in query_pairs])
        return urlunsplit((parts.scheme, parts.netloc, parts.path, redacted_query, ""))
    except Exception:
        return REDACTED


def _redact_post_data(post_data):
    if not post_data:
        return None
    parsed = parse_qsl(post_data, keep_blank_values=True)
    if parsed:
        return {
            "type": "form",
            "fields": [{"name": key, "value": REDACTED} for key, _ in parsed],
        }
    return {"type": "raw", "length": len(post_data)}


def _capture_forms(driver):
    script = r"""
    return Array.from(document.forms || []).map((form, formIndex) => ({
      index: formIndex,
      method: (form.getAttribute('method') || 'GET').toUpperCase(),
      action: form.action || form.getAttribute('action') || '',
      fields: Array.from(form.querySelectorAll('input, select, textarea, button')).map((el, fieldIndex) => ({
        index: fieldIndex,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        name: el.getAttribute('name') || '',
        id: el.getAttribute('id') || '',
        value: el.name || el.id ? '<redacted>' : '',
        text: el.tagName.toLowerCase() === 'button' || el.type === 'submit' ? (el.innerText || el.value || '') : '',
        option_values: el.tagName.toLowerCase() === 'select'
          ? Array.from(el.options).map(opt => ({ value: '<redacted>', text: opt.text || '' }))
          : []
      }))
    }));
    """
    forms = driver.execute_script(script)
    for form in forms:
        form["action"] = _redact_url(form.get("action", ""))
    return forms


def _capture_page_state(driver, label):
    return {
        "label": label,
        "url": _redact_url(driver.current_url),
        "title": driver.title,
        "forms": _capture_forms(driver),
        "scroll_table_rows": len(driver.find_elements(By.CSS_SELECTOR, "#scroll_table > table > tbody > tr")),
        "links": [
            {"text": link.text.strip(), "href": _redact_url(link.get_attribute("href") or "")}
            for link in driver.find_elements(By.CSS_SELECTOR, "a")[:80]
        ],
    }


def _drain_performance_log(driver, sink):
    try:
        entries = driver.get_log("performance")
    except Exception as exc:
        sink.append({"event": "performance_log_unavailable", "error": str(exc)})
        return

    for entry in entries:
        try:
            message = json.loads(entry["message"])["message"]
            method = message.get("method")
            params = message.get("params", {})
        except Exception:
            continue

        if method == "Network.requestWillBeSent":
            request = params.get("request", {})
            sink.append({
                "event": "request",
                "request_id": params.get("requestId"),
                "resource_type": params.get("type"),
                "method": request.get("method"),
                "url": _redact_url(request.get("url", "")),
                "post_data": _redact_post_data(request.get("postData")),
            })
        elif method == "Network.responseReceived":
            response = params.get("response", {})
            sink.append({
                "event": "response",
                "request_id": params.get("requestId"),
                "resource_type": params.get("type"),
                "status": response.get("status"),
                "mime_type": response.get("mimeType"),
                "url": _redact_url(response.get("url", "")),
            })


def run_api_probe(is_worker=True):
    Config.validate(is_worker=is_worker)
    if is_worker:
        Config.ACCOUNT = Config.WORKER_ACCOUNT
        Config.PASSWORD = Config.WORKER_PASSWORD
        Config.TOP_PAGE = Config.WORKER_TOP_PAGE

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = Path(Config.OUTPUT_DIR) / f"api_probe_{timestamp}"
    out_dir.mkdir(parents=True, exist_ok=True)

    driver = build_driver(enable_performance_logging=True)
    network_events = []
    page_states = []
    result = {
        "created_at": timestamp,
        "mode": "worker" if is_worker else "admin",
        "notes": [
            "Cookie, credential values, query values, POST values, raw HTML, and table contents are not stored.",
            "Use this metadata to decide whether the same navigation can be replayed by requests.Session.",
        ],
    }

    try:
        try:
            driver.execute_cdp_cmd("Network.enable", {})
        except Exception:
            pass

        driver.get(Config.TOP_PAGE)
        _drain_performance_log(driver, network_events)
        page_states.append(_capture_page_state(driver, "login_page"))

        utils = BrowserUtils(driver)
        utils.W(utils.wait_long).until(EC.element_to_be_clickable(Locators.LOGIN_ACCOUNT)).send_keys(Config.ACCOUNT)
        utils.W(utils.wait_long).until(EC.element_to_be_clickable(Locators.LOGIN_PASSWORD)).send_keys(Config.PASSWORD)
        utils.W(utils.wait_short).until(EC.element_to_be_clickable(Locators.LOGIN_SUBMIT)).click()
        utils.W(utils.wait_long).until(EC.presence_of_element_located(Locators.BTN_TO_TOP))
        _drain_performance_log(driver, network_events)
        page_states.append(_capture_page_state(driver, "area_selection"))

        areas = login_and_get_areas(driver)
        _drain_performance_log(driver, network_events)
        result["area_count"] = len(areas)
        result["first_area_name"] = areas[0]["area_name"] if areas else None
        page_states.append(_capture_page_state(driver, "area_selection_after_relogin"))

        if areas:
            utils.click_js(areas[0]["element"])
            time.sleep(2)
            _drain_performance_log(driver, network_events)
            page_states.append(_capture_page_state(driver, "first_area_top"))

            if open_vehicle_page(driver):
                _drain_performance_log(driver, network_events)
                page_states.append(_capture_page_state(driver, "vehicle_page"))

                try:
                    set_page_size_500(driver)
                    _drain_performance_log(driver, network_events)
                    page_states.append(_capture_page_state(driver, "vehicle_page_size_500"))
                except Exception as exc:
                    result["page_size_500_error"] = str(exc)

        result["status"] = "ok"
    except Exception as exc:
        result["status"] = "error"
        result["error"] = str(exc)
    finally:
        try:
            _drain_performance_log(driver, network_events)
        except Exception:
            pass
        try:
            driver.quit()
        except Exception:
            pass

    result["page_states_file"] = "page_states.json"
    result["network_events_file"] = "network_events.json"
    (out_dir / "summary.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "page_states.json").write_text(json.dumps(page_states, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "network_events.json").write_text(json.dumps(network_events, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"[API Probe] summary: {out_dir / 'summary.json'}")
    print(f"[API Probe] page states: {out_dir / 'page_states.json'}")
    print(f"[API Probe] network events: {out_dir / 'network_events.json'}")
    return out_dir