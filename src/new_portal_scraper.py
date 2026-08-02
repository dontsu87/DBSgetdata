# -*- coding: utf-8 -*-
"""刷新後の管理ポータルから、読み取り専用GET APIで車両情報を取得する。"""

import json
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse

import pandas as pd
import requests

from src.session_store import SESSION_FILE, app_url


VEHICLE_STATE_LABELS = {
    "UNINSTALLATION": "AT未装着",
    "USABLE": "利用可能",
    "USING": "利用中",
    "PARKING": "一時駐輪",
    "RESERVATION": "予約中",
    "PLACEMENT": "配置中",
    "COLLECTION": "回収中",
    "NEEDS_COLLECTION": "要回収(重大申告)",
    "ABANDON": "ポート外乗り捨て",
    "MAINTENANCE_WAITING_FOR_AT_UPDATE": "メンテナンス(ATアップデート待ち)",
    "MANUAL_MAINTENANCE": "メンテナンス(手動)",
    "MANUAL_MAINTENANCE_NOTE": "メンテナンス(手動特記)",
    "ATTACHMENT_ABNORMAL": "AT異常全般",
    "SCRAPPED": "削除済み",
}

HTTP_TIMEOUT = (10, 30)
PAGE_SIZE = 500
MAX_PAGES = 1000


class PortalSessionError(RuntimeError):
    """保存セッションが無い、壊れている、または認証期限切れである。"""


class PortalApiError(RuntimeError):
    """認証以外の通信・API応答エラーである。"""


_READ_ONLY_FETCH_SCRIPT = r"""
const done = arguments[arguments.length - 1];
(async () => {
  const getJson = async (url) => {
    const response = await fetch(url, {method: 'GET', credentials: 'same-origin'});
    if (!response.ok) throw new Error(`GET ${url.split('?')[0]}: HTTP ${response.status}`);
    return await response.json();
  };
  const asList = (body) => body.dataList || body.items || body.data || body;

  const areas = asList(await getJson('/api/areas'));
  if (!Array.isArray(areas) || areas.length === 0) {
    throw new Error('取得可能なエリアがありません');
  }

  const rows = [];
  for (const area of areas) {
    let page = 1;
    let areaRows = 0;
    let areaTotal = null;
    while (areaTotal === null || areaRows < areaTotal) {
      if (page > 1000) throw new Error('車両一覧のページ数が上限を超えました');
      const query = new URLSearchParams({page: String(page), pageSize: '500'});
      query.append('affiliationAreaIds', area.areaId);
      const body = await getJson('/api/vehicles?' + query.toString());
      const vehicles = asList(body);
      if (!Array.isArray(vehicles)) throw new Error('車両一覧の形式が不正です');
      areaTotal = Number(body.pagination && body.pagination.total);
      if (!Number.isFinite(areaTotal)) areaTotal = areaRows + vehicles.length;

      for (const vehicle of vehicles) {
        rows.push({
          areaName: area.areaName || 'その他',
          vehicleUniqueCode: vehicle.vehicleUniqueCode ?? '',
          vehicleState: vehicle.vehicleState ?? '',
          portName: vehicle.portName ?? '',
          batteryElectricVoltage: vehicle.batteryElectricVoltage ?? null,
          dataReceivedTs: vehicle.dataReceivedTs ?? '',
        });
      }
      areaRows += vehicles.length;
      if (vehicles.length === 0 || areaRows >= areaTotal) break;
      page += 1;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  done({rows, areaCount: areas.length, total: rows.length});
})().catch(error => done({error: error.name + ': ' + error.message}));
"""

def _state_label(value: str) -> str:
    value = str(value or "").strip()
    return VEHICLE_STATE_LABELS.get(value, value)


def _safe_endpoint(url: str) -> str:
    """例外へCookieやクエリを混ぜず、APIパスだけを返す。"""
    return urlparse(url).path or "/"


def build_http_session(
    session_path: Path = SESSION_FILE,
    session_factory=requests.Session,
):
    """CDP保存形式のCookieを requests.Session へ復元する。"""
    path = Path(session_path)
    if not path.is_file():
        raise PortalSessionError("保存済みセッションがありません。")

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise PortalSessionError("保存済みセッションを読み込めません。") from None

    cookies = payload.get("all_cookies") if isinstance(payload, dict) else None
    if not isinstance(cookies, list) or not cookies:
        raise PortalSessionError("保存済みセッションにCookieがありません。")

    session = session_factory()
    try:
        for cookie in cookies:
            if not isinstance(cookie, dict):
                raise ValueError("cookie is not an object")
            name = cookie.get("name")
            value = cookie.get("value")
            if not isinstance(name, str) or not name or not isinstance(value, str):
                raise ValueError("cookie name/value is invalid")

            options = {
                "path": cookie.get("path") or "/",
                "secure": bool(cookie.get("secure", False)),
            }
            if cookie.get("domain"):
                options["domain"] = str(cookie["domain"])
            expires = cookie.get("expires")
            if isinstance(expires, (int, float)) and expires > 0:
                options["expires"] = int(expires)
            session.cookies.set(name, value, **options)
    except Exception as error:
        try:
            session.close()
        except Exception:
            pass
        raise PortalSessionError("保存済みセッションのCookie形式が不正です。") from None

    session.headers.update({"Accept": "application/json"})
    return session


