# -*- coding: utf-8 -*-
"""
★ プログラム概要
・次世代CSの車両情報リストのデータ取得とスプレッドシートの書き出しを行います。
・車両情報リストの取得内容：「識別番号・車両状態・ポート・電圧・AT通知受信日時」を取得。
・任意のスプレッドシートのシートタブ（A:E列）に取得データを出力します。※GoogleCloudConsoleでサービスアカウントキーのJSONファイルの発行必須。

★ 次世代CSページ操作のエラー回避
・次世代CSのレスポンス問題で「緊急メンテナンスページ」が表示された場合は再度プログラムを実行し直しする。

★ 初期設定時/ログイン情報変更時は『ここだけ変更必要（17~21行目）』の部分だけ書き換えてください。
"""

# ============================
# ここだけ変更必要（ユーザー設定）
# ============================
ACCOUNT   = "your_id_here"                   # ← ログインID
PASSWORD  = "your_password_here"             # ← ログインパスワード
json_key_file = "your_jsonfile_name.json"    # ← GoogleCloudConsoleで作成したサービスアカウントキーのファイル名(本スクリプトと同一階層に保存)
spreadsheet_name = "your_spreadsheet_name"   # ← スプレッドシート名
sheet_name = "your_sheet_name"               # ← シート名

# =========================
# 任意変更箇所（ユーザー設定）
# =========================
HEADLESS  = False                     # True: Chrome画面を出さず実行 / False: Chrome画面を出して実行（動作確認用）
TOP_PAGE  = "https://tcc.docomo-cycle.jp/cycle/ENTSYS/cs_web_entsys_main.php"    # ← ログイン用URL（ログインフォームがあるページ）

# =============================================================
# 読込動作関連（ページ読込時間設定 / 動作不安定なら長めに間隔を調整）
# =============================================================
WAIT_SHORT = 5
WAIT_LONG  = 12
POLL       = 0.5        # WebDriverWait の読み込み間隔
MAX_RETRIES_MAINT = 2   # 次世代上で「緊急メンテナンス」ページの検知時のリトライ回数

# ===================================================================
# デバッグ用：HEADLESS = False のときのみ有効（ブラウザ画面ONのときだけ関係）
# ===================================================================
QUIET_MODE = True                     # True: コンソールログ出力内容を最低限にして抑制
KEEP_BROWSER_OPEN_ON_ERROR = True     # True: 失敗発生時にブラウザを閉じないで維持
HEADLESS_AUTO_SIZE = True             # True: パソコンの画面サイズを取得してブラウザ画面を最大化
HEADLESS_FALLBACK_SIZE = "1920,1080"  # 上記画面サイズの取得に失敗したときの指定サイズ

# =============
# 使用モジュール
# =============
import os, sys, subprocess, time, warnings, logging, platform, re
from datetime import datetime
import gspread
from gspread_dataframe import set_with_dataframe
import pandas as pd
from webdriver_manager.chrome import ChromeDriverManager
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.support.ui import WebDriverWait, Select
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException
from bs4 import BeautifulSoup
from oauth2client.service_account import ServiceAccountCredentials

# ======================================================
# 画面サイズの準備（ヘッドレス機能オフの場合に画面サイズ取得）
# ======================================================
def get_windows_screen_size():
    try:
        if platform.system() != "Windows":
            return None
        import ctypes
        user32 = ctypes.windll.user32
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            try:
                user32.SetProcessDPIAware()
            except Exception:
                pass
        w = user32.GetSystemMetrics(0); h = user32.GetSystemMetrics(1)
        return (int(w), int(h)) if w > 0 and h > 0 else None
    except Exception:
        return None

# ===============
# 要素セレクタ定義
# ===============
class Loc:
    # ログイン
    LOGIN_ACCOUNT = (By.NAME, "Account")
    LOGIN_PASSWORD = (By.NAME, "Password")
    LOGIN_SUBMIT  = (By.CSS_SELECTOR, "input[type='submit'][value='ログイン']")
    BTN_TO_TOP    = (By.CSS_SELECTOR, "input[type='submit'][value='トップ画面へ']")

    # メニュー/遷移
    BTN_VEHICLE   = (By.CSS_SELECTOR, "input[type='submit'][value='車両情報']")

    # プルダウン・更新
    DD_PAGE_SIZE  = (By.CSS_SELECTOR, "select[name='GetInfoNum']") # 500件絞り込み用
    DD_CATEGORY   = (By.NAME, "CycleSts") # 車両状態プルダウンの表示確認(ブラウザデータ取得前確認用)
    BTN_UPDATE_ANY= (By.CSS_SELECTOR, "input[type='submit'][value='更新']")

    # 一覧
    ROWS          = (By.CSS_SELECTOR, "table tbody tr")

