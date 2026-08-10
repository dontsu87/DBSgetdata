# -*- coding: utf-8 -*-
"""管理ポータルの読み取り専用GET APIから、ポートの緯度経度を取得し
port_coords_master.json を更新する。

GBFS配信（ドコモ・バイクシェアのシステム休止に伴い停止中）に依存せず、
ポータル自身が保持する位置情報を正の情報源として使う対症療法。

- `GET /api/ports/bulk?areaIds=<id>` はエリア内の全ポートを返すが、
  緯度経度を含まない（portId, portNameJa, serviceState 等のみ）。
- `GET /api/ports/{portId}` の個別詳細には
  `globalLocationLatitude` / `globalLocationLongitude` が含まれる。
  そのためポートごとに個別GETが必要（1エリアあたり数十〜百数十件）。

個別詳細には `serviceState`（例: "休止中"）・`publishFlag`・
`portAbolishDateTime` も含まれるため、あわせて保存する。現時点では
提供状態にかかわらず全ポートを表示に使うが、ドコモ・バイクシェアの
サービスが正常再開した際に「サービス提供ポートのみ表示」モードを
追加できるよう、判定に必要な生データをここで温存しておく
（フィルタ自体は未実装。判定基準はサービス再開時の実データを見て決める）。

すべてGETのみ。書き込み系リクエストは発行しない。
"""

import json
import os
import time
from pathlib import Path
from urllib.parse import urljoin

from src.config import Config, ROOT_DIR
from src.new_portal_scraper import (
    build_http_session,
    _get_json,
    _as_list,
    PortalApiError,
    PortalSessionError,
)
from src.session_store import app_url

MASTER_PATH = Path(str(ROOT_DIR)) / "port_coords_master.json"


def _format_station_id(value):
    try:
        return f"{int(value):08d}"
    except (TypeError, ValueError):
        text = str(value or "").strip()
        return text


def _load_master(path: Path = MASTER_PATH) -> dict:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_master(data: dict, path: Path = MASTER_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    os.replace(temporary, path)


def fetch_all_port_positions(http_session, base_url, *, delay_ms=100, timeout=None):
    """全エリアのポート詳細を巡回し、{ポート名: {lat, lon, area_name, station_id}} を返す。

    個別ポートの取得に失敗しても処理は継続し、取得できた分だけを返す。
    """
    kwargs = {} if timeout is None else {"timeout": timeout}

    areas = _as_list(_get_json(http_session, urljoin(base_url, "api/areas"), **kwargs))
    if not isinstance(areas, list):
        raise PortalApiError("エリア一覧の形式が不正です")

    results = {}
    fetched = 0
    failed = 0
    for area in areas:
        area_id = area.get("areaId") if isinstance(area, dict) else None
        if not area_id:
            continue
        area_name = str((area.get("areaName") if isinstance(area, dict) else "") or "").strip()

        try:
            ports = _as_list(_get_json(
                http_session, urljoin(base_url, "api/ports/bulk"),
                params={"areaIds": area_id}, **kwargs
            ))
        except (PortalApiError, PortalSessionError) as error:
            print(f"Warning: ポート一覧の取得に失敗しました（エリア: {area_name}）: {error}")
            continue
        if not isinstance(ports, list):
            continue

        for port in ports:
            if not isinstance(port, dict):
                continue
            port_id = port.get("portId")
            if not port_id:
                continue
            try:
                detail = _get_json(http_session, urljoin(base_url, f"api/ports/{port_id}"), **kwargs)
            except (PortalApiError, PortalSessionError) as error:
                failed += 1
                print(f"Warning: ポート詳細の取得に失敗しました（{port_id}）: {error}")
                continue
            finally:
                if delay_ms:
                    time.sleep(delay_ms / 1000)

            if not isinstance(detail, dict):
                continue
            name = str(detail.get("portNameJa") or "").strip()
            lat = detail.get("globalLocationLatitude")
            lon = detail.get("globalLocationLongitude")
            if not name or lat is None or lon is None:
                continue
            try:
                lat = float(lat)
                lon = float(lon)
            except (TypeError, ValueError):
                continue
            if lat == 0.0 or lon == 0.0:
                continue

            results[name] = {
                "lat": lat,
                "lon": lon,
                "area_name": area_name,
                "station_id": _format_station_id(detail.get("portUniqueCode")),
                "service_state": str(detail.get("serviceState") or "").strip(),
                "publish_flag": detail.get("publishFlag"),
                "port_abolish_date_time": detail.get("portAbolishDateTime"),
            }
            fetched += 1

    print(f"Info: ポータルAPIからポート位置を取得しました（成功 {fetched} 件 / 失敗 {failed} 件）。")
    return results


def refresh_port_coords_master(output_dir=None, *, session_path=None) -> int:
    """ポータルAPIからポート位置を取得し、port_coords_master.json へマージ保存する。

    既存エントリは、今回取得できたポート名だけを更新し、取得できなかった
    ポート（一時的なAPI失敗や対象外エリア）はそのまま残す。
    戻り値: 更新（追加・上書き）したポート数。
    """
    del output_dir  # 予約: 将来的にセッションファイル位置を変える場合に使用
    session_kwargs = {} if session_path is None else {"session_path": session_path}
    http_session = build_http_session(**session_kwargs)
    try:
        base_url = app_url()
        positions = fetch_all_port_positions(
            http_session, base_url,
            delay_ms=Config.PORT_POSITION_FETCH_DELAY_MS,
        )
    finally:
        http_session.close()

    if not positions:
        return 0

    master = _load_master()
    master.update(positions)
    _write_master(master)
    return len(positions)
