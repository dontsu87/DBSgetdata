# -*- coding: utf-8 -*-
"""
★ プログラム概要
・任意のGoogleスプレッドシートのシートタブ「A:E列」を画像化して、指定のSlackチャンネルへ投稿します。
・E列(AT通知受信日時)が「●日以上前」の行のみ抽出して表画像を自動生成（納品時デフォルトは10日以上前で設定、日数は31行目で任意変更可能）

★ 初期設定時は『ここだけ変更必要（17~24行目）』の部分だけ書き換えてください。
・別スクリプトで車両情報のスプレッドシートの更新で活用しているJSONファイルはそのまま流用できます。同一シート読込の場合は新規でのAPIキー設定は不要です。
・SLACKのAPI連携（TOKEN取得）と投稿先チャンネルIDを確認のうえ書き換えが必要です。
"""

# ==========================================
# ここだけ変更必要（ユーザー設定）
# ==========================================

# Googleスプレッドシート情報
json_key_file = "your_jsonfile_name.json"   # ← GoogleCloudConsoleで作成したサービスアカウントキーのファイル名(本スクリプトと同一階層に保存)
spreadsheet_name = "your_spreadsheet_name"  # ← スプレッドシート名
sheet_name = "your_sheet_name"              # ← シート名
read_range = "A:E"  # 参照列の範囲

# Slack設定
SLACK_BOT_TOKEN = "your_slack_token"   # SlackAPIより発行したTOKEN
slack_channel = "your_channel_id"      # 投稿先のSlackチャンネルID

# =========================
# 任意変更箇所（ユーザー設定）
# =========================

# 抽出条件
filter_days = 10                   # AT通知受信日時XX日以上前
filter_date_col = "AT通知受信日時"  # 抽出列名の指定（スプレッドシートの列名）

# 画像出力設定
image_path = f"AT通知受信 {filter_days}日以上未受信.png" #出力画像のファイル名
FONT_SIZE   = 20            # 本文フォントサイズ
DPI         = 200           # 画像の解像度
ROW_EVEN_BG = "#FFFFFF"   # 画像の偶数行色
ROW_ODD_BG  = "#EEE7E7DA" # 画像の奇数行色

# Slackアナウンス用
slack_info = f"*⚠️ AT通知受信 {filter_days}日以上未受信一覧 ⚠️*"

# =============
# 使用モジュール
# =============
import os
import sys
import time
import textwrap
import math
import json
import gspread
import pandas as pd
from datetime import datetime, timedelta
from typing import List, Optional
from zoneinfo import ZoneInfo
from google.auth.exceptions import DefaultCredentialsError
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError

import matplotlib.font_manager as fm
from matplotlib import pyplot as plt
from matplotlib.table import Table
plt.rcParams['font.family'] = 'Meiryo'      # フォント設定（描画する表を日本語対応）
plt.rcParams['axes.unicode_minus'] = False  # 描画文字化け回避用

# -----------------------------
# Google Sheets 読み込み
# -----------------------------

def fetch_sheet_as_dataframe(spreadsheet_name: str, sheet_name: Optional[str], rng: str, json_key_file: str) -> pd.DataFrame:
    key_path = os.path.join(os.path.dirname(__file__), json_key_file)
    if not os.path.exists(key_path):
        raise SystemExit(f"Google認証キーが見つかりません: {key_path}")

    gc = gspread.service_account(filename=key_path)
    sh = gc.open(spreadsheet_name)  # スプレッドシートの「名前」で開く
    ws = sh.worksheet(sheet_name) if sheet_name else sh.sheet1
    values = ws.get(rng)
    if not values:
        return pd.DataFrame()

    header = values[0]
    rows = values[1:]
    return pd.DataFrame(rows, columns=header)

# -----------------------------
# フィルタ: ●日以上前
# -----------------------------

def filter_by_days(df: pd.DataFrame, date_col: str, days: int) -> pd.DataFrame:
    if df.empty:
        return df

    if date_col not in df.columns:
        raise SystemExit(f"日時列 '{date_col}' が見つかりません。列一覧: {list(df.columns)}")

    # 1) 文字列をまとめて datetime に変換（失敗は NaT に）
    ts = pd.to_datetime(df[date_col], errors='coerce')  # infer は自動

    # 2) タイムゾーン付与/変換
    #    既にTZ付きなら Asia/Tokyo に変換、Naiveなら Asia/Tokyo を付与
    try:
        if ts.dt.tz is None:
            ts = ts.dt.tz_localize('Asia/Tokyo', nonexistent='shift_forward', ambiguous='NaT')
        else:
            ts = ts.dt.tz_convert('Asia/Tokyo')
    except AttributeError:
        # ts が全 NaT のときなど safety
        pass

    cutoff = pd.Timestamp.now(tz='Asia/Tokyo') - pd.Timedelta(days=days)
    mask = ts.notna() & (ts <= cutoff)

    out = df.loc[mask].copy()
    # 表示用に整形（文字列）
    try:
        out[date_col] = ts.loc[mask].dt.strftime('%Y-%m-%d %H:%M:%S').values
    except Exception:
        pass
    return out

