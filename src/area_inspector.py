# -*- coding: utf-8 -*-
import os
import time
from datetime import datetime
from bs4 import BeautifulSoup
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from src.browser import build_driver, BrowserUtils
from src.config import Config
from src.auth import Locators

def inspect_area_page():
    """
    ログイン直後のエリア選択画面を安全に調査します。
    スクリーンショットとHTML解析ログをローカルに保存し、運営設定には一切触れません。
    """
    Config.validate()
    print("🚀 調査用ブラウザを起動しています...")
    driver = build_driver()
    utils = BrowserUtils(driver)
    
    try:
        # 1. ログイン処理
        print(f"🔗 ログインページにアクセス中: {Config.TOP_PAGE}")
        driver.get(Config.TOP_PAGE)
        
        print("🔑 認証情報を入力中...")
        utils.W(utils.wait_long).until(EC.element_to_be_clickable(Locators.LOGIN_ACCOUNT)).send_keys(Config.ACCOUNT)
        utils.W(utils.wait_long).until(EC.element_to_be_clickable(Locators.LOGIN_PASSWORD)).send_keys(Config.PASSWORD)
        utils.W(utils.wait_short).until(EC.element_to_be_clickable(Locators.LOGIN_SUBMIT)).click()
        
        # ログイン後の待機
        print("⏳ ログイン後の画面ロードを待機中...")
        utils.W(utils.wait_long).until(
            EC.presence_of_element_located(Locators.BTN_TO_TOP)
        )
        
        # 2. 調査データの作成
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        debug_dir = os.path.join(os.path.dirname(__file__), "..", "debug")
        os.makedirs(debug_dir, exist_ok=True)
        
        # スクリーンショットの保存
        screenshot_path = os.path.join(debug_dir, f"area_page_{timestamp}.png")
        driver.save_screenshot(screenshot_path)
        print(f"📸 スクリーンショットを保存しました: {screenshot_path}")
        
        # HTMLの解析とログ保存
        html_path = os.path.join(debug_dir, f"area_page_{timestamp}.html")
        with open(html_path, "w", encoding="utf-8") as f:
            f.write(driver.page_source)
        print(f"📄 HTMLソースを保存しました: {html_path}")
        
        # ボタンとその周辺テキストの解析
        soup = BeautifulSoup(driver.page_source, "html.parser")
        buttons = soup.select("input[type='submit'][value='トップ画面へ']")
        
        print(f"\n🔍 解析結果: 「トップ画面へ」ボタンを {len(buttons)} 個検出しました。")
        log_lines = []
        log_lines.append(f"検出ボタン数: {len(buttons)}")
        
        for idx, btn in enumerate(buttons):
            # ボタン自体の属性
            attrs_str = ", ".join([f"{k}='{v}'" for k, v in btn.attrs.items()])
            
            # 親要素のテキストや周辺テキストを収集
            parent = btn.parent
            parent_text = parent.get_text(strip=True) if parent else "N/A"
            
            log_line = f"ボタン {idx+1}: attrs=[{attrs_str}], 周辺テキスト='{parent_text}'"
            print(f"  - {log_line}")
            log_lines.append(log_line)
            
        # 調査結果テキストファイルの書き出し
        result_path = os.path.join(debug_dir, f"area_analysis_{timestamp}.txt")
        with open(result_path, "w", encoding="utf-8") as f:
            f.write("\n".join(log_lines))
        print(f"📝 解析ログを保存しました: {result_path}")
        
        print("\n✅ 安全な画面調査が正常に完了しました。")
        print("※ この処理は画面の情報を読み取って保存しただけですので、実稼働システムへの影響は一切ありません。")
        
    except Exception as e:
        print(f"❌ 調査中にエラーが発生しました: {e}")
    finally:
        driver.quit()

if __name__ == "__main__":
    inspect_area_page()