# =========================
# コンソールログ抑制（最小限）
# =========================
def setup_logger():
    # Python側のログ抑制（printで必要なものだけ出す）
    logging.basicConfig(level=logging.CRITICAL)
    if QUIET_MODE:
        # WDMのINFOログ抑制
        os.environ.setdefault("WDM_LOG_LEVEL", "0")
        os.environ.setdefault("WDM_PRINT_FIRST_LINE", "False")
        os.environ.setdefault("CHROME_LOG_FILE", "NUL")
        warnings.filterwarnings("ignore")

# ==============================================
# ブラウザ起動（Chrome/ヘッドレス有無・ログ抑制など）
# ==============================================
def build_driver():
    options = webdriver.ChromeOptions()

    if QUIET_MODE:
        # chromedriver の冗長ログを抑制（DevTools listening...等）
        options.add_experimental_option("excludeSwitches", ["enable-logging"])
        options.add_argument("--log-level=3")       # ERROR以上
        options.add_argument("--disable-logging")
        options.add_argument("--remote-debugging-pipe")

        # Chromeの音声系/通知系を極力オフ（TFLite delegate, GCM系の発話を抑制）
        options.add_argument("--disable-speech-api")
        options.add_argument("--mute-audio")
        options.add_argument(
            "--disable-features="
            "LiveCaption,"
            "OnDeviceSpeechRecognition,"
            "SodaOnDeviceSpeechRecognition,"
            "HeadlessLiveCaptions"
        )

    if HEADLESS:
        size = get_windows_screen_size() if HEADLESS_AUTO_SIZE else None
        options.add_argument(f"--window-size={(str(size[0])+','+str(size[1])) if size else HEADLESS_FALLBACK_SIZE}")
        options.add_argument("--headless=new")
    else:
        options.add_argument("--start-maximized")

    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")

    # chromedriver 側の出力（標準出力/失敗）を抑制 → DevTools listening... を消す
    service = Service(
        ChromeDriverManager().install(),
        log_output=(subprocess.DEVNULL if QUIET_MODE else None)
    )

    driver = webdriver.Chrome(service=service, options=options)
    driver.set_page_load_timeout(max(WAIT_LONG, 30))

    if not HEADLESS:
        try:
            driver.maximize_window()
        except Exception:
            pass

    # stop用に保持（デストラクタ例外対策）
    driver._svc = service
    return driver

# ====================================================
# 共通関数（画面更新後の要素取得のため待機処理や失敗回避）
# ====================================================
def W(driver, timeout: int):
    return WebDriverWait(driver, timeout, poll_frequency=POLL)

def click_js(driver, el):
    driver.execute_script("arguments[0].scrollIntoView({block:'center'});", el)
    driver.execute_script("arguments[0].click();", el)

def safe_is_displayed(el):
    try: return el.is_displayed()
    except Exception: return False

def find_visible(driver, locator, timeout=WAIT_LONG):
    W(driver, timeout).until(EC.presence_of_all_elements_located(locator))
    for e in driver.find_elements(*locator):
        if safe_is_displayed(e):
            return e
    raise TimeoutException(f"visible element not found: {locator}")

def js_select_option(driver, select_el, wanted_value=None, text_contains=None):
    """JSで<select>値を安全に変更（Array.from で iterable 問題回避）"""
    driver.execute_script("""
    (function(sel, val, txt){
        if(!sel || sel.tagName !== 'SELECT') return;
        var opts = sel.options ? Array.from(sel.options) : [];
        var target = null;
        if (val !== null && val !== undefined) {
            target = opts.find(function(o){ return String(o.value) === String(val); });
        }
        if (!target && txt){
            target = opts.find(function(o){ return (o.text||'').indexOf(String(txt)) !== -1; });
        }
        if (!target) return;
        sel.value = target.value;
        sel.selectedIndex = opts.indexOf(target);
        sel.dispatchEvent(new Event('input', {bubbles:true}));
        sel.dispatchEvent(new Event('change',{bubbles:true}));
    })(arguments[0], arguments[1], arguments[2]);
    """, select_el, wanted_value, text_contains)

