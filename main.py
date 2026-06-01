# -*- coding: utf-8 -*-
import sys
import time
import argparse
import pandas as pd
from datetime import datetime
from src.config import Config
from src.browser import build_driver
from src.auth import login_and_get_areas
from src.scraper import open_vehicle_page, scrape_vehicle_page
from src.exporter import export_to_onedrive, upload_to_onedrive_web
from src.area_inspector import inspect_area_page
from src.worker_inspector import inspect_worker_login_page

def run_scraping(is_worker=False):
    """
    通常スクレイピング処理。
    1つのエリア情報を取得するごとにブラウザを終了し、状態の不整合を防ぐため
    ログインから順番にやり直す堅牢なアプローチをとります。
    """
    Config.validate(is_worker=is_worker)

    # 0. OneDrive から最新の『車両閾値設定.csv』をダウンロードしてローカル同期する
    from src.exporter import download_threshold_from_onedrive
    download_threshold_from_onedrive()
    
    if is_worker:
        # 一時的にConfigのURLとID/PWを作業員用にオーバーライド
        Config.ACCOUNT = Config.WORKER_ACCOUNT
        Config.PASSWORD = Config.WORKER_PASSWORD
        Config.TOP_PAGE = Config.WORKER_TOP_PAGE
        print("作業員モード（固定IP制限・VPNなし）で実行します...")

    # MAP_DATA_ONLY モードの場合、スクレイピングを全バイパスしてローカルの最新車両情報からマップデータ（JSON/JS）のみを再生成・再デプロイします
    if Config.RUN_MODE == "MAP_DATA_ONLY":
        print("\n[MAP_DATA_ONLY] モードが有効です。実機スクレイピング処理をスキップし、既存のローカル車両情報CSVから可視化用JSON/JSの生成とGitHub Pages更新のみを行います。")
        try:
            import glob
            import os
            vehicle_files = sorted(glob.glob(os.path.join(Config.OUTPUT_DIR, "車両情報_*.csv")))
            if not vehicle_files:
                print("Error: ローカルに『車両情報_*.csv』が存在しません。生成できませんでした。")
                return
            latest_vehicle_path = vehicle_files[-1]
            print(f"元データとして最新のローカルCSVを使用します: {os.path.basename(latest_vehicle_path)}")
            
            # ダッシュボード用データの生成
            print("ダッシュボード用データの自動生成を開始します...")
            from src.dashboard_generator import generate_dashboard_json
            json_path, js_path = generate_dashboard_json(latest_vehicle_path)
            
            if json_path and js_path:
                print("Success: [MAP_DATA_ONLY] ダッシュボード用JSONとJSのローカル生成に成功しました。")
            else:
                print("Error: [MAP_DATA_ONLY] ダッシュボード用データの生成に失敗しました。")
        except Exception as e:
            print(f"Error: [MAP_DATA_ONLY] 処理中に例外が発生しました: {e}")
        return

    start_time = datetime.now()
    print("=== ドコモ・バイクシェア 車両情報取得開始 ===")

    # 1. ログインして全エリアの一覧を取得
    print("エリア一覧の取得を開始します...")
    driver = build_driver()
    
    try:
        areas_info = login_and_get_areas(driver)
        area_names = [area["area_name"] for area in areas_info]
        print(f"管轄エリアを {len(area_names)} 個検出しました: {', '.join(area_names)}")
    except Exception as e:
        print(f"Error: 初期エリア一覧の取得に失敗しました: {e}")
        driver.quit()
        return

    all_data = []
    area_selection_url = driver.current_url  # ログイン後のエリア選択画面のURLを記憶

    # 2. 同一ブラウザセッションを用いて全エリアを連続巡回する超高速モード
    for idx, area_name in enumerate(area_names):
        if idx > 0:
            print("⏳ サーバー負荷軽減のため、3秒間待機します...")
            time.sleep(3)

        print(f"\n[{idx+1}/{len(area_names)}] エリア '{area_name}' の取得を開始します...")
        
        try:
            # エリア選択画面のURLに直接ジャンプし、セッションを維持したまま遷移
            if driver.current_url != area_selection_url:
                driver.get(area_selection_url)
                time.sleep(2)
            
            # エリア選択画面から再度エリアボタンの一覧を検出し、対象エリアをクリック
            from selenium.webdriver.common.by import By
            from src.auth import Locators
            
            # 再読み込み待機
            from selenium.webdriver.support.ui import WebDriverWait
            from selenium.webdriver.support import expected_conditions as EC
            WebDriverWait(driver, 15).until(EC.presence_of_element_located(Locators.BTN_TO_TOP))
            
            buttons = driver.find_elements(*Locators.BTN_TO_TOP)
            target_btn = None
            
            # ボタンの隣のテキスト（エリア名）を照合してターゲットの要素を特定
            for btn in buttons:
                try:
                    tr = btn.find_element(By.XPATH, "./ancestor::tr[1]")
                    tds = tr.find_elements(By.TAG_NAME, "td")
                    if len(tds) >= 2:
                        area_id = tds[0].text.strip()
                        area_real_name = tds[1].text.strip()
                        curr_name = f"{area_id}_{area_real_name}"
                        if curr_name == area_name:
                            target_btn = btn
                            break
                except Exception:
                    continue
            
            if not target_btn:
                # インデックスベースでのフォールバック特定
                if idx < len(buttons):
                    target_btn = buttons[idx]
                else:
                    print(f"Warning: エリア '{area_name}' のボタンを特定できませんでした。スキップします。")
                    continue

            # エリアの「トップ画面へ」をクリック
            print(f"エリア '{area_name}' のトップ画面へ遷移中...")
            driver.execute_script("arguments[0].click();", target_btn)
            time.sleep(2)
            
            # 車両情報ページへ遷移
            if open_vehicle_page(driver):
                print(f"車両情報をスクレイピング中...")
                df = scrape_vehicle_page(driver, area_name)
                all_data.append(df)
                print(f"Success: エリア '{area_name}' のデータ {len(df)} 件を取得しました。")
            else:
                print(f"Error: エリア '{area_name}' の車両情報ページを開けませんでした。")

        except Exception as e:
            print(f"Error: エリア '{area_name}' の処理中にエラーが発生しました: {e}")
            # エラー発生時はセッション切れを防ぐため、一度元のエリア選択URLへ強制復帰を試みる
            try:
                driver.get(area_selection_url)
            except Exception:
                pass
            
    # 全巡回完了後に初めてブラウザセッションを完全に終了
    driver.quit()

    # 3. データの統合と超高速マップ連携処理
    if all_data:
        print("\n💾 データを統合してCSVファイルに書き出しています...")
        try:
            output_path = export_to_onedrive(all_data)
            
            if output_path:
                # --- 【超高速マップ連携】最優先でマップ用 JSON と JS をローカル生成し、即時処理完了にする ---
                print("\n🔄 [最優先] マップ可視化用データの自動生成を開始します...")
                from src.dashboard_generator import generate_dashboard_json
                json_path, js_path = generate_dashboard_json(output_path)
                
                if json_path and js_path:
                    print("✅ マップデータのローカル生成に成功しました。この後 GitHub Actions 経由で GitHub Pages に即時デプロイされます！")
                
                # --- 【非同期型・蓄積用】時間のかかる OneDrive Web への CSV バックアップ転送は最後にゆっくり実行 ---
                print("\n📁 [バックアップ] 蓄積用データを OneDrive へアップロードします (約25秒)...")
                upload_to_onedrive_web(output_path)
                print("✅ OneDrive への蓄積用データのバックアップアップロード処理が完了しました。")

            elapsed = str(datetime.now() - start_time).split('.')[0]
            total_rows = sum(len(df) for df in all_data)
            
            print("\n=== スクレイピング実行完了 ===")
            print(f"- 実行作業時間: {elapsed}")
            print(f"- 取得総行数  : {total_rows} 件")
            print(f"- 保存先パス  : {output_path}")
            print("✅ 処理が正常に完了しました。")
        except Exception as e:
            print(f"❌ データの保存中にエラーが発生しました: {e}")
    else:
        print("\n❌ データを一件も取得できませんでした。")