def _get_json(http_session, url: str, *, params=None, timeout=HTTP_TIMEOUT):
    endpoint = _safe_endpoint(url)
    try:
        response = http_session.get(
            url,
            params=params,
            timeout=timeout,
            allow_redirects=False,
        )
    except requests.RequestException as error:
        raise PortalApiError(
            f"GET {endpoint} の通信に失敗しました: {type(error).__name__}"
        ) from None

    if response.status_code in (401, 403, 301, 302, 303, 307, 308):
        raise PortalSessionError(f"GET {endpoint}: 認証セッションが無効です。")
    if not 200 <= response.status_code < 300:
        raise PortalApiError(f"GET {endpoint}: HTTP {response.status_code}")

    try:
        return response.json()
    except ValueError as error:
        raise PortalApiError(f"GET {endpoint}: JSON応答が不正です。") from None


def _as_list(body):
    if isinstance(body, list):
        return body
    if not isinstance(body, dict):
        return body
    for key in ("dataList", "items", "data"):
        if key in body:
            return body[key]
    return body


def _frame_from_rows(rows) -> pd.DataFrame:
    source_columns = {
        "areaName": "エリア名",
        "vehicleUniqueCode": "識別番号",
        "vehicleState": "車両状態",
        "portName": "ポート名",
        "batteryElectricVoltage": "電圧",
        "dataReceivedTs": "AT通知受信日時",
    }
    frame = pd.DataFrame(rows)
    if frame.empty:
        return pd.DataFrame(columns=list(source_columns.values()))

    missing = set(source_columns) - set(frame.columns)
    if missing:
        raise PortalApiError(
            f"車両情報APIの必須項目が不足しています: {', '.join(sorted(missing))}"
        )
    frame = frame.rename(columns=source_columns)[list(source_columns.values())]
    frame["車両状態"] = frame["車両状態"].map(_state_label)
    frame["電圧"] = pd.to_numeric(frame["電圧"], errors="coerce")
    return frame.drop_duplicates(subset=["識別番号"], keep="last").reset_index(drop=True)


def scrape_all_vehicles_http(
    session_path: Path = SESSION_FILE,
    *,
    http_session=None,
    timeout=HTTP_TIMEOUT,
    sleep=time.sleep,
) -> pd.DataFrame:
    """保存Cookieを使い、Chromeを起動せず全エリアをGETのみで取得する。"""
    owns_session = http_session is None
    if owns_session:
        http_session = build_http_session(session_path)

    rows = []
    try:
        base_url = app_url()
        areas = _as_list(
            _get_json(http_session, urljoin(base_url, "api/areas"), timeout=timeout)
        )
        if not isinstance(areas, list) or not areas:
            raise PortalApiError("取得可能なエリアがありません。")

        for area in areas:
            if not isinstance(area, dict) or not area.get("areaId"):
                raise PortalApiError("エリア情報APIの必須項目が不足しています。")
            area_name = area.get("areaName") or "その他"
            area_rows = 0
            area_total = None

            for page in range(1, MAX_PAGES + 1):
                body = _get_json(
                    http_session,
                    urljoin(base_url, "api/vehicles"),
                    params={
                        "page": page,
                        "pageSize": PAGE_SIZE,
                        "affiliationAreaIds": area["areaId"],
                    },
                    timeout=timeout,
                )
                vehicles = _as_list(body)
                if not isinstance(vehicles, list):
                    raise PortalApiError("車両一覧APIの応答形式が不正です。")

                pagination = body.get("pagination") if isinstance(body, dict) else None
                if isinstance(pagination, dict):
                    try:
                        area_total = int(pagination.get("total"))
                    except (TypeError, ValueError):
                        area_total = None

                for vehicle in vehicles:
                    if not isinstance(vehicle, dict):
                        raise PortalApiError("車両一覧APIの応答形式が不正です。")
                    rows.append({
                        "areaName": area_name,
                        "vehicleUniqueCode": vehicle.get("vehicleUniqueCode", ""),
                        "vehicleState": vehicle.get("vehicleState", ""),
                        "portName": vehicle.get("portName", ""),
                        "batteryElectricVoltage": vehicle.get("batteryElectricVoltage"),
                        "dataReceivedTs": vehicle.get("dataReceivedTs", ""),
                    })
                area_rows += len(vehicles)

                if not vehicles or (area_total is not None and area_rows >= area_total):
                    break
                if area_total is None and len(vehicles) < PAGE_SIZE:
                    break
                sleep(0.25)
            else:
                raise PortalApiError("車両一覧のページ数が上限を超えました。")

        frame = _frame_from_rows(rows)
        print(
            "Success: 新管理ポータルから車両情報をHTTP取得しました"
            f"（エリア {len(areas)} / 車両 {len(frame)} 件）"
        )
        return frame
    finally:
        if owns_session:
            try:
                http_session.close()
            except Exception:
                pass


def scrape_all_vehicles(driver) -> pd.DataFrame:
    """認証済みブラウザで、全エリアの車両情報をGETのみで一括取得する。"""
    try:
        driver.set_script_timeout(180)
    except Exception:
        pass

    result = driver.execute_async_script(_READ_ONLY_FETCH_SCRIPT)
    if not isinstance(result, dict):
        raise RuntimeError("車両情報APIの応答形式が不正です。")
    if result.get("error"):
        raise RuntimeError(f"車両情報APIの取得に失敗しました: {result['error']}")

    rows = result.get("rows") or []
    frame = _frame_from_rows(rows)

    print(
        "Success: 新管理ポータルから車両情報を取得しました"
        f"（エリア {result.get('areaCount', 0)} / 車両 {len(frame)} 件）"
    )
    return frame