def set_visible_select(driver, locator, value=None, text_hint=None):
    """表示中<select>に値を設定（既にその値ならスキップ）"""
    sel = find_visible(driver, locator)
    driver.execute_script("arguments[0].scrollIntoView({block:'center'});", sel)
    try:
        if value is not None and sel.get_attribute("value") == value:
            return sel
    except Exception:
        pass
    ok = False
    try:
        if value is not None:
            Select(sel).select_by_value(value); ok = True
    except Exception:
        pass
    if not ok and text_hint:
        try:
            Select(sel).select_by_visible_text(text_hint); ok = True
        except Exception:
            pass
    if not ok:
        js_select_option(driver, sel, wanted_value=value, text_contains=text_hint)
    return sel

def wait_form_staleness(driver, element_in_form):
    """onchange=submit による再描画を、form/要素の staleness で待つ"""
    form = None
    try: form = element_in_form.find_element(By.XPATH, "ancestor::form[1]")
    except Exception: pass
    waited = False
    if form is not None:
        try: W(driver, 5).until(EC.staleness_of(form)); waited = True
        except Exception: pass
    if not waited:
        try: W(driver, 5).until(EC.staleness_of(element_in_form))
        except Exception: pass

def click_update_same_form(driver, element_in_form):
    """同一フォーム内の『更新』をクリック→staleness待ち→一覧復帰（指定要素のどれか表示されていれば復帰）"""
    try:
        btn = element_in_form.find_element(By.XPATH, "ancestor::form[1]//input[@type='submit' and @value='更新']")
    except Exception:
        btn = find_visible(driver, Loc.BTN_UPDATE_ANY)
    click_js(driver, btn)
    wait_form_staleness(driver, btn)
    W(driver, WAIT_LONG).until(
        lambda d: any((
            any(safe_is_displayed(e) for e in d.find_elements(*Loc.CB_LUMP)),
            any(safe_is_displayed(e) for e in d.find_elements(*Loc.ROWS)),
            any(safe_is_displayed(e) for e in d.find_elements(*Loc.DD_PAGE_SIZE)),
        ))
    )

def check_all_checkboxes_js(driver) -> int:
    """表示中の name='LumpCheck' をJS一発でON（stale回避）"""
    return driver.execute_script("""
        var boxes = Array.from(document.querySelectorAll("input[name='LumpCheck']"));
        var cnt = 0;
        boxes.forEach(function(b){
            if (!b.disabled && !b.checked && b.offsetParent !== null) {
                b.checked = true;
                b.dispatchEvent(new Event('input',  {bubbles:true}));
                b.dispatchEvent(new Event('change', {bubbles:true}));
                cnt++;
            }
        });
        return cnt;
    """)

def click_button_and_wait_state_change(driver, button_locator, timeout: int) -> bool:
    # 押下前の状態を記録
    before_rows = len(driver.find_elements(*Loc.ROWS))
    before_cbs  = len(driver.find_elements(*Loc.CB_LUMP))

    # ボタン押下
    try:
        btn = find_visible(driver, button_locator, timeout)
        click_js(driver, btn)
    except Exception:
        return False

    # 変化待ち：チェックボックスが 0 になる or 減る / 行数が減る / ボタンがstaleになる
    def changed(d):
        try:
            # staleness（再描画されたらTrue）
            if EC.staleness_of(btn)(d):
                return True
        except Exception:
            pass
        cbs  = len(d.find_elements(*Loc.CB_LUMP))
        rows = len(d.find_elements(*Loc.ROWS))
        return (cbs == 0) or (cbs < before_cbs) or (rows < before_rows)

    try:
        W(driver, timeout).until(changed)
        return True
    except TimeoutException:
        return False

def page_has_failure_text(driver, timeout=0) -> bool:
    """
    画面内に『失敗』という文言が出ていれば True。
    - バナー/通常テキストに加えて **textarea の value** を判定
    """
    xpath = "//*[contains(normalize-space(.), '失敗')]"
    try:
        if timeout > 0:
            W(driver, timeout).until(EC.presence_of_element_located((By.XPATH, xpath)))
            return True
        # 通常要素での検出
        if driver.find_elements(By.XPATH, xpath):
            return True
        # textarea の value での検出
        for ta in driver.find_elements(By.TAG_NAME, "textarea"):
            try:
                val = ta.get_attribute("value") or ""
                if "失敗" in val:
                    return True
            except Exception:
                continue
        # 最後に page_source
        return "失敗" in (driver.page_source or "")
    except Exception:
        return False

