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
    
    if is_worker:
        # 一時的にConfigのURLとID/PWを作業員用にオーバーライド
        Config.ACCOUNT = Config.WORKER_ACCOUNT
        Config.PASSWORD = Config.WORKER_PASSWORD
        Config.TOP_PAGE = Config.WORKER_TOP_PAGE
        print("💡 作業員モード（固定IP制限・VPNなし）で実行します...")

    start_time = datetime.now()
    print("=== ドコモ・バイクシェア 車両情報取得開始 ===")

    # 1. 最初に全エリアの数とエリア名を取得するために一度ログインする
    print("🔍 エリア一覧の取得を開始します...")
    driver = build_driver()
    try:
        areas_info = login_and_get_areas(driver)
        area_names = [area["area_name"] for area in areas_info]
        print(f"✅ 管轄エリアを {len(area_names)} 個検出しました: {', '.join(area_names)}")
    except Exception as e:
        print(f"❌ 初期エリア一覧の取得に失敗しました: {e}")
        return
    finally:
        driver.quit()

    all_data = []

    # 2. 各エリアについて個別にログインしてスクレイピングを行う（状態不整合を避ける安全設計）
    for idx, area_name in enumerate(area_names):
        if idx > 0:
            print("⏳ サーバー負荷軽減のため、3秒間待機します...")
            time.sleep(3)

        print(f"\n[{idx+1}/{len(area_names)}] 🔄 エリア '{area_name}' の取得を開始します...")
        
        driver = build_driver()
        try:
            # ログインとエリア一覧の再取得
            areas = login_and_get_areas(driver)
            
            # 該当するエリアのボタンを特定してクリック
            target_area = next((a for a in areas if a["area_name"] == area_name), None)
            if not target_area:
                print(f"⚠️ エリア '{area_name}' が見つかりません。スキップします。")
                continue

            # エリアの「トップ画面へ」をクリック
            print(f"👉 エリア '{area_name}' のトップ画面へ遷移中...")
            driver.execute_script("arguments[0].click();", target_area["element"])
            
            # 車両情報ページへ遷移
            if open_vehicle_page(driver):
                print(f"📥 車両情報をスクレイピング中...")
                df = scrape_vehicle_page(driver, area_name)
                all_data.append(df)
                print(f"✅ エリア '{area_name}' のデータ {len(df)} 件を取得しました。")
            else:
                print(f"❌ エリア '{area_name}' の車両情報ページを開けませんでした。")

        except Exception as e:
            print(f"❌ エリア '{area_name}' の処理中にエラーが発生しました: {e}")
        finally:
            driver.quit()

    # 3. データの統合とOneDriveへの書き出し
    if all_data:
        print("\n💾 データを統合してCSVファイルに書き出しています...")
        try:
            output_path = export_to_onedrive(all_data)
            
            # OneDriveへの自動アップロード実行
            if output_path:
                upload_to_onedrive_web(output_path)
                
                # --- [可視化自動連携] ダッシュボード用JSONの自動生成とOneDrive転送 ---
                print("\n🔄 ダッシュボード用データの自動生成とアップロードを開始します...")
                from src.dashboard_generator import generate_dashboard_json
                json_path, js_path = generate_dashboard_json(output_path)
                if json_path:
                    upload_to_onedrive_web(json_path)
                if js_path:
                    upload_to_onedrive_web(js_path)

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
        Config.validate(is_worker=False)  # 出力フォルダの保証など最低限の設定チェック
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
