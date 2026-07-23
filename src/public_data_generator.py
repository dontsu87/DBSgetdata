# -*- coding: utf-8 -*-
"""
利用者向け公開ポートデータ (public_ports.json / public_ports.js) の生成モジュール
作業員用データ（バッテリー電圧、アラート、車両ID等）は除外し、
「ポート位置」「ポート名（日本語/英語）」「利用可能台数 / ラック数」「エリア名」のみを軽量出力します。
"""
import os
import json
import re
from datetime import datetime, timezone, timedelta
from src.config import Config, ROOT_DIR

def get_port_name_en(port_name: str, station_id: str = "") -> str:
    """
    ポート名（日本語）から英語表示名を作成します。
    番号プレフィックス（例: "04." や "A1-"）を除去・整形し、
    必要に応じて外部マスタ (port_en_master.json) による上書きを可能にします。
    """
    # 外部マスタの読み込み (存在する場合)
    master_path = os.path.join(str(ROOT_DIR), "port_en_master.json")
    if os.path.exists(master_path):
        try:
            with open(master_path, "r", encoding="utf-8") as f:
                en_master = json.load(f)
                if port_name in en_master:
                    return en_master[port_name]
                if station_id and station_id in en_master:
                    return en_master[station_id]
        except Exception:
            pass

    # デフォルトの自動整形: 先頭の記号・番号プレフィックス（例 "04." "123_" "A1-" "A-01." 等）を除去
    clean_name = re.sub(r"^[A-Za-z0-9_\-]+[\._\-\s]+", "", port_name).strip()

    
    # 英語名が指定されていない場合、クリーンアップ後の名称を返す
    return clean_name or port_name

def generate_public_ports_data(ports_data: dict, gbfs_stations: list = None) -> tuple:
    """
    ports_data (dashboard_generator が集計したポートデータ) および GBFS ステーション情報から
    利用者用公開データを構築し、public_ports.json および public_ports.js に書き出します。

    戻り値:
        tuple (str, str): (json_path, js_path)
    """
    print("--- 利用者向け公開ポートデータの生成を開始します ---")
    
    # GBFS から station_id / name をキーとして capacity (ラック数) マッピングを作成
    capacity_map = {}
    if gbfs_stations:
        for s in gbfs_stations:
            cap = s.get("capacity", 0)
            s_name = s.get("name", "").strip()
            s_id_raw = s.get("station_id", "").strip()
            if s_name:
                capacity_map[s_name] = cap
            if s_id_raw:
                try:
                    s_id_fmt = f"{int(s_id_raw):08d}"
                    capacity_map[s_id_fmt] = cap
                except ValueError:
                    capacity_map[s_id_raw] = cap

    public_ports = []
    
    for port_name, p_info in ports_data.items():
        lat = p_info.get("lat")
        lon = p_info.get("lon")
        
        # 緯度・経度がないポートはマップにプロットできないため除外
        if lat is None or lon is None or lat == 0.0 or lon == 0.0:
            continue
            
        s_id = p_info.get("station_id", "")
        
        # ラック数の取得 (GBFSマッピング > デフォルト0)
        capacity = capacity_map.get(port_name) or capacity_map.get(s_id) or 0
        
        # 利用可能台数（車両状態が「利用可能」または「available」の車両のみをカウント）
        raw_bikes = p_info.get("bikes", [])
        if raw_bikes:
            available_bikes = [
                b for b in raw_bikes
                if str(b.get("status", "")).strip().lower() in ["利用可能", "available"]
            ]
            bikes_available = len(available_bikes)
        else:
            bikes_available = p_info.get("total_bikes", 0)
        
        # 容量補正: 利用可能台数がラック数を超えている場合はラック数を調整
        if bikes_available > capacity and capacity > 0:
            capacity = bikes_available


        port_en = get_port_name_en(port_name, s_id)
        
        public_ports.append({
            "station_id": s_id,
            "port_name": port_name,
            "port_name_en": port_en,
            "area_name": p_info.get("area_name", "その他"),
            "lat": round(float(lat), 6),
            "lon": round(float(lon), 6),
            "bikes_available": bikes_available,
            "capacity": capacity
        })

    # ポート名順でソート
    public_ports.sort(key=lambda x: x["port_name"])

    jst = timezone(timedelta(hours=9))
    updated_at_str = datetime.now(jst).strftime("%Y-%m-%d %H:%M:%S")

    payload = {
        "updated_at": updated_at_str,
        "total_ports": len(public_ports),
        "ports": public_ports
    }

    # 1. output/public_ports.json の生成
    os.makedirs(Config.OUTPUT_DIR, exist_ok=True)
    out_json_path = os.path.join(Config.OUTPUT_DIR, "public_ports.json")
    root_json_path = os.path.join(str(ROOT_DIR), "public_ports.json")
    
    try:
        with open(out_json_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        with open(root_json_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        print(f"Success: 利用者向け JSON を生成しました (全 {len(public_ports)} ポート): {out_json_path}")
    except Exception as e:
        print(f"Error: public_ports.json の書き出しに失敗しました: {e}")
        out_json_path = None

    # 2. output/public_ports.js の生成 (ローカル静的テスト用)
    out_js_path = os.path.join(Config.OUTPUT_DIR, "public_ports.js")
    root_js_path = os.path.join(str(ROOT_DIR), "public_ports.js")
    
    try:
        js_content = f"window.PUBLIC_PORTS_DATA = {json.dumps(payload, ensure_ascii=False, indent=2)};"
        with open(out_js_path, "w", encoding="utf-8") as f:
            f.write(js_content)
        with open(root_js_path, "w", encoding="utf-8") as f:
            f.write(js_content)
        print(f"Success: 利用者向け JS を生成しました: {out_js_path}")
    except Exception as e:
        print(f"Error: public_ports.js の書き出しに失敗しました: {e}")
        out_js_path = None

    return out_json_path, out_js_path
