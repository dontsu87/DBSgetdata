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

    # --- 同一ポート継続利用時間の計算処理 ＆ バッテリー交換検知 ---
    import json
    from src.config import ROOT_DIR
    
    # 継続利用時間用の前回データ取得 (従来通り dashboard_data.json から)
    json_path = os.path.join(str(ROOT_DIR), "dashboard_data.json")
    prev_unlocked = {}
    if os.path.exists(json_path):
        try:
            with open(json_path, "r", encoding="utf-8") as f:
                prev_data = json.load(f)
            for port in prev_data.get("ports", []):
                p_name = port.get("port_name", "").strip()
                for bike in port.get("bikes", []):
                    b_id = bike.get("bike_id", "").strip()
                    started_at = bike.get("unlocked_started_at", "")
                    status = bike.get("status", "").strip()
                    if b_id:
                        prev_unlocked[b_id] = {
                            "port_name": p_name,
                            "unlocked_started_at": started_at,
                            "status": status
                        }
        except Exception as e:
            print(f"Warning: 前回の dashboard_data.json の読み込みに失敗しました (継続利用時間はリセットされます): {e}")

    # 対策1: 最新の「車両情報_*.csv」を探索して前回電圧を取得
    prev_battery_info = {} # bike_id -> { "voltage": float_or_none }
    csv_files = sorted(glob.glob(os.path.join(Config.OUTPUT_DIR, "車両情報_*.csv")))
    if csv_files:
        latest_csv = csv_files[-1]
        print(f"Info: 前回電圧の参照先として最新のCSVファイルをロードします: {os.path.basename(latest_csv)}")
        try:
            df_prev = pd.read_csv(latest_csv, encoding="utf-8-sig")
            if "識別番号" in df_prev.columns and "電圧" in df_prev.columns:
                for _, row in df_prev.iterrows():
                    b_id = str(row["識別番号"]).strip()
                    volt = row["電圧"]
                    try:
                        v_float = float(volt) if pd.notna(volt) else None
                    except (ValueError, TypeError):
                        v_float = None
                    
                    if b_id:
                        prev_battery_info[b_id] = {
                            "voltage": v_float
                        }
        except Exception as e:
            print(f"Warning: 最新CSVファイルの読み込みに失敗しました: {e}")
    else:
        print("Info: 過去の車両情報CSVが見つかりません。前回電圧は空として扱います。")

    # 対策2: 交換履歴専用ファイル battery_replacements.json の導入
    replacements_json_path = os.path.join(Config.OUTPUT_DIR, "battery_replacements.json")
    replacements = {}
    if os.path.exists(replacements_json_path):
        try:
            with open(replacements_json_path, "r", encoding="utf-8") as f:
                replacements = json.load(f)
        except Exception as e:
            print(f"Warning: battery_replacements.json の読み込みに失敗しました: {e}")

    # 24時間以上古い履歴レコードを battery_replacements.json から削除（自動クレンジング）
    now_dt = datetime.now()
    cleaned_replacements = {}
    for b_id, rep_info in replacements.items():
        rep_at_str = rep_info.get("replaced_at", "")
        if rep_at_str:
            try:
                rep_dt = datetime.strptime(rep_at_str, "%Y-%m-%d %H:%M:%S")
                if (now_dt - rep_dt).total_seconds() < 24 * 3600:
                    cleaned_replacements[b_id] = rep_info
            except Exception:
                cleaned_replacements[b_id] = rep_info
        else:
            cleaned_replacements[b_id] = rep_info
    replacements = cleaned_replacements

    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    unlocked_started_list = []
    consecutive_duration_list = []
    
    # バッテリー交換用リスト
    replace_orig_list = []
    replace_incr_list = []
    replace_time_list = []

    for idx, row in combined_df.iterrows():
        b_id = str(row['識別番号']).strip()
        p_name = str(row['ポート名']).strip()
        status = str(row['車両状態']).strip()
        
        # 電圧の取得
        try:
            curr_volt = float(row['電圧'])
        except (ValueError, TypeError):
            curr_volt = None
        
        # 1. 継続利用時間の計算
        started_at = ""
        duration = 0
        
        if status == "利用中":
            if b_id in prev_unlocked:
                prev = prev_unlocked[b_id]
                if prev["port_name"] == p_name and prev["status"] == "利用中":
                    started_at = prev["unlocked_started_at"]
                    if not started_at:
                        started_at = now_str
                    try:
                        started_dt = datetime.strptime(started_at, "%Y-%m-%d %H:%M:%S")
                        duration = int((now_dt - started_dt).total_seconds())
                    except Exception:
                        duration = 0
                else:
                    started_at = now_str
                    duration = 0
            else:
                started_at = now_str
                duration = 0
        
        unlocked_started_list.append(started_at)
        consecutive_duration_list.append(duration if duration > 0 else "")
        
        # 2. バッテリー交換の検知
        orig_v = ""
        incr_v = ""
        rep_time = ""
        
        # 履歴情報があれば引き継ぎ
        if b_id in replacements:
            rep_info = replacements[b_id]
            orig_v = rep_info.get("replace_original_volt", "")
            incr_v = rep_info.get("replace_increased_volt", "")
            rep_time = rep_info.get("replaced_at", "")
        
        # 電圧上昇の検知
        if b_id in prev_battery_info:
            prev_info = prev_battery_info[b_id]
            prev_volt = prev_info["voltage"]
            
            # 電圧上昇の検知 (動的閾値 ＆ 交換後高電圧判定)
            if curr_volt is not None and prev_volt is not None:
                # 閾値が取得できない場合のフォールバック値 (最新CSVには thresholds が入っていないため、必ずフォールバックに入る)
                if prev_volt >= 30.0:
                    strong_th = 35.9
                    lv1_th = 36.5
                else:
                    strong_th = 25.2
                    lv1_th = 25.9
                
                # 交換前の電圧に基づき、必要な電圧上昇幅を決定
                if prev_volt > strong_th:
                    required_rise = 3.0
                else:
                    required_rise = 1.5
                
                # 上昇幅を満たし、かつ交換後の電圧が「高」以上（lv1超）であること
                if (curr_volt - prev_volt >= required_rise) and (curr_volt > lv1_th):
                    # 交換検知：情報をオーバーライド
                    orig_v = prev_volt
                    incr_v = curr_volt
                    rep_time = now_str
                    
                    # replacements に追加
                    replacements[b_id] = {
                        "replace_original_volt": orig_v,
                        "replace_increased_volt": incr_v,
                        "replaced_at": rep_time
                    }
                    
        replace_orig_list.append(orig_v)
        replace_incr_list.append(incr_v)
        replace_time_list.append(rep_time)

    # battery_replacements.json に書き出し保存
    try:
        with open(replacements_json_path, "w", encoding="utf-8") as f:
            json.dump(replacements, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"Warning: battery_replacements.json の書き込みに失敗しました: {e}")

    combined_df['連続利用開始日時'] = unlocked_started_list
    combined_df['同一ポート継続利用時間(秒)'] = consecutive_duration_list
    
    # バッテリー交換情報をDataFrameへ追加
    combined_df['交換前電圧'] = replace_orig_list
    combined_df['交換後電圧'] = replace_incr_list
    combined_df['交換日時'] = replace_time_list

    # カラム順序を整理 (新しく追加した station_id, lat, lon, AT種別, 連続利用開始日時, 同一ポート継続利用時間(秒), 交換前電圧, 交換後電圧, 交換日時 も含める)
    columns_order = ['エリア名', '識別番号', '車両状態', 'ポート名', 'station_id', 'lat', 'lon', '電圧', 'AT通知受信日時', 'AT種別', '連続利用開始日時', '同一ポート継続利用時間(秒)', '交換前電圧', '交換後電圧', '交換日時']

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
    driver = None
    try:
        driver = build_driver()
        utils = BrowserUtils(driver)
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
            time.sleep(5)
        except TimeoutException:
            print("Info: パスワード入力画面は要求されませんでした。直接フォルダに進みます。")

        # 2.5 子フォルダへのナビゲーション (車両情報 or GBFS)
        filename = os.path.basename(local_file_path)
        subfolder_name = None
        if "車両情報" in filename:
            subfolder_name = "車両情報"
        elif "gbfs" in filename.lower() or "station" in filename.lower():
            subfolder_name = "GBFS"

        if subfolder_name:
            print(f"Info: 子フォルダ「{subfolder_name}」へのURL直接遷移を開始します...")
            try:
                # 初期フォルダの読み込み完了（URLリダイレクト）を待機
                utils.W(15).until(
                    EC.presence_of_element_located((By.CSS_SELECTOR, "[role='row'], [role='gridcell']"))
                )
                time.sleep(3)
                
                from urllib.parse import urlparse, parse_qs, urlencode, urlunparse
                current_url = driver.current_url
                parsed = urlparse(current_url)
                params = parse_qs(parsed.query)
                
                if 'id' in params:
                    root_path = params['id'][0]
                    subfolder_path = root_path + "/" + subfolder_name
                    new_params = params.copy()
                    new_params['id'] = [subfolder_path]
                    
                    new_query = urlencode(new_params, doseq=True)
                    subfolder_url = urlunparse((
                        parsed.scheme,
                        parsed.netloc,
                        parsed.path,
                        parsed.params,
                        new_query,
                        parsed.fragment
                    ))
                    
                    print(f"Info: 子フォルダのURLに直接遷移します: {subfolder_url}")
                    driver.get(subfolder_url)
                    
                    # 遷移後の読み込みを待機
                    utils.W(15).until(
                        EC.presence_of_element_located((By.CSS_SELECTOR, "[role='row'], [role='gridcell']"))
                    )
                    time.sleep(3)
                    print(f"Success: 子フォルダ「{subfolder_name}」へのURL直接遷移が完了しました。")
                else:
                    print("Warning: URLに'id'パラメータが見つからないため、ルートにアップロードします。")
            except Exception as ex:
                print(f"Warning: 直接URL遷移中にエラーが発生したため、ルートフォルダへのアップロードに切り替えます: {ex}")

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
        if driver:
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
        if driver:
            driver.quit()

