# -*- coding: utf-8 -*-
"""Experimental browserless scraper kept separate from the production engine."""
from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from urllib.parse import urljoin

import pandas as pd
import requests
from bs4 import BeautifulSoup

from src.config import Config


@dataclass
class HttpArea:
    name: str
    form_index: int
    payload: list[tuple[str, str]]


class HttpScraperError(RuntimeError):
    pass


def _field_value(el):
    if el.name == "select":
        selected = el.find("option", selected=True) or el.find("option")
        return selected.get("value", "") if selected else ""
    if el.name == "textarea":
        return el.get_text()
    return el.get("value", "")


def _form_payload(form) -> list[tuple[str, str]]:
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


def _post_form(session: requests.Session, base_url: str, form, overrides=None):
    url = urljoin(base_url, form.get("action") or base_url)
    data = _form_payload(form)
    if overrides:
        override_names = {key for key, _ in overrides}
        data = [(key, value) for key, value in data if key not in override_names]
        data.extend(overrides)
    return session.post(url, data=data, timeout=40)


def _post_payload(session: requests.Session, url: str, payload, overrides=None):
    data = list(payload)
    if overrides:
        override_names = {key for key, _ in overrides}
        data = [(key, value) for key, value in data if key not in override_names]
        data.extend(overrides)
    return session.post(url, data=data, timeout=40)


def _make_session() -> requests.Session:
    session = requests.Session()
    # Codex sandbox can inject a blocked localhost proxy. Production can still set
    # proxies explicitly in code later if needed.
    session.trust_env = False
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120 Safari/537.36",
        "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
    })
    return session


def _find_submit_forms(soup: BeautifulSoup, value: str):
    return [
        form for form in soup.find_all("form")
        if form.find("input", {"type": "submit", "value": value})
    ]


def _area_name_from_form(form, fallback: int) -> str:
    tr = form.find_parent("tr")
    if tr:
        cells = [td.get_text(strip=True) for td in tr.find_all("td")]
        if len(cells) >= 2 and cells[0] and cells[1]:
            return f"{cells[0]}_{cells[1]}"
    return f"Area_{fallback + 1}"


def _parse_vehicle_rows(soup: BeautifulSoup, area_name: str) -> pd.DataFrame:
    rows = soup.select("#scroll_table > table > tbody > tr")
    records = []
    for row in rows:
        cells = row.find_all("td")
        if len(cells) >= 9:
            records.append({
                "エリア名": area_name,
                "識別番号": cells[1].get_text(strip=True),
                "車両状態": cells[3].get_text(strip=True),
                "ポート名": cells[4].get_text(strip=True),
                "電圧": cells[7].get_text(strip=True),
                "AT通知受信日時": cells[8].get_text(strip=True),
            })
    return pd.DataFrame.from_records(records, columns=[
        "エリア名", "識別番号", "車両状態", "ポート名", "電圧", "AT通知受信日時"
    ])


def _find_vehicle_form(soup: BeautifulSoup):
    forms = _find_submit_forms(soup, "車両情報")
    if not forms:
        return None
    return forms[0]


def _find_filter_form(soup: BeautifulSoup):
    for form in soup.find_all("form"):
        if form.find("select", {"name": "GetInfoNum"}):
            return form
    return None


def _hidden_value(form, name: str) -> str:
    el = form.find(attrs={"name": name})
    return el.get("value", "") if el else ""


