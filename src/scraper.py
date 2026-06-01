# -*- coding: utf-8 -*-
import time
import pandas as pd
from bs4 import BeautifulSoup
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException
from src.browser import BrowserUtils
from src.auth import Locators

class ScraperLocators:
    # 500件絞り込み用
    DD_PAGE_SIZE = (By.CSS_SELECTOR, "select[name='GetInfoNum']")
    DD_CATEGORY = (By.NAME, "CycleSts")
    
    # ページングとテーブル
    TABLE_FIRST_ROW = (By.CSS_SELECTOR, "#scroll_table > table > tbody > tr:nth-child(1)")
    ROWS = (By.CSS_SELECTOR, "#scroll_table > table > tbody > tr")

def open_vehicle_page(driver) -> bool:
    """車両情報ページへ安全に遷移します。一時的な遅延に備えて1回だけリトライを行います。"""
    utils = BrowserUtils(driver)
    max_attempts = 2
    for attempt in range(1, max_attempts + 1):
        try:
            btn = utils.W(utils.wait_short).until(EC.element_to_be_clickable(Locators.BTN_VEHICLE))
            utils.click_js(btn)
            
            # 画面切り替えの待機
            try:
                utils.W(5).until(EC.staleness_of(btn))
            except Exception:
                pass

            utils.W(utils.wait_long).until(
                EC.any_of(
                    EC.presence_of_element_located(ScraperLocators.DD_PAGE_SIZE),
                    EC.presence_of_element_located(ScraperLocators.DD_CATEGORY),
                )
            )
            return True
        except TimeoutException:
            if attempt < max_attempts:
                print(f"⚠️ 車両情報ページへの遷移にタイムアウトしました（試行 {attempt}/{max_attempts}）。3秒後に再試行します...")
                time.sleep(3)
                try:
                    driver.refresh()
                except Exception:
                    pass
            else:
                print("❌ 車両情報ページに到達できませんでした。")
                return False

def set_page_size_500(driver):
    """表示件数を500件に切り替えます。"""
    utils = BrowserUtils(driver)
    sel = utils.find_visible(ScraperLocators.DD_PAGE_SIZE)
    driver.execute_script("arguments[0].scrollIntoView({block:'center'});", sel)
    
    try:
        if sel.get_attribute("value") == "500":
            return
    except Exception:
        pass

    # JSで安全にvalueを500に変更してchangeイベント発火
    driver.execute_script("""
    (function(sel, val){
        if(!sel || sel.tagName !== 'SELECT') return;
        sel.value = val;
        sel.dispatchEvent(new Event('input', {bubbles:true}));
        sel.dispatchEvent(new Event('change',{bubbles:true}));
    })(arguments[0], arguments[1]);
    """, sel, "500")

    # onchange=submit による再描画待機
    form = None
    try:
        form = sel.find_element(By.XPATH, "ancestor::form[1]")
    except Exception:
        pass
        
    if form is not None:
        try:
            utils.W(5).until(EC.staleness_of(form))
        except Exception:
            pass
            
    # 再描画後のテーブル確認
    utils.W(utils.wait_long).until(
        EC.presence_of_element_located(ScraperLocators.TABLE_FIRST_ROW)
    )

def scrape_vehicle_page(driver, area_name: str) -> pd.DataFrame:
    """現在のエリアにおける全ページの車両情報を一括取得します。"""
    bike_number, bike_status, port_name, voltage, received_ATdaytime = [], [], [], [], []
    utils = BrowserUtils(driver)
    page = 1

    # 500件表示へ変更
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
            # ページめくりリンクの有無を確認してクリック
            paging_link = utils.W(utils.wait_short).until(
                EC.element_to_be_clickable((By.LINK_TEXT, link_text))
            )
            utils.click_js(paging_link)
            
            # 次のページが描画されるまで待機
            utils.W(utils.wait_long).until(
                EC.presence_of_element_located(ScraperLocators.TABLE_FIRST_ROW)
            )
        except TimeoutException:
            # 次のページが存在しない、またはタイムアウトした場合は終了
            break

    # DataFrameにまとめて返す
    df = pd.DataFrame({
        'エリア名': area_name,
        '識別番号': bike_number,
        '車両状態': bike_status,
        'ポート名': port_name,
        '電圧': voltage,
        'AT通知受信日時': received_ATdaytime
    })
    
    return df
