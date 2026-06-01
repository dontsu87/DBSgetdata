# -*- coding: utf-8 -*-
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException
from src.browser import BrowserUtils
from src.config import Config

class Locators:
    LOGIN_ACCOUNT = (By.NAME, "Account")
    LOGIN_PASSWORD = (By.NAME, "Password")
    LOGIN_SUBMIT = (By.CSS_SELECTOR, "input[type='submit'][value='ログイン']")
    
    # エリア選択画面の「トップ画面へ」ボタン
    # 送信ボタン（input[type='submit'][value='トップ画面へ']）が複数並んでいることが想定される
    BTN_TO_TOP = (By.CSS_SELECTOR, "input[type='submit'][value='トップ画面へ']")
    
    # 車両情報ボタン
    BTN_VEHICLE = (By.CSS_SELECTOR, "input[type='submit'][value='車両情報']")

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