def collect_failure_textarea_lines(driver) -> list[str]:
    """
    表示中の <textarea> に『失敗』を含むものがあれば、
    **全文を改行ごと**に走査し、**『失敗』を含む行だけ**を重複排除して返す。
    """
    results = []
    seen = set()

    try:
        textareas = driver.find_elements(By.TAG_NAME, "textarea")
    except Exception:
        textareas = []

    for ta in textareas:
        # 表示中のみ対象（必要に応じて条件を緩めてもOK）
        try:
            if not ta.is_displayed():
                continue
        except Exception:
            continue

        try:
            val = ta.get_attribute("value") or ""
        except Exception:
            continue

        if "失敗" not in val:
            continue

        # 改行混在対応（\r\n, \r, \n）
        for line in re.split(r"\r\n|\r|\n", val):
            line = (line or "").strip()
            if not line:
                continue
            if "失敗" not in line:
                continue
            if line in seen:
                continue
            seen.add(line)
            results.append(line)

    return results

# ==========================
# ログインして車両情報ページへ
# ==========================
def login_then_go_top(driver):
    driver.get(TOP_PAGE)
    W(driver, WAIT_LONG).until(EC.element_to_be_clickable(Loc.LOGIN_ACCOUNT)).send_keys(ACCOUNT)
    W(driver, WAIT_LONG).until(EC.element_to_be_clickable(Loc.LOGIN_PASSWORD)).send_keys(PASSWORD)
    W(driver, WAIT_SHORT).until(EC.element_to_be_clickable(Loc.LOGIN_SUBMIT)).click()

    # トップ画面へ
    top_btn = W(driver, WAIT_LONG).until(EC.element_to_be_clickable(Loc.BTN_TO_TOP))
    click_js(driver, top_btn)

    # 旧DOM破棄（トップ画面への切替合図）→『車両情報』が出るまで待つ
    try:
        W(driver, 5).until(EC.staleness_of(top_btn))
    except Exception:
        pass
    W(driver, WAIT_LONG).until(
        EC.presence_of_element_located((By.CSS_SELECTOR, "input[type='submit'][value='車両情報']"))
    )
    
def open_vehicle_page(driver) -> bool:
    try:
        # ボタンがクリック可能になるまで待つ
        btn = W(driver, WAIT_SHORT).until(EC.element_to_be_clickable(Loc.BTN_VEHICLE))

        # JSで確実にクリック（オーバーレイ/微スクロール対策）
        click_js(driver, btn)
        try:
            W(driver, 5).until(EC.staleness_of(btn))  # 画面切替の合図
        except Exception:
            pass

        # 一覧のどれかが見えるまで待つ（元のまま）
        W(driver, WAIT_LONG).until(
            EC.any_of(
                EC.presence_of_element_located(Loc.DD_PAGE_SIZE),
                EC.presence_of_element_located(Loc.DD_CATEGORY),
            )
        )
        return True
    except TimeoutException:
        print("車両情報ページに到達できませんでした")
        return False

# ===================
#  スクレイピング用関数
# ===================
def set_page_size_500(driver):
    """車両情報ページのプルダウン「500件」に絞り込みする関数"""
    sel = set_visible_select(driver, Loc.DD_PAGE_SIZE, value="500", text_hint="500件")
    wait_form_staleness(driver, sel)  # onchange=submit → 再描画待ち

def scrape_vehicle_page(driver):
    """車両情報ページの全車両のデータを一括取得（CSA番号/車両状態/ポート名/電圧/AT通知受信日時）"""
    bike_number, bike_status, port_name, voltage, received_ATdaytime = [], [], [], [], []
    page = 1

    set_page_size_500(driver)

    while True:
        soup = BeautifulSoup(driver.page_source, "html.parser")
        rows = soup.select("#scroll_table > table > tbody > tr")

        for row in rows:
            cells = row.find_all("td")
            if len(cells) >= 9:
                bike_number.append(cells[1].get_text(strip=True))
                bike_status.append(cells[3].get_text(strip=True))
                port_name.append(cells[4].get_text(strip=True))
                voltage.append(cells[7].get_text(strip=True))
                received_ATdaytime.append(cells[8].get_text(strip=True))

        page += 1
        link_text = str(page)
        try:
            W(driver, WAIT_SHORT).until(EC.element_to_be_clickable((By.LINK_TEXT, link_text))).click()
            W(driver, WAIT_LONG).until(
                EC.presence_of_element_located((By.CSS_SELECTOR, "#scroll_table > table > tbody > tr:nth-child(1)"))
            )
        except TimeoutException:
            break

    return bike_number, bike_status, port_name, voltage, received_ATdaytime