def main():
    parser = argparse.ArgumentParser(description="ドコモ・バイクシェア 車両情報取得ツール")
    parser.add_argument(
        "--inspect",
        action="store_true",
        help="安全にログイン画面またはエリア選択画面を調査し、スクリーンショットとHTMLを保存します（データには触れません）"
    )
    parser.add_argument(
        "--admin",
        action="store_true",
        help="従来の事業者用管理画面（ENTSYS・要VPN）を使用して実行します"
    )
    parser.add_argument(
        "--gbfs",
        action="store_true",
        help="ドコモ・バイクシェアのGBFS APIからポート位置情報(ステーション情報)を取得し保存します"
    )
    args = parser.parse_args()

    # --gbfs が指定された場合の処理
    if args.gbfs:
        from src.gbfs_station_retriever import retrieve_gbfs_stations
        import os
        os.makedirs(Config.OUTPUT_DIR, exist_ok=True)  # 出力フォルダの存在保証
        json_path, csv_path = retrieve_gbfs_stations()
        if csv_path:
            # OneDriveへの自動アップロードも連動させる
            upload_to_onedrive_web(csv_path)
            # 必要であればJSONもアップロードする
            if json_path:
                upload_to_onedrive_web(json_path)
        return

    # デフォルトを作業員モード(is_worker=True)とする設計
    is_worker = not args.admin

    if is_worker:
        if args.inspect:
            inspect_worker_login_page()
        else:
            run_scraping(is_worker=True)
    else:
        if args.inspect:
            inspect_area_page()
        else:
            run_scraping(is_worker=False)

if __name__ == "__main__":
    main()
