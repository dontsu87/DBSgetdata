# -*- coding: utf-8 -*-
import os
from datetime import datetime
import pandas as pd
from src.config import Config

def export_to_onedrive(df_list: list[pd.DataFrame]) -> str:
    """
    全エリアのDataFrameリストを受け取り、1つのCSVに統合してOneDriveへ保存します。
    結合の際、最新のGBFSデータ（ポート情報）から `station_id` や `lat`(緯度), `lon`(経度) を紐付けて列追加します。
    引数:
        df_list (list of pd.DataFrame): 各エリアのスクレイピングデータ
    戻り値:
        str: 保存されたCSVファイルの絶対パス
    """
    if not df_list:
        print("保存するデータがありません。")
        return ""

    # 全データを統合
    combined_df = pd.concat(df_list, ignore_index=True)

    # --- GBFS ポート情報との紐付け処理 ---
    import glob
    # output/ ディレクトリ内の最新の gbfs_stations_*.csv を検索
    gbfs_files = sorted(glob.glob(os.path.join(Config.OUTPUT_DIR, "gbfs_stations_*.csv")))
    if gbfs_files:
        latest_gbfs_file = gbfs_files[-1]
        print(f"Info: 最新のGBFSデータをロードして紐付けを行います: {os.path.basename(latest_gbfs_file)}")
        try:
            df_gbfs = pd.read_csv(latest_gbfs_file)
            # ポート名をキーにするため、空白を排除したクレンジング用のキーを作成してマージします
            df_gbfs['join_key'] = df_gbfs['name'].astype(str).str.strip()
            combined_df['join_key'] = combined_df['ポート名'].astype(str).str.strip()
            
            # マージ用に必要なカラムだけを抽出
            df_gbfs_subset = df_gbfs[['join_key', 'station_id', 'lat', 'lon']].drop_duplicates(subset=['join_key'])
            
            # 左結合でマージ
            combined_df = pd.merge(combined_df, df_gbfs_subset, on='join_key', how='left')
            
            # 不要なキーを削除し、欠損値(NaN)を空文字等に置換
            combined_df.drop(columns=['join_key'], inplace=True)
            combined_df['station_id'] = combined_df['station_id'].fillna("")
            combined_df['lat'] = combined_df['lat'].fillna("")
            combined_df['lon'] = combined_df['lon'].fillna("")
            print("Success: GBFSポート情報（station_id, lat, lon）の紐付けに成功しました。")
        except Exception as e:
            print(f"Warning: GBFSデータとの紐付け中にエラーが発生しました（結合なしで保存します）: {e}")
            if 'join_key' in combined_df.columns:
                combined_df.drop(columns=['join_key'], inplace=True)
    else:
        print("Warning: GBFSデータ（gbfs_stations_*.csv）が見つからないため、紐付け処理をスキップします。")
        combined_df['station_id'] = ""
        combined_df['lat'] = ""
        combined_df['lon'] = ""

    # カラム順序を整理 (新しく追加した station_id, lat, lon も含める)
    columns_order = ['エリア名', '識別番号', '車両状態', 'ポート名', 'station_id', 'lat', 'lon', '電圧', 'AT通知受信日時']
    # 存在するカラムのみで再配置
    columns_order = [col for col in columns_order if col in combined_df.columns]
    combined_df = combined_df[columns_order]

    # 保存ファイル名を作成 (例: 車両情報_20260601_094500.csv)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"車両情報_{timestamp}.csv"
    output_path = os.path.join(Config.OUTPUT_DIR, filename)

    # フォルダの存在確認（Config.validate() で保証しているが念のため）
    os.makedirs(Config.OUTPUT_DIR, exist_ok=True)


    # CSV書き出し (BOM付きUTF-8でExcelで文字化けしないようにする)
    combined_df.to_csv(output_path, index=False, encoding="utf-8-sig")
    
    return output_path

