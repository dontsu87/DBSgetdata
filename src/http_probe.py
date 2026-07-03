# -*- coding: utf-8 -*-
"""Browserless HTTP probe for the Docomo Bike Share management screen."""
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

from src.config import Config


def _field_value(el):
    if el.name == "select":
        selected = el.find("option", selected=True) or el.find("option")
        return selected.get("value", "") if selected else ""
    if el.name == "textarea":
        return el.get_text()
    return el.get("value", "")


def _form_payload(form):
    payload = []
    for el in form.select("input, select, textarea"):
        name = el.get("name")
        if not name:
            continue
        typ = (el.get("type") or "").lower()
        if typ in {"submit", "button", "image", "file"}:
            continue
        if typ in {"checkbox", "radio"} and not el.has_attr("checked"):
            continue
        payload.append((name, _field_value(el)))
    return payload


def _post_form(session, base_url, form, payload=None):
    url = urljoin(base_url, form.get("action") or base_url)
    data = _form_payload(form)
    if payload:
        names = {key for key, _ in payload}
        data = [(key, value) for key, value in data if key not in names]
        data.extend(payload)
    return session.post(url, data=data, timeout=40)


def _find_submit_form(soup, value):
    for form in soup.find_all("form"):
        submit = form.find("input", {"type": "submit", "value": value})
        if submit:
            return form
    return None


def run_http_probe(is_worker=True):
    Config.validate(is_worker=is_worker)
    account = Config.WORKER_ACCOUNT if is_worker else Config.ACCOUNT
    password = Config.WORKER_PASSWORD if is_worker else Config.PASSWORD
    top_page = Config.WORKER_TOP_PAGE if is_worker else Config.TOP_PAGE

    session = requests.Session()
    session.trust_env = False
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120 Safari/537.36",
    })

    res = session.get(top_page, timeout=40)
    res.raise_for_status()
    soup = BeautifulSoup(res.text, "html.parser")
    login_form = soup.find("form")
    if not login_form:
        raise RuntimeError("login form not found")

    res = _post_form(session, res.url, login_form, [("Account", account), ("Password", password)])
    res.raise_for_status()
    soup = BeautifulSoup(res.text, "html.parser")
    area_forms = [form for form in soup.find_all("form") if form.find("input", {"type": "submit", "value": "トップ画面へ"})]
    print(f"[HTTP Probe] area forms: {len(area_forms)}")
    if not area_forms:
        print(res.text[:500])
        raise RuntimeError("area selection form not found after login")

    first_area = area_forms[0]
    tr = first_area.find_parent("tr")
    area_name = ""
    if tr:
        cells = [td.get_text(strip=True) for td in tr.find_all("td")]
        if len(cells) >= 2:
            area_name = f"{cells[0]}_{cells[1]}"
    print(f"[HTTP Probe] first area: {area_name or '(unknown)'}")

    res = _post_form(session, res.url, first_area)
    res.raise_for_status()
    soup = BeautifulSoup(res.text, "html.parser")
    vehicle_form = _find_submit_form(soup, "車両情報")
    if not vehicle_form:
        raise RuntimeError("vehicle info form not found")

    res = _post_form(session, res.url, vehicle_form)
    res.raise_for_status()
    soup = BeautifulSoup(res.text, "html.parser")
    rows = soup.select("#scroll_table > table > tbody > tr")
    print(f"[HTTP Probe] vehicle rows initial: {len(rows)}")

    filter_form = None
    for form in soup.find_all("form"):
        if form.find("select", {"name": "GetInfoNum"}):
            filter_form = form
            break
    if filter_form:
        res = _post_form(session, res.url, filter_form, [("GetInfoNum", "500")])
        res.raise_for_status()
        soup = BeautifulSoup(res.text, "html.parser")
        rows = soup.select("#scroll_table > table > tbody > tr")
        print(f"[HTTP Probe] vehicle rows after GetInfoNum=500: {len(rows)}")
    else:
        print("[HTTP Probe] GetInfoNum form not found")

    print("[HTTP Probe] browserless probe completed")
    return len(rows)