def _collect_area(session: requests.Session, top_page: str, login_form, area: HttpArea, account: str, password: str) -> pd.DataFrame:
    # Keep each area independent, matching the production engine's conservative
    # re-login behavior and avoiding cross-area session drift during experiments.
    res = _post_form(session, top_page, login_form, [("Account", account), ("Password", password)])
    res.raise_for_status()
    soup = BeautifulSoup(res.text, "html.parser")
    area_forms = _find_submit_forms(soup, "トップ画面へ")
    if area.form_index >= len(area_forms):
        raise HttpScraperError(f"area form disappeared: {area.name}")

    res = _post_form(session, res.url, area_forms[area.form_index])
    res.raise_for_status()
    soup = BeautifulSoup(res.text, "html.parser")
    vehicle_form = _find_vehicle_form(soup)
    if not vehicle_form:
        raise HttpScraperError(f"vehicle form not found: {area.name}")

    res = _post_form(session, res.url, vehicle_form)
    res.raise_for_status()
    soup = BeautifulSoup(res.text, "html.parser")
    filter_form = _find_filter_form(soup)
    if filter_form:
        res = _post_form(session, res.url, filter_form, [("GetInfoNum", "500")])
        res.raise_for_status()
        soup = BeautifulSoup(res.text, "html.parser")

    frames = [_parse_vehicle_rows(soup, area.name)]

    # Pagination on this screen is driven by the same form state with GetInfoTopNum.
    # Most areas fit in one 500-row page, but keep bounded probing for larger areas.
    filter_form = _find_filter_form(soup)
    if filter_form:
        total_seen = len(frames[0])
        get_info_num = _hidden_value(filter_form, "GetInfoNum") or "500"
        try:
            page_size = int(get_info_num)
        except ValueError:
            page_size = 500

        for start in range(page_size, page_size * 20, page_size):
            # Only probe the next page if the current page looks full.
            if total_seen < start:
                break
            res = _post_form(session, res.url, filter_form, [("GetInfoNum", str(page_size)), ("GetInfoTopNum", str(start))])
            res.raise_for_status()
            soup_next = BeautifulSoup(res.text, "html.parser")
            df_next = _parse_vehicle_rows(soup_next, area.name)
            if df_next.empty:
                break
            frames.append(df_next)
            total_seen += len(df_next)
            filter_form = _find_filter_form(soup_next) or filter_form
            if len(df_next) < page_size:
                break

    if not frames:
        return pd.DataFrame()
    df = pd.concat(frames, ignore_index=True)
    if "識別番号" in df.columns:
        df = df.drop_duplicates(subset=["エリア名", "識別番号"], keep="first")
    return df


def run_http_scraping_experiment(is_worker=True) -> str:
    Config.validate(is_worker=is_worker)
    account = Config.WORKER_ACCOUNT if is_worker else Config.ACCOUNT
    password = Config.WORKER_PASSWORD if is_worker else Config.PASSWORD
    top_page = Config.WORKER_TOP_PAGE if is_worker else Config.TOP_PAGE

    session = _make_session()
    res = session.get(top_page, timeout=40)
    res.raise_for_status()
    soup = BeautifulSoup(res.text, "html.parser")
    login_form = soup.find("form")
    if not login_form:
        raise HttpScraperError("login form not found")

    res_login = _post_form(session, res.url, login_form, [("Account", account), ("Password", password)])
    res_login.raise_for_status()
    soup_login = BeautifulSoup(res_login.text, "html.parser")
    area_forms = _find_submit_forms(soup_login, "トップ画面へ")
    if not area_forms:
        raise HttpScraperError("area forms not found after login")

    areas = [HttpArea(_area_name_from_form(form, idx), idx, _form_payload(form)) for idx, form in enumerate(area_forms)]
    print(f"[HTTP Experiment] areas: {len(areas)}")

    frames = []
    errors = []
    for area in areas:
        print(f"[HTTP Experiment] scraping: {area.name}")
        try:
            df_area = _collect_area(session, res.url, login_form, area, account, password)
            frames.append(df_area)
            print(f"[HTTP Experiment] rows: {area.name} {len(df_area)}")
        except Exception as exc:
            errors.append({"area": area.name, "error": str(exc)})
            print(f"[HTTP Experiment] error: {area.name}: {exc}")

    combined = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=[
        "エリア名", "識別番号", "車両状態", "ポート名", "電圧", "AT通知受信日時"
    ])

    out_dir = Path(Config.OUTPUT_DIR) / "http_experimental"
    out_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    csv_path = out_dir / f"車両情報_http_{timestamp}.csv"
    combined.to_csv(csv_path, index=False, encoding="utf-8-sig")

    if errors:
        err_path = out_dir / f"車両情報_http_{timestamp}_errors.csv"
        pd.DataFrame(errors).to_csv(err_path, index=False, encoding="utf-8-sig")
        print(f"[HTTP Experiment] errors: {err_path}")

    print(f"[HTTP Experiment] saved: {csv_path}")
    print(f"[HTTP Experiment] total rows: {len(combined)}")
    return str(csv_path)