# -----------------------------
# 表画像生成
# -----------------------------

def _estimate_col_char_widths(df: pd.DataFrame, max_col_chars: int = 40) -> List[int]:
    widths = []
    for c in df.columns:
        max_len = len(str(c))
        for v in df[c].astype(str).tolist():
            max_len = max(max_len, len(v))
        widths.append(min(max_len, max_col_chars))
    return widths


def _wrap_dataframe(df: pd.DataFrame, char_widths: List[int]) -> pd.DataFrame:
    wrapped = {}
    for i, c in enumerate(df.columns):
        w = max(6, char_widths[i])
        wrapped[c] = [textwrap.fill(str(v), width=w) for v in df[c].astype(str)]
    return pd.DataFrame(wrapped)


def _calc_layout(df: pd.DataFrame, base_fontsize: int, max_fig_width_px: int = 2000, max_fig_height_px: int = 2400):
    """表の1ページあたりの行数と図サイズを決める。行の縦幅を詰めるため係数を小さく調整。"""
    px_per_char = 9
    row_height_px = max(int(base_fontsize * 1.45), base_fontsize + 4)
    header_height_px = max(int(base_fontsize * 1.60), base_fontsize + 6)

    char_widths = _estimate_col_char_widths(df)
    total_width_px = int(sum(char_widths) * px_per_char + 40)

    fig_w_px = min(max(total_width_px, 800), max_fig_width_px)
    available_h = max_fig_height_px - header_height_px - 40
    rows_per_image = max(1, available_h // row_height_px)

    fig_h_px = header_height_px + 40 + rows_per_image * row_height_px
    return rows_per_image, fig_w_px, fig_h_px, row_height_px

def _draw_table_image(df: pd.DataFrame, image_path: str, dpi: int, base_fontsize: int):
    """出力画像の表示パラメーター設定"""
    body_fs   = base_fontsize
    header_fs = base_fontsize
    header_bg = "#303030"
    header_fg = "#FFFFFF"
    cell_pad  = 0.003
    grid_lw_inner = 0.4
    outer_lw  = 2.2
    grid_color = "#444444"
    row_alt_bg = "#FAFAFA"

    # 列名に基づいて幅・配置を制御（列名が違う場合はここを合わせてください）
    CENTER_COLS = {"識別番号", "電圧", "AT通知受信日時"}  # A/D/E を中央
    LEFT_COLS   = {"車両状態", "ポート名"}              # B/C を左寄せ

    # 横幅の上限（“文字数”基準）
    MAX_CHARS = {
        "ポート名": 35,
        "AT通知受信日時": 20,
    }
    # 横幅の下限（細くし過ぎ防止）
    MIN_CHARS = {
        "識別番号": 8,
        "車両状態": 10,
        "電圧": 4,
    }

    def _header_px(fs): return max(int(fs * 1.3), fs + 3)
    def _row_px(fs):    return max(int(fs * 1.35), fs + 4)

    rows_per_image, fig_w_px_global, _, _ = _calc_layout(df, body_fs)
    df_wrapped = _wrap_dataframe(df, _estimate_col_char_widths(df))
    nrows = len(df_wrapped)
    num_images = math.ceil(nrows / rows_per_image)
    os.makedirs(os.path.dirname(image_path) or ".", exist_ok=True)
    saved_paths = []

    # 左だけ少し隙間に使う“細いスペース”
    THIN_PAD = "\u2002"  # EN SPACE（薄い全角）

    for i in range(num_images):
        start, end = i * rows_per_image, min((i + 1) * rows_per_image, nrows)
        chunk = df_wrapped.iloc[start:end]
        rows_in_chunk = max(1, len(chunk))

        header_h_px = _header_px(header_fs)
        row_h_px = _row_px(body_fs)
        fig_h_px = header_h_px + 40 + rows_in_chunk * row_h_px
        fig_w_in = (fig_w_px_global / dpi) * (base_fontsize / 12) ** 0.9
        fig_h_in = (fig_h_px / dpi) * (base_fontsize / 12) ** 0.9
        fig, ax = plt.subplots(figsize=(fig_w_in, fig_h_in), dpi=dpi)
        ax.axis("off")

        from matplotlib.table import Table
        table = Table(ax, bbox=[0, 0, 1, 1])

        # ---- 列幅（相対）の算出：C/E を上限で抑え、各列に下限も適用 ----
        col_widths_chars_raw = _estimate_col_char_widths(
            pd.concat([pd.DataFrame([df_wrapped.columns.tolist()], columns=df_wrapped.columns), chunk], ignore_index=True)
        )
        col_names = list(chunk.columns)
        col_widths_chars = []
        for j, name in enumerate(col_names):
            w = col_widths_chars_raw[j]
            if name in MAX_CHARS:
                w = min(w, MAX_CHARS[name])
            if name in MIN_CHARS:
                w = max(w, MIN_CHARS[name])
            col_widths_chars.append(w)

        px_per_char = 9
        col_widths_px = [max(60, w * px_per_char) for w in col_widths_chars]
        total_w = sum(col_widths_px)
        header_h_rel = header_h_px / fig_h_px
        row_h_rel = row_h_px / fig_h_px

        # ---- ヘッダー ----
        for ci, name in enumerate(col_names):
            w_rel = col_widths_px[ci] / total_w
            cell = table.add_cell(-1, ci, w_rel, header_h_rel,
                                  text=name, loc="center", facecolor=header_bg, edgecolor=grid_color)
            cell.set_linewidth(grid_lw_inner)
            t = cell.get_text()
            t.set_color(header_fg); t.set_weight("bold"); t.set_fontsize(header_fs); t.set_va("center")
            cell.PAD = cell_pad

        # ---- データ行（交互配色＋列ごとの揃え）----
        for ri, (_, row) in enumerate(chunk.iterrows()):
            bg = ROW_EVEN_BG if (ri % 2 == 0) else ROW_ODD_BG

            for ci, name in enumerate(col_names):
                w_rel = col_widths_px[ci] / total_w
                val = str(row[name])

                # 列B/C は左だけ少し空けて左寄せ
                if name in LEFT_COLS and val:
                    if not val.startswith(THIN_PAD):
                        val = THIN_PAD + val

                # 配置を列で決定（セルの loc とテキストの ha を一致させる）
                if name in CENTER_COLS:       # A/D/E は中央
                    cell_loc = "center"
                    text_ha  = "center"
                else:                          # B/C は左
                    cell_loc = "left"
                    text_ha  = "left"

                cell = table.add_cell(
                    ri, ci, w_rel, row_h_rel,
                    text=val, loc=cell_loc, facecolor=bg, edgecolor=grid_color
                )
                cell.set_linewidth(grid_lw_inner)
                t = cell.get_text()
                t.set_fontsize(body_fs)
                t.set_va("center")
                t.set_ha(text_ha)
                cell.PAD = cell_pad
        ax.add_table(table)

        # 外枠（太線）
        ax.add_patch(plt.Rectangle((0, 0), 1, 1, transform=ax.transAxes,
                                   fill=False, linewidth=outer_lw, edgecolor="black"))

        plt.tight_layout(pad=0.25)
        root, ext = os.path.splitext(image_path)
        out_path = f"{root}_{i+1}{ext}" if num_images > 1 else image_path
        fig.savefig(out_path, dpi=dpi, bbox_inches="tight")
        plt.close(fig)
        saved_paths.append(out_path)

    return saved_paths


# -----------------------------
# Slack送信
# -----------------------------

def post_announcement_and_images(channel: str, text: str, image_paths: list[str], sleep_sec: float = 1.5):
    if not SLACK_BOT_TOKEN:
        raise SystemExit('SLACK_BOT_TOKEN が未設定です。')

    client = WebClient(token=SLACK_BOT_TOKEN)

    # --- 1) タイトル投稿 ---
    try:
        client.chat_postMessage(channel=channel, text=text)
        print(f"Slackにアナウンスを投稿: AT通知受信 {filter_days}日以上未受信一覧")
    except SlackApiError as e:
        err = e.response.get("error", "")
        print(f"アナウンス投稿失敗: {err}")
        return

    time.sleep(sleep_sec)

    # --- 2) 画像を順次投稿（スレッドなし）---
    for idx, p in enumerate(image_paths, 1):
        for attempt in range(5):
            try:
                client.files_upload_v2(
                    channel=channel,
                    file=p,
                    title=os.path.basename(p)
                )
                print(f"[{idx}/{len(image_paths)}] Slack画像送信成功: {p}")
                break
            except SlackApiError as e:
                err = e.response.get("error", "")
                if err == "ratelimited":
                    wait = int(e.response.headers.get("Retry-After", "5"))
                    print(f"レート制限中。{wait}秒待機して再試行します...")
                    time.sleep(wait)
                    continue
                print(f"Slack送信失敗: {err}")
                break
        time.sleep(sleep_sec)  # 次の画像まで少し間を空ける

# -----------------------------
# メイン処理
# -----------------------------

def main():
    df = fetch_sheet_as_dataframe(spreadsheet_name, sheet_name, read_range, json_key_file)
    if df.empty:
        print('シートにデータがありません。')
        return

    filtered = filter_by_days(df, filter_date_col, filter_days)
    if filtered.empty:
        print(f'{filter_days}日以上前の行はありません。')
        return

    preferred_cols = ['識別番号', '車両状態', 'ポート名', '電圧', filter_date_col]
    cols = [c for c in preferred_cols if c in filtered.columns]
    view = filtered[cols].reset_index(drop=True)

    font_size = FONT_SIZE
    dpi = DPI
    paths = _draw_table_image(view, image_path, dpi, font_size)

    if slack_channel:
        announce = slack_info
        post_announcement_and_images(slack_channel, announce, paths)

    print("✅ 送信完了")

if __name__ == '__main__':
    main()