def upload_to_onedrive_web(local_file_path: str) -> bool:
    """
    パスワード保護されたOneDrive의共有フォルダにアクセスし、
    対象のCSVファイルを自動でアップロードします。
    """
    if not Config.ONEDRIVE_SHARED_LINK:
        print("Warning: ONEDRIVE_SHARED_LINK が設定されていないため、Webアップロードをスキップします。")
        return False

    from src.browser import build_driver, BrowserUtils
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.common.exceptions import TimeoutException
    import time

    print(f"Info: OneDriveへの自動アップロード処理を開始します...")
    driver = build_driver()
    utils = BrowserUtils(driver)

    try:
        # 1. 共有リンクにアクセス
        print(f"Info: 共有リンクにアクセス中...")
        driver.get(Config.ONEDRIVE_SHARED_LINK)

        # 2. パスワード画面の処理
        try:
            print("Info: パスワード入力画面をスキャン中...")
            pwd_input = utils.W(8).until(
                EC.presence_of_element_located((By.CSS_SELECTOR, "input[type='password'], #sharepoint-password-input"))
            )
            print("Info: 共有リンクのパスワードを入力中...")
            pwd_input.clear()
            pwd_input.send_keys(Config.ONEDRIVE_PASSWORD)

            # 送信ボタンを特定してクリック
            btn = driver.find_element(
                By.CSS_SELECTOR,
                "input[type='submit'], button[type='submit'], input[value='確認'], input[value='Verify'], button.ms-Button--primary"
            )
            utils.click_js(btn)
            print("Info: パスワードを送信しました。")
        except TimeoutException:
            print("Info: パスワード入力画面は要求されませんでした。直接フォルダに進みます。")

        # 3. アップロードメニューのクリックとファイルの選択
        print("Info: アップロードボタンの表示を待機中...")
        upload_btn = utils.W(20).until(
            EC.element_to_be_clickable((By.CSS_SELECTOR, "button[data-automationid='uploadCommand']"))
        )
        print("Info: アップロードボタンをクリックします...")
        utils.click_js(upload_btn)

        print("Info: ファイル選択ボタンの表示を待機中...")
        file_btn = utils.W(10).until(
            EC.element_to_be_clickable((By.CSS_SELECTOR, "button[data-automationid='uploadFileCommand']"))
        )
        print("Info: ファイル選択ボタンをクリックします...")
        utils.click_js(file_btn)

        # インプット要素がDOMに生成・挿入されるまで待機
        time.sleep(2)

        # 4. アップロード用ファイルインプット要素の特定と送信
        print("Info: ファイルインプット要素をスキャン中...")
        file_input = utils.W(15).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, "input[type='file']"))
        )

        # ファイル送信（アップロード実行）
        abs_path = os.path.abspath(local_file_path)
        print(f"Info: ファイルを送信しています: {abs_path}")
        file_input.send_keys(abs_path)

        # 5. アップロード完了の待機
        print("Info: アップロードの完了を待機中 (約15秒)...")
        # OneDriveのWeb UI進捗バーや完了通知があるため、安全に15秒スリープし、かつ非同期処理の完了を待ちます
        time.sleep(15)

        print("Success: OneDriveへのファイルアップロードが正常に完了しました。")
        return True

    except Exception as e:
        print(f"Error: OneDriveへのアップロード中にエラーが発生しました: {e}")
        try:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            debug_dir = os.path.join(os.path.dirname(__file__), "..", "debug")
            os.makedirs(debug_dir, exist_ok=True)
            screenshot_path = os.path.join(debug_dir, f"onedrive_error_{timestamp}.png")
            driver.save_screenshot(screenshot_path)
            print(f"Error: エラー発生時のスクリーンショットを保存しました: {screenshot_path}")
            
            html_path = os.path.join(debug_dir, f"onedrive_error_{timestamp}.html")
            with open(html_path, "w", encoding="utf-8") as f:
                f.write(driver.page_source)
            print(f"Error: エラー発生時のHTMLを保存しました: {html_path}")
        except Exception as se:
            print(f"Warning: エラー画面のキャプチャに失敗しました: {se}")
        return False
    finally:
        driver.quit()