# ============================
# スプレッドシート出力関数
# ============================
def write_to_spreadsheet(
    bike_numbers,
    vehicle_statuses,
    port_names,
    voltages,
    received_ATdaytimes
):

    # ========================
    #  認証とスプレッドシート設定
    # ========================
    try:
        # スクリプトのディレクトリを取得
        file_dir = os.path.dirname(os.path.abspath(__file__))
        json_keyfile_path = os.path.join(file_dir, json_key_file)

        # 認証情報とAPIクライアントの設定
        scope = [
            "https://spreadsheets.google.com/feeds",
            "https://www.googleapis.com/auth/drive"
        ]
        creds = ServiceAccountCredentials.from_json_keyfile_name(json_keyfile_path, scope)
        client = gspread.authorize(creds)

        # スプレッドシートを開く
        spreadsheet = client.open(spreadsheet_name)
        sheet = spreadsheet.worksheet(sheet_name)

    except FileNotFoundError:
        print(f"認証ファイルが見つかりません: {json_key_file}")
        return
    except gspread.SpreadsheetNotFound:
        print(f"スプレッドシートが見つかりません: {spreadsheet_name}")
        return
    except Exception as e:
        print("スプレッドシート接続時にエラー:", e)
        return

    # ========================
    #  データ処理
    # ========================
    try:
        # 車両状態一覧
        df_vehicle_alldata = pd.DataFrame({
            '識別番号': bike_numbers,
            '車両状態': vehicle_statuses,
            'ポート名': port_names,
            '電圧': voltages,
            'AT通知受信日時': received_ATdaytimes
        })

        # 出力列の順序を定義
        # merged_df = merged_df[['No', '車体番号', 'ポート名', '緯度経度', '車両状態', '電圧', 'AT受信日']]

        # シートの既存データをクリア
        sheet.clear()

        # データを書き込み
        set_with_dataframe(sheet, df_vehicle_alldata, include_index=False, include_column_header=True)
        print(f"✅ データをスプレッドシート '{sheet_name}' に書き込みました。")

    except gspread.exceptions.APIError as e:
        print("API Error:", e)
    except Exception as e:
        print("データ処理中にエラー:", e)

# =============================================
# 全体の実行と終了処理（起動・リトライ・失敗表示）
# =============================================
def run_main_flow():
    setup_logger()
    if not TOP_PAGE or not TOP_PAGE.startswith("http"):
        print("TOP_PAGE（ログイン用URL）を正しく設定してください。"); return
    if not ACCOUNT or not PASSWORD:
        print("ACCOUNT / PASSWORD を設定してください。"); return

    driver = build_driver()
    try:
        for attempt in range(1, MAX_RETRIES_MAINT + 1):
            try:
                login_then_go_top(driver)
            except SystemExit:
                raise
            except Exception as e:
                print("予期せぬ失敗が発生したため中断します:", e)
                sys.exit(1)

            # 緊急メンテページの検知確認
            if "緊急メンテナンス" in driver.page_source:
                print(f"⚠ 緊急メンテナンス検知（{attempt}/{MAX_RETRIES_MAINT}）: 再試行します...")
                time.sleep(10)
                continue
            if open_vehicle_page(driver):
                print("✅ 車両情報ページに移動しました")
                bike_numbers, vehicle_statuses, port_names, voltages, received_ATdaytimes= scrape_vehicle_page(driver)
            else:
                print("❌ 車両情報ページに移動できませんでした")
                return
        
            write_to_spreadsheet(
                bike_numbers,
                vehicle_statuses,
                port_names,
                voltages,
                received_ATdaytimes
            )

            # --- 最終集計 ---    
            elapsed = str(datetime.now() - start_login).split('.')[0]
            print("\n=== 車両情報ページのスクレイピング実行完了 ===")
            print(f"- 実行作業時間: {elapsed}")
            print(f"取得行数（車両情報）: {len(bike_numbers)}件")
            print("✅ 処理が正常に完了しました。")

            break  # 正常完了でループを抜ける
        else:
            # for-else: ループを break せずに終わった場合（＝毎回メンテ検知等で未完）
            print("❌ 緊急メンテナンスが継続中のため、処理を中断しました。")

    finally:
        try:
            if not (KEEP_BROWSER_OPEN_ON_ERROR and not HEADLESS):
                try:
                    driver.quit()
                finally:
                    svc = getattr(driver, "_svc", None)
                    if svc:
                        try:
                            svc.stop()
                        except Exception:
                            pass
        except Exception:
            pass


if __name__ == "__main__":
    start_login = datetime.now()
    run_main_flow()