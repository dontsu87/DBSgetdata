# -*- coding: utf-8 -*-
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait
from selenium.common.exceptions import TimeoutException
from src.browser import BrowserUtils
from src.config import Config
from src.session_store import SESSION_FILE, app_url, restore_session, save_session

class Locators:
    LOGIN_ACCOUNT = (By.NAME, "Account")
    LOGIN_PASSWORD = (By.NAME, "Password")
    LOGIN_SUBMIT = (By.CSS_SELECTOR, "input[type='submit'][value='ログイン']")
    
    # エリア選択画面の「トップ画面へ」ボタン
    # 送信ボタン（input[type='submit'][value='トップ画面へ']）が複数並んでいることが想定される
    BTN_TO_TOP = (By.CSS_SELECTOR, "input[type='submit'][value='トップ画面へ']")
    
    # 車両情報ボタン
    BTN_VEHICLE = (By.CSS_SELECTOR, "input[type='submit'][value='車両情報']")

    # 刷新後の Cognito Hosted UI。id は React useId 由来で毎回変わるため使わない。
    NEW_LOGIN_ACCOUNT = (By.CSS_SELECTOR, "input[name='username']")
    NEW_LOGIN_PASSWORD = (By.CSS_SELECTOR, "input[name='password']")
    NEW_MFA_CODE = (By.CSS_SELECTOR, "input[name='code']")
    NEW_SUBMITS = (By.CSS_SELECTOR, "button[type='submit'], input[type='submit']")


def _visible_elements(driver, locator):
    elements = driver.find_elements(*locator)
    return [element for element in elements if element.is_displayed()]


def _wait_visible(driver, locator, timeout=20):
    def find_visible(current_driver):
        elements = _visible_elements(current_driver, locator)
        return elements[0] if elements else False

    return WebDriverWait(driver, timeout, poll_frequency=0.25).until(find_visible)


def _submit_label(element) -> str:
    return (element.text or element.get_attribute("value") or "").strip()


def _find_sign_in_submit(driver, timeout=20):
    def find_submit(current_driver):
        for element in _visible_elements(current_driver, Locators.NEW_SUBMITS):
            if _submit_label(element).casefold() in ("サインイン", "sign in"):
                return element
        return False

    return WebDriverWait(driver, timeout, poll_frequency=0.25).until(find_submit)


def _host(url: str) -> str:
    return (urlparse(url or "").hostname or "").lower()


def is_new_portal_authenticated(driver) -> bool:
    """文言ではなく、URLと認証入力欄の有無だけでログイン済みか判定する。"""
    try:
        current_url = driver.current_url or ""
        if _host(current_url) != _host(app_url(Config.login_url())):
            return False
        if _visible_elements(driver, Locators.NEW_LOGIN_PASSWORD):
            return False
        if _visible_elements(driver, Locators.NEW_MFA_CODE):
            return False
        return True
    except Exception:
        return False


def _on_mfa_screen(driver) -> bool:
    try:
        return "/mfa/" in (driver.current_url or "").lower()
    except Exception:
        return False


