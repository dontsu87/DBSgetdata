# -*- coding: utf-8 -*-
import sys
import time
import argparse
import pandas as pd
from datetime import datetime
from selenium.webdriver.common.by import By
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



    # 0. OneDrive から最新の『車両閾値設定.csv』をダウンロードしてローカル同期する処理は廃止し、
    #    ワークスペース上に保存された『車両閾値設定.csv』を直接読み込む方式としました。
    
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

    def _navigate_to_area_and_scrape(drv, idx, area_name, area_sel_url):
        """
        指定エリアの車両情報をスクレイピングして DataFrame を返す。
        失敗した場合は None を返す。
        """
        from selenium.webdriver.common.by import By
        from src.auth import Locators
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC

        # エリア選択画面に戻る（既にいる場合はスキップ）
        try:
            current = drv.current_url
        except Exception:
            current = ""

        if current != area_sel_url:
            drv.get(area_sel_url)
            time.sleep(2)

        # エリア選択画面の読み込み完了を待つ
        WebDriverWait(drv, 20).until(EC.presence_of_element_located(Locators.BTN_TO_TOP))
        time.sleep(1)  # DOM 安定化のための追加待機

        buttons = drv.find_elements(*Locators.BTN_TO_TOP)
        target_btn = None

        for btn in buttons:
            try:
                tr = btn.find_element(By.XPATH, "./ancestor::tr[1]")
                tds = tr.find_elements(By.TAG_NAME, "td")
                if len(tds) >= 2:
                    area_id = tds[0].text.strip()
                    area_real_name = tds[1].text.strip()
                    if f"{area_id}_{area_real_name}" == area_name:
                        target_btn = btn
                        break
            except Exception:
                continue

        if not target_btn:
            if idx < len(buttons):
                target_btn = buttons[idx]
            else:
                print(f"Warning: エリア '{area_name}' のボタンを特定できませんでした。スキップします。")
                return None

        print(f"エリア '{area_name}' のトップ画面へ遷移中...")
        drv.execute_script("arguments[0].click();", target_btn)
        time.sleep(2)

        if open_vehicle_page(drv):
            print(f"車両情報をスクレイピング中...")
            df = scrape_vehicle_page(drv, area_name)
            
            return df
        else:
            print(f"Error: エリア '{area_name}' の車両情報ページを開けませんでした。")
            return None

    # 2. 同一ブラウザセッションを用いて全エリアを連続巡回する。
    #    各エリアの処理完了後に明示的に「ログアウト」を行うことで、ブラウザ再起動の無駄な待機時間を無くし、
    #    セッションの不整合によるChromeクラッシュを防止して超高速化を実現します。
    
    for idx, area_name in enumerate(area_names):
        if idx > 0:
            print("Waiting 3 seconds to reduce server load...")
            time.sleep(3)
            
            # 2回目以降の巡回では、ログアウト後のログイン画面から再ログインしてエリア選択画面に入ります
            print(f"\n次のエリアのために再ログインを実行しています...")
            try:
                areas_info_retry = login_and_get_areas(driver)
            except Exception as e:
                print(f"Error: 再ログインに失敗しました。ブラウザを再起動して復旧を試みます: {e}")
                try:
                    driver.quit()
                except Exception:
                    pass
                time.sleep(3)
                driver = build_driver()
                login_and_get_areas(driver)

        print(f"\n[{idx+1}/{len(area_names)}] エリア '{area_name}' の取得を開始します...")

        # ログイン後のエリア選択画面のURLをカレントURLから取得
        area_selection_url = driver.current_url

        try:
            df = _navigate_to_area_and_scrape(driver, idx, area_name, area_selection_url)
            if df is not None:
                all_data.append(df)
                print(f"Success: エリア '{area_name}' のデータ {len(df)} 件を取得しました。")

        except Exception as e:
            err_msg = str(e)
            print(f"Error: エリア '{area_name}' の処理中にエラーが発生しました: {err_msg[:200]}")

            # Chrome クラッシュを検出（空メッセージ＋スタックトレースのパターン）
            is_chrome_crash = (
                "Message: \n" in err_msg
                or err_msg.strip() == ""
                or "unknown" in err_msg.lower()
                or "session" in err_msg.lower()
            )

            if is_chrome_crash:
                print(f"Chrome のクラッシュを検出しました。ブラウザを再起動して再ログインします...")
                try:
                    driver.quit()
                except Exception:
                    pass

                time.sleep(3)
                try:
                    driver = build_driver()
                    areas_info_retry = login_and_get_areas(driver)
                    area_selection_url = driver.current_url
                    print(f"再ログイン成功。エリア '{area_name}' の処理を再試行します...")

                    # 再ログイン後に同じエリアを再試行
                    df = _navigate_to_area_and_scrape(driver, idx, area_name, area_selection_url)
                    if df is not None:
                        all_data.append(df)
                        print(f"Success (再試行): エリア '{area_name}' のデータ {len(df)} 件を取得しました。")
                except Exception as retry_err:
                    print(f"Error: 再試行にも失敗しました: {retry_err}")

        finally:
            # 正常終了か例外発生かにかかわらず、次のエリアへ行く前に明示的に「ログアウト」してセッションを綺麗にする
            # (最後のエリアの場合はループを抜けてから通常終了するためログアウトは省略)
            if idx < len(area_names) - 1:
                print("🚪 セッション切替のため、ログアウト処理を実行しています...")
                try:
                    # ログアウトボタン（input[value='ログアウト']）を探してクリック
                    logout_btn = driver.find_element(By.CSS_SELECTOR, "input[value='ログアウト']")
                    driver.execute_script("arguments[0].click();", logout_btn)
                    time.sleep(2)
                except Exception as le:
                    print(f"Warning: ログアウト処理中にエラーが発生しました（後続の再ログイン処理でリカバリします）: {le}")

    # 全巡回完了後にブラウザセッションを終了
    try:
        driver.quit()
    except Exception:
        pass

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
                
                # --- 【非同期型・蓄積用】時間のかかる OneDrive Web への CSV バックアップ転送は日次マージへ移行したため、5分ごとはスキップ ---
                # print("\n📁 [バックアップ] 蓄積用データを OneDrive へアップロードします (約25秒)...")
                # upload_to_onedrive_web(output_path)
                # print("✅ OneDrive への蓄積用データのバックアップアップロード処理が完了しました。")
                print("ℹ️ 5分ごとの OneDrive への生CSVアップロードはスキップします（日次マージにてParquet形式でまとめてアップロードされます）。")


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