def download_threshold_from_onedrive() -> bool:
    """
    OneDriveのルートフォルダから最新の「車両閾値設定.csv」をダウンロードし、
    プロジェクトのルートフォルダへ保存（上書き）します。
    """
    if not Config.ONEDRIVE_SHARED_LINK:
        print("Warning: ONEDRIVE_SHARED_LINK が設定されていないため、閾値設定のダウンロードをスキップします。")
        return False

    from src.config import ROOT_DIR
    # テスト高速化モード: OneDriveのログイン・WebUIロード処理をスキップして既存のローカルファイルを利用する
    if Config.RUN_MODE == "MAP_DATA_ONLY":
        local_path = os.path.join(str(ROOT_DIR), "車両閾値設定.csv")
        if os.path.exists(local_path):
            print("Success: [MAP_DATA_ONLY] モードが有効です。OneDriveダウンロードをスキップし、ローカルの既存の『車両閾値設定.csv』をそのまま使用します。")
            return True
        else:
            print("Warning: [MAP_DATA_ONLY] モードですが、ローカルに『車両閾値設定.csv』が存在しません。OneDriveからダウンロードを試みます。")

    from src.browser import build_driver, BrowserUtils
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.common.exceptions import TimeoutException
    import time
    import glob

    # まずローカルの古い「車両閾値設定.csv」があれば退避または削除する
    local_path = os.path.join(str(ROOT_DIR), "車両閾値設定.csv")
    backup_path = os.path.join(str(ROOT_DIR), "車両閾値設定_backup.csv")
    if os.path.exists(local_path):
        try:
            if os.path.exists(backup_path):
                os.remove(backup_path)
            os.rename(local_path, backup_path)
            print("Info: ローカルの既存の閾値設定ファイルをバックアップへ退避しました。")
        except Exception as e:
            print(f"Warning: 既存ファイルの退避に失敗しました: {e}")

    print("Info: OneDriveから「車両閾値設定.csv」のダウンロードを開始します...")
    driver = None
    try:
        driver = build_driver()
        utils = BrowserUtils(driver)
        # 1. 共有リンクにアクセス
        driver.get(Config.ONEDRIVE_SHARED_LINK)

        # 2. パスワード画面の処理
        try:
            pwd_input = utils.W(8).until(
                EC.presence_of_element_located((By.CSS_SELECTOR, "input[type='password'], #sharepoint-password-input"))
            )
            pwd_input.clear()
            pwd_input.send_keys(Config.ONEDRIVE_PASSWORD)
            btn = driver.find_element(
                By.CSS_SELECTOR,
                "input[type='submit'], button[type='submit'], input[value='確認'], input[value='Verify'], button.ms-Button--primary"
            )
            utils.click_js(btn)
            time.sleep(5)
        except TimeoutException:
            pass

        # 3. フォルダ一覧の読み込みを待機
        utils.W(15).until(
            EC.presence_of_element_located((By.CSS_SELECTOR, "[role='row'], [role='gridcell']"))
        )
        time.sleep(3)

        # 4. 「車両閾値設定.csv」の行要素を探してクリック（選択）
        target_name = "車両閾値設定.csv"
        xpath_exprs = [
            f"//span[contains(text(), '{target_name}')]",
            f"//*[text()='{target_name}']",
            f"//button[contains(text(), '{target_name}')]"
        ]
        
        file_element = None
        for xpath in xpath_exprs:
            try:
                el = driver.find_element(By.XPATH, xpath)
                if el.is_displayed():
                    file_element = el
                    break
            except Exception:
                continue

        if not file_element:
            print(f"Error: OneDrive上に「{target_name}」が見つかりませんでした。バックアップを復元します。")
            if os.path.exists(backup_path):
                os.rename(backup_path, local_path)
            return False

        # ファイル要素をクリックして「選択」する
        print("Info: ファイル要素を選択します...")
        utils.click_js(file_element)
        time.sleep(2)

        # 5. ダウンロードボタンをクリック
        print("Info: ダウンロードボタンの表示を待機中...")
        download_btn = utils.W(10).until(
            EC.element_to_be_clickable((By.CSS_SELECTOR, "button[data-automationid='downloadCommand']"))
        )
        print("Info: ダウンロードを開始します...")
        utils.click_js(download_btn)

        # ダウンロード完了を待機 (最大15秒)
        print("Info: ダウンロード完了を待機中...")
        for _ in range(15):
            # Chromeのダウンロード中一時ファイルがないか、かつ目的のファイルが存在するかチェック
            if os.path.exists(local_path) and not any(".crdownload" in f for f in os.listdir(str(ROOT_DIR))):
                print("Success: OneDriveからの「車両閾値設定.csv」のダウンロードが正常に完了しました！")
                if os.path.exists(backup_path):
                    os.remove(backup_path) # 不要になったバックアップを削除
                return True
            time.sleep(1)

        print("Error: ダウンロードがタイムアウトしました。バックアップを復元します。")
        if os.path.exists(backup_path):
            if os.path.exists(local_path):
                os.remove(local_path)
            os.rename(backup_path, local_path)
        return False

    except Exception as e:
        print(f"Error: 閾値設定ファイルのダウンロード中に例外が発生しました: {e}")
        if os.path.exists(backup_path) and not os.path.exists(local_path):
            os.rename(backup_path, local_path)
        return False
    finally:
        if driver:
            driver.quit()