def authenticate_new_portal(
    driver,
    session_path: Path = SESSION_FILE,
    code_provider=None,
) -> bool:
    """
    保存済みセッションを優先して新管理ポータルへログインする。

    セッションが無効な場合だけID/PWとメールMFAを送信する。成功時はセッションを
    保存し直し、True を返す。認証に失敗した場合は例外を送出する。
    """
    login_url = Config.login_url()
    if not login_url:
        raise ValueError("DBS_LOGIN_URL が設定されていません。")

    if restore_session(driver, session_path):
        # SPA側の認証判定・リダイレクトが落ち着くのを待つ。
        time.sleep(2)
        if is_new_portal_authenticated(driver):
            print("Info: 保存済みセッションでログイン状態を復元しました。")
            return True

    driver.get(login_url)
    account_element = _wait_visible(driver, Locators.NEW_LOGIN_ACCOUNT)
    password_element = _wait_visible(driver, Locators.NEW_LOGIN_PASSWORD)
    submit_element = _find_sign_in_submit(driver)

    account, password = Config.login_credentials()
    if not account or "@" not in account or not password:
        raise ValueError("DBS_LOGIN_EMAIL / DBS_LOGIN_PASSWORD の設定を確認してください。")

    account_element.clear()
    account_element.send_keys(account)
    password_element.clear()
    password_element.send_keys(password)

    submitted_at = datetime.now(timezone.utc)
    start_url = driver.current_url
    submit_element.click()
    WebDriverWait(driver, 40, poll_frequency=0.25).until(
        lambda current_driver: (
            (current_driver.current_url or "") != start_url
            or _on_mfa_screen(current_driver)
            or is_new_portal_authenticated(current_driver)
        )
    )

    if _on_mfa_screen(driver):
        code_element = _wait_visible(driver, Locators.NEW_MFA_CODE)
        code_submit = _find_sign_in_submit(driver)
        if code_provider is None:
            from src.mail_code_client import wait_for_auth_code
            code_provider = wait_for_auth_code
        code = code_provider(since=submitted_at)
        code_element.clear()
        code_element.send_keys(code)
        code_submit.click()

    try:
        WebDriverWait(driver, 60, poll_frequency=0.25).until(
            is_new_portal_authenticated
        )
    except TimeoutException as error:
        raise RuntimeError("新管理ポータルへのログイン完了を確認できませんでした。") from error

    save_session(driver, session_path)
    print("Success: 新管理ポータルへのログインが完了しました。")
    return True

# 閉鎖済み旧ポータルの参考実装。新しい実行経路からは呼び出さない。
def login_and_get_areas(driver):
    """
    ログインを実行し、表示されたエリア（トップ画面へボタン）の一覧を検知して返します。
    戻り値:
        list of dict: [{"area_name": str, "element": WebElement}, ...]
    """
    utils = BrowserUtils(driver)
    
    # ログインページへアクセス
    driver.get(Config.TOP_PAGE)
    
    # 認証情報の入力と送信
    utils.W(utils.wait_long).until(EC.element_to_be_clickable(Locators.LOGIN_ACCOUNT)).send_keys(Config.ACCOUNT)
    utils.W(utils.wait_long).until(EC.element_to_be_clickable(Locators.LOGIN_PASSWORD)).send_keys(Config.PASSWORD)
    utils.W(utils.wait_short).until(EC.element_to_be_clickable(Locators.LOGIN_SUBMIT)).click()
    
    # ログイン後の読み込み待機
    utils.W(utils.wait_long).until(
        EC.presence_of_element_located(Locators.BTN_TO_TOP)
    )
    
    # 緊急メンテナンス画面の確認
    if "緊急メンテナンス" in driver.page_source:
        raise RuntimeError("システムが緊急メンテナンス中のため処理を続行できません。")

    # 画面上の「トップ画面へ」ボタンを全取得
    buttons = driver.find_elements(*Locators.BTN_TO_TOP)
    if not buttons:
        raise RuntimeError("エリア遷移用ボタン（トップ画面へ）が見つかりません。")

    areas = []
    for idx, btn in enumerate(buttons):
        area_name = ""
        try:
            # ボタンの親にあたる <tr> 行を探索し、その中の <td> セルから事業者IDと事業者名を取得します。
            tr = btn.find_element(By.XPATH, "./ancestor::tr[1]")
            tds = tr.find_elements(By.TAG_NAME, "td")
            if len(tds) >= 2:
                area_id = tds[0].text.strip()
                area_real_name = tds[1].text.strip()
                area_name = f"{area_id}_{area_real_name}"  # 例: "FKI_ふくチャリ"
        except Exception as e:
            print(f"⚠️ エリア名取得時にエラーが発生しました: {e}")
            pass

        if not area_name:
            area_name = f"Area_{idx + 1}"
            
        areas.append({
            "area_name": area_name,
            "element": btn
        })
        
    return areas