def check_and_run_daily_gbfs():
    """
    前回のGBFSデータ取得から日付が変わっている場合、
    自動的にGBFSデータ取得とOneDriveへのアップロードを実行します。
    """
    import os
    from datetime import datetime
    from src.gbfs_station_retriever import retrieve_gbfs_stations
    from src.exporter import upload_to_onedrive_web

    last_run_file = "last_gbfs_run.txt"
    today_str = datetime.now().strftime("%Y-%m-%d")
    
    # 前回実行日の読み込み
    last_run_date = ""
    if os.path.exists(last_run_file):
        try:
            with open(last_run_file, "r", encoding="utf-8") as f:
                last_run_date = f.read().strip()
        except Exception as e:
            print(f"Warning: 前回実行日の読み込みに失敗しました: {e}")

    # 日付が変わっていれば実行
    if today_str != last_run_date:
        print("\n[Daily GBFS] 日付が変わったため、GBFSポート情報を取得します...")
        try:
            json_path, csv_path = retrieve_gbfs_stations()
            if csv_path:
                upload_to_onedrive_web(csv_path)
            if json_path:
                upload_to_onedrive_web(json_path)
            
            # 日付が変わったため、前日分の車両情報データをマージしてParquetアップロード
            print("\n[Daily Battery Merge] 前日分の車両情報のマージ処理を開始します...")
            try:
                from src.exporter import merge_and_upload_daily_logs
                merge_and_upload_daily_logs()
                print("[Daily Battery Merge] 完了しました。")
            except Exception as me:
                print(f"[Daily Battery Merge] 処理中にエラーが発生しました: {me}")

            # 実行日記録を更新
            with open(last_run_file, "w", encoding="utf-8") as f:
                f.write(today_str)
            print("[Daily GBFS] 完了しました。")
        except Exception as e:
            print(f"[Daily GBFS] 処理中にエラーが発生しました: {e}")


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
    parser.add_argument(
        "--bike-types",
        action="store_true",
        help="事業者用管理画面から自転車ごとの車種および車種設定マスタを取得し保存します"
    )
    parser.add_argument(
        "--merge-daily",
        action="store_true",
        help="指定された日付（デフォルトは昨日）の5分ごとCSVログをマージし、Parquet形式でOneDriveへアップロードします"
    )
    parser.add_argument(
        "--date",
        type=str,
        default=None,
        help="--merge-dailyでマージする日付を指定します (例: 20260624)"
    )
    parser.add_argument(
        "--merge-historical",
        action="store_true",
        help="過去の5分ごとCSVログを一括マージし、Parquet形式でOneDriveへアップロードします"
    )
    parser.add_argument(
        "--until",
        type=str,
        default=None,
        help="--merge-historicalでマージ対象の上限とするファイル名（このファイルを含めてそれ以前を対象とする）を指定します (例: 車両情報_20260625_120000.csv)"
    )
    args = parser.parse_args()

    # --merge-daily が指定された場合の処理
    if args.merge_daily:
        from src.exporter import merge_and_upload_daily_logs
        merge_and_upload_daily_logs(args.date)
        return

    # --merge-historical が指定された場合の処理
    if args.merge_historical:
        if not args.until:
            print("Error: --merge-historical を実行するには、--until <ファイル名> で上限とするファイル名を指定してください。")
            return
        from src.exporter import merge_and_upload_historical_logs
        merge_and_upload_historical_logs(args.until)
        return

    # --bike-types が指定された場合の処理
    if args.bike_types:
        from src.bike_type_retriever import run_bike_types_scraping
        run_bike_types_scraping()
        return


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
            check_and_run_daily_gbfs()
    else:
        if args.inspect:
            inspect_area_page()
        else:
            run_scraping(is_worker=False)
            check_and_run_daily_gbfs()

if __name__ == "__main__":
    main()