def merge_and_upload_daily_logs(target_date_str: str = None) -> bool:
    """
    指定された日付（未指定の場合は昨日）の5分ごとCSVログを
    1時間ごとの代表値（方式1）に集約し、車種情報を紐づけて、Parquet形式でOneDriveへアップロードします。
    """
    import glob
    from datetime import datetime, timedelta
    from src.config import ROOT_DIR

    if not target_date_str:
        # デフォルトは昨日
        target_date_str = (datetime.now() - timedelta(days=1)).strftime("%Y%m%d")

    print(f"Info: {target_date_str} の日次データマージ処理を開始します...")
    
    # 対象ファイルの探索
    pattern = os.path.join(Config.OUTPUT_DIR, f"車両情報_{target_date_str}_*.csv")
    csv_files = sorted(glob.glob(pattern))
    
    if not csv_files:
        print(f"Warning: {target_date_str} に対する車両情報CSVが見つかりません。")
        return False
        
    print(f"Info: {len(csv_files)} 個のファイルをマージします。")
    
    # マージ処理
    df_list = []
    for filepath in csv_files:
        try:
            # ファイル名から取得日時をパース (例: 車両情報_20260624_150000.csv -> 2026-06-24 15:00:00)
            basename = os.path.basename(filepath)
            time_part = basename.replace("車両情報_", "").replace(".csv", "") # 20260624_150000
            get_time = datetime.strptime(time_part, "%Y%m%d_%H%M%S")
            
            df = pd.read_csv(filepath, encoding="utf-8-sig")
            df["取得日時_生"] = get_time
            # 取得日時を1時間単位に丸める
            df["取得日時"] = get_time.replace(minute=0, second=0, microsecond=0)
            df_list.append(df)
        except Exception as e:
            print(f"Warning: ファイルの読み込みに失敗しました: {filepath}, {e}")
            
    if not df_list:
        print("Error: 読み込み可能なデータが存在しませんでした。")
        return False
        
    combined_df = pd.concat(df_list, ignore_index=True)
    
    # サンプル数（集約元の数）をカウント
    df_counts = combined_df.groupby(["識別番号", "取得日時"]).size().reset_index(name="サンプル数")
    
    # 方式1: 1時間ごとの代表値の抽出
    # 各車両（識別番号）および丸めた取得日時ごとに、最も遅い「取得日時_生」のレコードを残す
    combined_df = combined_df.sort_values("取得日時_生")
    combined_df = combined_df.drop_duplicates(subset=["識別番号", "取得日時"], keep="last")
    
    # サンプル数をマージ
    combined_df = pd.merge(combined_df, df_counts, on=["識別番号", "取得日時"], how="left")
    combined_df.drop(columns=["取得日時_生"], inplace=True, errors="ignore")

    
    # 車種情報の紐付け
    threshold_path = os.path.join(str(ROOT_DIR), "車両閾値設定.csv")
    if os.path.exists(threshold_path):
        try:
            # BOM付きUTF-8などで読み込む
            df_th = pd.read_csv(threshold_path, encoding="utf-8-sig")
            # 重複を排除
            df_th = df_th.drop_duplicates(subset=["車両識別番号"])
            
            # 車種情報と閾値列がすでにある場合は、マージ前に削除して上書きする
            th_cols = ["車種名", "閾値_AT異常", "閾値_画面強調", "閾値_Lv1", "閾値_Lv2", "閾値_Lv3"]
            combined_df = combined_df.drop(columns=[c for c in th_cols if c in combined_df.columns], errors="ignore")
            
            combined_df = pd.merge(
                combined_df,
                df_th[["車両識別番号"] + th_cols],
                left_on="識別番号",
                right_on="車両識別番号",
                how="left"
            )
            # 重複キー列を削除
            combined_df.drop(columns=["車両識別番号"], inplace=True, errors="ignore")
            print("Success: 車両閾値設定マスタとの紐付けに成功しました。")
        except Exception as e:
            print(f"Warning: 車種閾値設定マスタとの紐付け中にエラーが発生しました: {e}")
            
    # Parquet保存
    parquet_filename = f"車両情報_{target_date_str}.parquet"
    parquet_path = os.path.join(Config.OUTPUT_DIR, parquet_filename)
    
    try:
        combined_df.to_parquet(parquet_path, index=False)
        print(f"Success: Parquetファイルを保存しました: {parquet_path}")
    except Exception as e:
        print(f"Error: Parquetファイルの保存に失敗しました: {e}")
        return False
        
    # OneDriveアップロード
    success = upload_to_onedrive_web(parquet_path)
    return success


