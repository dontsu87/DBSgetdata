# -*- coding: utf-8 -*-
"""Compare production Selenium CSV output with experimental HTTP output."""
from __future__ import annotations

import glob
import os
from pathlib import Path

import pandas as pd

from src.config import Config

KEY = "識別番号"
COMPARE_COLUMNS = ["エリア名", "車両状態", "ポート名", "電圧", "AT通知受信日時"]


def _latest(pattern: str) -> str:
    files = sorted(glob.glob(pattern))
    return files[-1] if files else ""


def _normalize(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    for col in [KEY] + COMPARE_COLUMNS:
        if col in df.columns:
            df[col] = df[col].fillna("").astype(str).str.strip()
    if KEY in df.columns:
        df = df[df[KEY] != ""]
        df = df.drop_duplicates(subset=[KEY], keep="first")
    return df


def compare_latest_outputs(production_csv: str | None = None, http_csv: str | None = None) -> dict:
    production_csv = production_csv or _latest(os.path.join(Config.OUTPUT_DIR, "車両情報_*.csv"))
    http_csv = http_csv or _latest(os.path.join(Config.OUTPUT_DIR, "http_experimental", "車両情報_http_*.csv"))

    if not production_csv:
        raise FileNotFoundError("production CSV not found: 車両情報_*.csv")
    if not http_csv:
        raise FileNotFoundError("HTTP experiment CSV not found: http_experimental/車両情報_http_*.csv")

    prod = _normalize(pd.read_csv(production_csv, encoding="utf-8-sig"))
    http = _normalize(pd.read_csv(http_csv, encoding="utf-8-sig"))

    prod_ids = set(prod[KEY]) if KEY in prod.columns else set()
    http_ids = set(http[KEY]) if KEY in http.columns else set()
    common_ids = sorted(prod_ids & http_ids)
    missing_in_http = sorted(prod_ids - http_ids)
    extra_in_http = sorted(http_ids - prod_ids)

    prod_idx = prod.set_index(KEY, drop=False)
    http_idx = http.set_index(KEY, drop=False)
    column_diffs = {}
    for col in COMPARE_COLUMNS:
        if col not in prod_idx.columns or col not in http_idx.columns:
            continue
        diff_count = 0
        examples = []
        for bike_id in common_ids:
            a = str(prod_idx.at[bike_id, col])
            b = str(http_idx.at[bike_id, col])
            if a != b:
                diff_count += 1
                if len(examples) < 10:
                    examples.append({KEY: bike_id, "production": a, "http": b})
        column_diffs[col] = {"count": diff_count, "examples": examples}

    report = {
        "production_csv": production_csv,
        "http_csv": http_csv,
        "production_rows": len(prod),
        "http_rows": len(http),
        "common_ids": len(common_ids),
        "missing_in_http": len(missing_in_http),
        "extra_in_http": len(extra_in_http),
        "missing_in_http_examples": missing_in_http[:20],
        "extra_in_http_examples": extra_in_http[:20],
        "column_diffs": column_diffs,
    }
    return report


def print_compare_latest_outputs(production_csv: str | None = None, http_csv: str | None = None) -> dict:
    report = compare_latest_outputs(production_csv=production_csv, http_csv=http_csv)
    print(f"[Compare] production: {report['production_csv']}")
    print(f"[Compare] http      : {report['http_csv']}")
    print(f"[Compare] rows production/http: {report['production_rows']} / {report['http_rows']}")
    print(f"[Compare] common ids: {report['common_ids']}")
    print(f"[Compare] missing in http: {report['missing_in_http']}")
    print(f"[Compare] extra in http: {report['extra_in_http']}")
    for col, diff in report["column_diffs"].items():
        print(f"[Compare] diff {col}: {diff['count']}")
        for example in diff["examples"][:3]:
            print(f"  - {example[KEY]} production={example['production']} http={example['http']}")
    return report