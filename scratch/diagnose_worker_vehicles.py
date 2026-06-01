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
from src.auth import login_and_get_areas, Locators
from src.scraper import open_vehicle_page

def diagnose():
    """
    作業員用ページから、特定のエリアにアクセスし、
    車両情報ページのHTML構造とスクリーンショットをダンプします。
    """
    Config.validate(is_worker=True)
    
    # 一時的にConfigのURLとID/PWを作業員用にオーバーライド
    # これにより、既存の認証・巡回ロジックがそのまま動作するかテストできます
    Config.ACCOUNT = Config.WORKER_ACCOUNT
    Config.PASSWORD = Config.WORKER_PASSWORD
    Config.TOP_PAGE = Config.WORKER_TOP_PAGE
    
    print("🔄 診断用ブラウザを起動中 (作業員モード)...")
    driver = build_driver()
    utils = BrowserUtils(driver)
    
    try:
        # 1. ログインとエリア一覧取得
        print("🔑 ログイン実行中...")
        areas = login_and_get_areas(driver)
        print(f"✅ エリア一覧を検出しました: {[a['area_name'] for a in areas]}")
        
        # SNN_上田市千曲市広域シェアサイクル をターゲットにする (軽量でテストに最適)
        target_area_name = "SNN_上田市千曲市広域シェアサイクル"
        target_area = next((a for a in areas if target_area_name in a["area_name"]), None)
        
        if not target_area:
            print(f"❌ ターゲットエリア {target_area_name} が見つかりません。")
            return
            
        print(f"👉 エリア {target_area['area_name']} のトップ画面へ遷移します...")
        utils.click_js(target_area["element"])
        time.sleep(3)
        
        # 2. 車両情報ページへの遷移
        print("⏳ 車両情報ページへの遷移ボタンをスキャン中...")
        if open_vehicle_page(driver):
            print("📥 車両情報ページに到達しました！")
            
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            debug_dir = ROOT_DIR / "debug"
            os.makedirs(debug_dir, exist_ok=True)
            
            # ページキャプチャ
            screenshot_path = debug_dir / f"worker_vehicles_{timestamp}.png"
            driver.save_screenshot(str(screenshot_path))
            print(f"📸 車両情報ページのスクリーンショットを保存しました: {screenshot_path}")
            
            html_path = debug_dir / f"worker_vehicles_{timestamp}.html"
            with open(html_path, "w", encoding="utf-8") as f:
                f.write(driver.page_source)
            print(f"📄 車両情報ページのHTMLを保存しました: {html_path}")
            
        else:
            print("❌ 車両情報ページに遷移できませんでした。")
            
    except Exception as e:
        print(f"❌ エラーが発生しました: {e}")
    finally:
        driver.quit()

if __name__ == "__main__":
    diagnose()