def merge_and_upload_historical_logs(until_file: str) -> bool:
    """
    指定されたファイル名（until_file）以前の過去の5分ごとCSVログを一括でマージし、
    1時間ごとの代表値（方式1）に集約し、車種情報を紐づけて、Parquet形式でOneDriveへアップロードします。
    """
    import glob
    from datetime import datetime
    from src.config import ROOT_DIR

    print(f"Info: {until_file} 以前の過去データ一括マージ処理を開始します...")
    
    # 対象ファイルの探索
    pattern = os.path.join(Config.OUTPUT_DIR, "車両情報_*.csv")
    all_csv_files = sorted(glob.glob(pattern))
    
    # until_file 以下のファイル名のみにフィルタリング
    target_basename = os.path.basename(until_file)
    csv_files = [f for f in all_csv_files if os.path.basename(f) <= target_basename]
    
    if not csv_files:
        print(f"Warning: 指定された上限 {target_basename} 以前の車両情報CSVが見つかりません。")
        return False
        
    print(f"Info: {len(csv_files)} 個の過去ファイルをマージします。")
    
    # マージ処理
    df_list = []
    keep_cols = ['エリア名', '識別番号', '車両状態', 'ポート名', 'station_id', 'lat', 'lon', '電圧', 'AT通知受信日時', '連続利用開始日時', '同一ポート継続利用時間(秒)', '交換前電圧', '交換後電圧', '交換日時']
    
    print("Info: 過去ファイルの読み込みを開始します...")
    for idx, filepath in enumerate(csv_files):
        try:
            basename = os.path.basename(filepath)
            time_part = basename.replace("車両情報_", "").replace(".csv", "") # YYYYMMDD_HHMMSS
            get_time = datetime.strptime(time_part, "%Y%m%d_%H%M%S")
            
            # メモリ節約のため必要な列だけ読み込む
            df_temp = pd.read_csv(filepath, nrows=0)
            use_cols = [c for c in keep_cols if c in df_temp.columns]
            
            df = pd.read_csv(filepath, usecols=use_cols, encoding="utf-8-sig")
            df["取得日時_生"] = get_time
            # 取得日時を1時間単位に丸める
            df["取得日時"] = get_time.replace(minute=0, second=0, microsecond=0)
            df_list.append(df)
            
            if (idx + 1) % 500 == 0:
                print(f"Info: {idx + 1} / {len(csv_files)} 個のファイルを読み込みました...")
        except Exception as e:
            print(f"Warning: ファイルの読み込みに失敗しました: {filepath}, {e}")
            
    if not df_list:
        print("Error: 読み込み可能なデータが存在しませんでした。")
        return False
        
    print("Info: 読み込んだデータを結合しています...")
    combined_df = pd.concat(df_list, ignore_index=True)

    
    # サンプル数（集約元の数）をカウント
    df_counts = combined_df.groupby(["識別番号", "取得日時"]).size().reset_index(name="サンプル数")
    
    # 方式1: 1時間ごとの代表値の抽出
    # 各車両（識別番号）および丸めた取得日時ごとに、最も遅い「取得日時_生」のレコードを残す
    combined_df = combined_df.sort_values("取得日時_生")
    combined_df = combined_df.drop_duplicates(subset=["識別番号", "取得日時"], keep="last")
    
    # サンプル数をマージ
    combined_df = pd.merge(combined_df, df_counts, on=["識別番号", "取得日時"], how="left")
    combined_df.drop(columns=["取得日時_生"], inplace=True, errors="ignore")
    
    # 車種情報の紐付け
    threshold_path = os.path.join(str(ROOT_DIR), "車両閾値設定.csv")
    if os.path.exists(threshold_path):
        try:
            df_th = pd.read_csv(threshold_path, encoding="utf-8-sig")
            df_th = df_th.drop_duplicates(subset=["車両識別番号"])
            
            th_cols = ["車種名", "閾値_AT異常", "閾値_画面強調", "閾値_Lv1", "閾値_Lv2", "閾値_Lv3"]
            combined_df = combined_df.drop(columns=[c for c in th_cols if c in combined_df.columns], errors="ignore")
            
            combined_df = pd.merge(
                combined_df,
                df_th[["車両識別番号"] + th_cols],
                left_on="識別番号",
                right_on="車両識別番号",
                how="left"
            )
            combined_df.drop(columns=["車両識別番号"], inplace=True, errors="ignore")
            print("Success: 車両閾値設定マスタとの紐付けに成功しました。")
        except Exception as e:
            print(f"Warning: 車種閾値設定マスタとの紐付け中にエラーが発生しました: {e}")
            
    # Parquet保存
    parquet_filename = "車両情報_historical.parquet"
    parquet_path = os.path.join(Config.OUTPUT_DIR, parquet_filename)
    
    try:
        combined_df.to_parquet(parquet_path, index=False)
        print(f"Success: 一括マージParquetファイルを保存しました: {parquet_path}")
    except Exception as e:
        print(f"Error: 一括マージParquetファイルの保存に失敗しました: {e}")
        return False
        
    # OneDriveアップロード
    success = upload_to_onedrive_web(parquet_path)
    return success

