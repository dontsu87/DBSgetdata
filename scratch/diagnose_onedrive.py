# -*- coding: utf-8 -*-
import sys
import os
import time
from pathlib import Path
from datetime import datetime

ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.append(str(ROOT_DIR))

from src.config import Config
from src.browser import build_driver, BrowserUtils
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC

def diagnose():
    Config.validate()
    print("🔄 OneDrive診断用ブラウザを起動中...")
    driver = build_driver()
    utils = BrowserUtils(driver)
    
    try:
        print("🔗 共有リンクにアクセス中...")
        driver.get(Config.ONEDRIVE_SHARED_LINK)
        
        # パスワード画面
        try:
            pwd_input = utils.W(8).until(
                EC.presence_of_element_located((By.CSS_SELECTOR, "input[type='password'], #sharepoint-password-input"))
            )
            print("🔑 パスワードを入力中...")
            pwd_input.clear()
            pwd_input.send_keys(Config.ONEDRIVE_PASSWORD)
            btn = driver.find_element(
                By.CSS_SELECTOR,
                "input[type='submit'], button[type='submit'], input[value='確認'], input[value='Verify'], button.ms-Button--primary"
            )
            utils.click_js(btn)
            print("👉 送信完了。")
            time.sleep(5)
        except Exception:
            print("パスワード画面スキップ")

        # アップロードボタンをクリック
        print("⏳ アップロードボタンを待機中...")
        upload_btn = utils.W(15).until(
            EC.element_to_be_clickable((By.CSS_SELECTOR, "button[data-automationid='uploadCommand']"))
        )
        print("👉 アップロードボタンをクリックします...")
        utils.click_js(upload_btn)
        
        # ドロップダウンが展開するのを待機
        time.sleep(2)
        
        # 画面ダンプ
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        debug_dir = ROOT_DIR / "debug"
        os.makedirs(debug_dir, exist_ok=True)
        
        screenshot_path = debug_dir / f"onedrive_dropdown_{timestamp}.png"
        driver.save_screenshot(str(screenshot_path))
        print(f"📸 ドロップダウン展開時のスクリーンショットを保存しました: {screenshot_path}")
        
        html_path = debug_dir / f"onedrive_dropdown_{timestamp}.html"
        with open(html_path, "w", encoding="utf-8") as f:
            f.write(driver.page_source)
        print(f"📄 ドロップダウン展開時のHTMLを保存しました: {html_path}")
        
    except Exception as e:
        print(f"❌ エラーが発生しました: {e}")
    finally:
        driver.quit()

if __name__ == "__main__":
    diagnose()
