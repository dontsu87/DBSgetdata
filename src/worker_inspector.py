# -*- coding: utf-8 -*-
import os
import time
from datetime import datetime
from bs4 import BeautifulSoup
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from src.browser import build_driver, BrowserUtils
from src.config import Config

def inspect_worker_login_page():
    """
    作業員用ログインページのレイアウトおよびフォーム要素を安全に調査します。
    """
    Config.validate(is_worker=True)
    print("🚀 作業員用ページ調査用ブラウザを起動しています...")
    driver = build_driver()
    utils = BrowserUtils(driver)
    
    try:
        # 1. ログインページへアクセス
        print(f"🔗 作業員用ログインページにアクセス中: {Config.WORKER_TOP_PAGE}")
        driver.get(Config.WORKER_TOP_PAGE)
        
        # ロード時間を少し設ける
        time.sleep(3)
        
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        debug_dir = os.path.join(os.path.dirname(__file__), "..", "debug")
        os.makedirs(debug_dir, exist_ok=True)
        
        # スクリーンショットの保存
        screenshot_path = os.path.join(debug_dir, f"worker_login_{timestamp}.png")
        driver.save_screenshot(screenshot_path)
        print(f"📸 ログイン画面のスクリーンショットを保存しました: {screenshot_path}")
        
        # HTMLの保存
        html_path = os.path.join(debug_dir, f"worker_login_{timestamp}.html")
        with open(html_path, "w", encoding="utf-8") as f:
            f.write(driver.page_source)
        print(f"📄 ログイン画面のHTMLを保存しました: {html_path}")
        
        # フォーム要素の解析
        soup = BeautifulSoup(driver.page_source, "html.parser")
        inputs = soup.find_all("input")
        
        print("\n🔍 検出された入力要素一覧:")
        log_lines = []
        log_lines.append(f"作業員ログイン画面入力要素数: {len(inputs)}")
        
        for idx, inp in enumerate(inputs):
            attrs_str = ", ".join([f"{k}='{v}'" for k, v in inp.attrs.items()])
            log_line = f"Input {idx+1}: name='{inp.get('name', 'N/A')}', id='{inp.get('id', 'N/A')}', type='{inp.get('type', 'N/A')}', attrs=[{attrs_str}]"
            print(f"  - {log_line}")
            log_lines.append(log_line)
            
        # 調査結果テキストファイルの書き出し
        result_path = os.path.join(debug_dir, f"worker_login_analysis_{timestamp}.txt")
        with open(result_path, "w", encoding="utf-8") as f:
            f.write("\n".join(log_lines))
        print(f"📝 解析ログを保存しました: {result_path}")
        
        # 2. 自動ログイン試行 (一般的なID/PW属性名で試行)
        print("\n🔑 一般的な属性名を用いてログインを試行します...")
        
        # フォーム入力候補の探索
        account_selectors = ["Account", "UserID", "loginId", "username", "account"]
        password_selectors = ["Password", "password", "pwd"]
        submit_selectors = ["input[type='submit']", "button[type='submit']", "input[value='ログイン']"]
        
        account_elem = None
        for sel in account_selectors:
            try:
                account_elem = driver.find_element(By.NAME, sel) or driver.find_element(By.ID, sel)
                if account_elem:
                    print(f"  -> アカウント入力欄を特定: name/id='{sel}'")
                    break
            except Exception:
                pass
                
        password_elem = None
        for sel in password_selectors:
            try:
                password_elem = driver.find_element(By.NAME, sel) or driver.find_element(By.ID, sel)
                if password_elem:
                    print(f"  -> パスワード入力欄を特定: name/id='{sel}'")
                    break
            except Exception:
                pass
                
        submit_elem = None
        for sel in submit_selectors:
            try:
                submit_elem = driver.find_element(By.CSS_SELECTOR, sel)
                if submit_elem:
                    print(f"  -> 送信ボタンを特定: '{sel}'")
                    break
            except Exception:
                pass
                
        if account_elem and password_elem and submit_elem:
            account_elem.clear()
            account_elem.send_keys(Config.WORKER_ACCOUNT)
            password_elem.clear()
            password_elem.send_keys(Config.WORKER_PASSWORD)
            
            print("👉 ログイン情報を送信します...")
            utils.click_js(submit_elem)
            time.sleep(5)
            
            # ログイン後の画面キャプチャ
            timestamp_after = datetime.now().strftime("%Y%m%d_%H%M%S")
            screenshot_after_path = os.path.join(debug_dir, f"worker_dashboard_{timestamp_after}.png")
            driver.save_screenshot(screenshot_after_path)
            print(f"📸 ログイン後（ダッシュボード）のスクリーンショットを保存しました: {screenshot_after_path}")
            
            html_after_path = os.path.join(debug_dir, f"worker_dashboard_{timestamp_after}.html")
            with open(html_after_path, "w", encoding="utf-8") as f:
                f.write(driver.page_source)
            print(f"📄 ログイン後（ダッシュボード）のHTMLを保存しました: {html_after_path}")
            print("\n✅ 安全なログイン試行と遷移画面ダンプが正常に完了しました。")
        else:
            print("❌ 入力欄または送信ボタンが特定できなかったため、自動ログインをスキップしました。")
            print("※ 保存されたHTMLとスクリーンショットを元に、入力項目の名前を特定します。")
            
    except Exception as e:
        print(f"❌ 調査中にエラーが発生しました: {e}")
    finally:
        driver.quit()

if __name__ == "__main__":
    inspect_worker_login_page()
