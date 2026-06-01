# -*- coding: utf-8 -*-
"""
★ プログラム概要
・AT異常全般 → 500件 → 全選択 → 異常回復
・メンテナンス（アラート付）→ 500件 → 全選択 → メンテナンス解除

★ 次世代ページ操作のエラー回避
・次世代CSのレスポンス問題で「緊急メンテナンスページ」が表示された場合は再度プログラムを実行し直しする。
・AT異常回復後に一部車両で「失敗」した場合、動作がエラーで止まらずに、メンテナンス解除に遷移するよう修正。
・メンテナンス解除後に一部車両で「失敗」した場合、動作がエラーで止まらずに、プログラムが強制終了するよう修正。

★ 初期設定時/ログイン情報変更時は『ここだけ変更必要（18~19行目）』の部分だけ書き換えてください。
"""

# ============================
# ここだけ変更必要（ユーザー設定）
# ============================
ACCOUNT   = "your_id_here"                   # ← ログインID
PASSWORD  = "your_password_here"             # ← ログインパスワード

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
import os, sys, time, subprocess, warnings, logging, platform, re
from datetime import datetime
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait, Select
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException

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
    DD_CATEGORY   = (By.NAME, "CycleSts") # AT異常全般・メンテナンス(アラート付)の選択用
    BTN_UPDATE_ANY= (By.CSS_SELECTOR, "input[type='submit'][value='更新']")

    # 一覧
    ROWS          = (By.CSS_SELECTOR, "table tbody tr")
    CB_LUMP       = (By.NAME, "LumpCheck") # 車両チェックボックスの選択用

    # 操作用
    BTN_RECOVER      = (By.CSS_SELECTOR, "input[type='submit'][value='異常回復']")
    BTN_MAINT_CLEAR  = (By.CSS_SELECTOR, "input[type='submit'][value='メンテナンス解除']")

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

# ===========================================
# 主要関数（500件設定→カテゴリ選択→更新→一括選択）
# ===========================================
def set_page_size_500(driver):
    sel = set_visible_select(driver, Loc.DD_PAGE_SIZE, value="500", text_hint="500件")
    wait_form_staleness(driver, sel)  # onchange=submit → 再描画待ち

def ensure_category_and_update(driver, expected_value: str, label_hint: str) -> bool:
    """カテゴリを expected に設定→『更新』→ 反映確認。OKなら True。"""
    dd = set_visible_select(driver, Loc.DD_CATEGORY, value=expected_value, text_hint=label_hint)
    click_update_same_form(driver, dd)
    try:
        cur = find_visible(driver, Loc.DD_CATEGORY).get_attribute("value")
        return cur == expected_value
    except Exception:
        return False

def flow_check_all_for_category(driver, category_value: str, category_label: str,
                                auto_click_button_locator=None, auto_click_enabled=False) -> int:
    set_page_size_500(driver)
    ok = ensure_category_and_update(driver, expected_value=category_value, label_hint=category_label)
    if not ok:
        return 0
    checked = check_all_checkboxes_js(driver)
    if checked > 0 and auto_click_enabled and auto_click_button_locator:
        click_button_and_wait_state_change(driver, auto_click_button_locator, WAIT_LONG)
    return checked

# =====================================
# 実行フロー（途中経過と最終集計の出力付き）
# =====================================
def run_main_flow_once(driver):
    if not open_vehicle_page(driver):
        return

    # --- AT異常全般の500件回復 ---
    at_checked = flow_check_all_for_category(
        driver,
        category_value="9",
        category_label="AT異常全般",
        auto_click_button_locator=Loc.BTN_RECOVER,
        auto_click_enabled=True
    )

    # absl WARNING が見える環境向けの注釈と途中経過（ここで一度だけ）
    if HEADLESS:
        print("\n- 上記WARNINGの警告テキストはChrome側の仕様（ヘッドレスモード時のみ音声関係の警告表示）のため無視でOK")

    print("\n- AT異常全般の回復済み(上限500件)")

    # ★ AT異常回復後の『失敗』検知 → textarea の失敗行を出す → 車両情報へ戻る
    if page_has_failure_text(driver, timeout=2):
        fail_msgs = collect_failure_textarea_lines(driver)
        if fail_msgs:
            print("\n▼AT異常『異常回復』 失敗詳細")
            for m in fail_msgs:
                print(f"  - {m}")
        # 次の処理のために車両情報ページに戻る
        open_vehicle_page(driver)

    # --- メンテナンス（アラート付）の500件解除 ---
    ma_checked = flow_check_all_for_category(
        driver,
        category_value="8",
        category_label="メンテナンス（アラート付）",
        auto_click_button_locator=Loc.BTN_MAINT_CLEAR,
        auto_click_enabled=True
    )
    print("- メンテナンス(アラート付)の解除済み(上限500件)")

    # ★ メンテ解除後の『失敗』検知 → textarea の失敗行を出す → 集計して即終了
    if page_has_failure_text(driver, timeout=2):
        fail_msgs = collect_failure_textarea_lines(driver)
        if fail_msgs:
            print("\n▼メンテ(アラート付)『メンテナンス解除』 失敗詳細")
            for m in fail_msgs:
                print(f"  - {m}")
        elapsed = str(datetime.now() - start_login).split('.')[0]
        print("\n=== AT異常回復・メンテナンス(アラート付)解除の実行完了 ===")
        print(f"- 実行作業時間: {elapsed}")
        print(f"- AT異常全般の回復結果: {at_checked} 件")
        print(f"- メンテナンス(アラート付)の解除結果: {ma_checked} 件")
        return

    # --- 最終集計 ---
    elapsed = str(datetime.now() - start_login).split('.')[0]
    print("\n=== AT異常回復・メンテナンス(アラート付)解除の実行完了 ===")
    print(f"- 実行作業時間: {elapsed}")
    print(f"- AT異常全般の回復結果: {at_checked} 件")
    print(f"- メンテナンス(アラート付)の解除結果: {ma_checked} 件")
    return

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

                # ログイン直後に緊急メンテを検知したらリトライ
                if "緊急メンテナンス" in (driver.page_source or ""):
                    print(f"⚠ 緊急メンテナンス検知（{attempt}/{MAX_RETRIES_MAINT}）: 再試行します...")
                    time.sleep(10)  # 必要に応じて指数バックオフへ: time.sleep(5 * attempt)
                    continue

                # 本処理を1回分実行（ログイン済み前提）
                run_main_flow_once(driver)

                # ここまで来れば正常完了
                print("✅ 処理が正常に完了しました。")
                break

            except SystemExit:
                raise
            except Exception as e:
                print("予期せぬ失敗が発生したため中断します:", e)
                sys.exit(1)

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