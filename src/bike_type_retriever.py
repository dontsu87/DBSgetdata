# -*- coding: utf-8 -*-
import os
import time
import pandas as pd
from bs4 import BeautifulSoup
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException
from src.browser import BrowserUtils, build_driver
from src.config import Config
from src.auth import Locators, login_and_get_areas

class BikeTypeLocators:
    # 左メニューの「車種情報」ボタン
    BTN_BIKE_TYPE_INFO = (By.CSS_SELECTOR, "input[type='submit'][value='車種情報']")
    # 左メニューの「車両情報」ボタン
    BTN_VEHICLE_INFO = (By.CSS_SELECTOR, "input[type='submit'][value='車両情報']")
    
    # 500件絞り込み用セレクトボックス
    DD_PAGE_SIZE = (By.CSS_SELECTOR, "select[name='GetInfoNum']")
    
    # 車両一覧テーブルの行
    ROWS = (By.CSS_SELECTOR, "#scroll_table > table > tbody > tr")
    TABLE_FIRST_ROW = (By.CSS_SELECTOR, "#scroll_table > table > tbody > tr:nth-child(1)")

def set_page_size_500(driver):
    """表示件数を500件に切り替えます。"""
    utils = BrowserUtils(driver)
    try:
        sel = utils.find_visible(BikeTypeLocators.DD_PAGE_SIZE, timeout=10)
        driver.execute_script("arguments[0].scrollIntoView({block:'center'});", sel)
        
        if sel.get_attribute("value") == "500":
            return True
            
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
                utils.W(8).until(EC.staleness_of(form))
            except Exception:
                pass
                
        # 再描画後のテーブル確認
        utils.W(utils.wait_long).until(
            EC.presence_of_element_located(BikeTypeLocators.TABLE_FIRST_ROW)
        )
        return True
    except Exception as e:
        print(f" 表示件数の500件切り替え中にエラーが発生しました: {e}")
        return False

def retrieve_vehicle_type_master(driver) -> pd.DataFrame:
    """
    「車種情報 一覧画面」から車種ごとのしきい値マスタ情報を取得します。
    """
    print(" 車種設定マスタ情報の取得を開始します...")
    utils = BrowserUtils(driver)
    
    # 左メニューの「車種情報」ボタンをクリック
    btn = utils.W(utils.wait_short).until(EC.element_to_be_clickable(BikeTypeLocators.BTN_BIKE_TYPE_INFO))
    utils.click_js(btn)
    time.sleep(2)
    
    # 車種設定管理テーブルの表示を待機 (ヘッダーの「車種名」等)
    utils.W(utils.wait_long).until(
        EC.presence_of_element_located((By.XPATH, "//*[contains(text(), '車種設定管理') or contains(text(), '車種名')]"))
    )
    
    soup = BeautifulSoup(driver.page_source, "html.parser")
    
    # 車種設定管理テーブルを検索
    # 通常、テーブル内の最初のヘッダー行に「車種名」などが含まれているテーブルを抽出
    master_rows = []
    tables = soup.find_all("table")
    
    target_table = None
    for t in tables:
        if "車種名" in t.get_text() and "電圧閾値" in t.get_text():
            target_table = t
            break
            
    if not target_table:
        print(" 車種設定管理テーブルを特定できませんでした。")
        return pd.DataFrame()
        
    # テーブル行の解析
    rows = target_table.find_all("tr")
    # ヘッダー行をスキップしつつデータを取得
    for r in rows:
        cells = r.find_all(["td"])
        if len(cells) >= 9:
            # 各セルの入力フィールド値またはテキスト値を取得
            row_data = []
            for cell in cells:
                # inputやselectがある場合はその値を取得、なければtextを取得
                inp = cell.find("input")
                sel = cell.find("select")
                if inp and inp.has_attr("value"):
                    val = inp["value"].strip()
                elif sel:
                    opt = sel.find("option", selected=True)
                    val = opt.get_text(strip=True) if opt else sel.get_text(strip=True)
                else:
                    val = cell.get_text(strip=True)
                row_data.append(val)
                
            # 不要な空白行や空値の多い行は除外
            if row_data[0] and row_data[0] != "車種名":
                master_rows.append(row_data)
                
    # しきい値データの整形 (PasCityC | 有り | シティタイプ | 24 | . | 0 | V | 24 | . | 0 | V... 等の分割構造に対応)
    # 添付画像3枚目より:
    # 列0: 車種名 (PasCityC)
    # 列1: 電動アシスト (有り)
    # 列2: 車両分類名 (シティタイプ)
    # 列3-6: 電圧閾値(AT異常) -> 例: "24", ".", "0", "V" のような細かい分割構造
    # 通常のテキスト取得または整形ロジックで結合して抽出
    cleaned_rows = []
    for r in master_rows:
        try:
            model_name = r[0]
            assist = r[1]
            category = r[2]
            
            # 電圧値などの位置は細かい要素分解を避けるため、HTMLタグの並びから安全に復元するアプローチをとります
            # ここでは解析されたテキストから数値を抽出します
            # 例: [ "PasCityC", "有り", "シティタイプ", "24", "0", "24", "0", "24.6", "25.3", "26.4", "不要", "不要" ]
            # ※ 各環境でのテーブル構造の差異を吸収するため、数値っぽい部分を正規化して結合
            
            # 安全にしきい値カラムを割り当て
            # 通常、セル結合や複数インプットにより配列長が長くなる傾向があるため、後方から逆算するか
            # BeautifulSoupの生要素から各td内の値を正しく組み立てます
            cleaned_rows.append({
                "車種名": model_name,
                "電動アシスト": assist,
                "車両分類名": category,
                # デフォルト値の設定（後で実際の値で上書き）
                "閾値_AT異常": 24.0,
                "閾値_画面強調": 24.0,
                "閾値_Lv1": 24.6,
                "閾値_Lv2": 25.3,
                "閾値_Lv3": 26.4,
                "免許証要否": r[-2] if len(r) >= 11 else "不要",
                "テスト要否": r[-1] if len(r) >= 11 else "不要"
            })
        except Exception as ex:
            print(f" 行の解析中にエラーが発生しました: {ex}")
            
    # BeautifulSoupでより精密に数値を引き出すための補正
    # 各行のtd要素を個別に探索して「数値 + . + 数値」を電圧値として合成します
    if target_table:
        tbody_rows = target_table.find_all("tr")
        idx_cleaned = 0
        for tr in tbody_rows:
            tds = tr.find_all("td")
            if len(tds) >= 9:
                model_name = tds[0].get_text(strip=True)
                if not model_name or "車種名" in model_name:
                    continue
                    
                # 電圧セルのテキストを個別にパース
                try:
                    volts = []
                    # 電圧閾値(AT異常), 電圧閾値(画面強調), 電池残量レベル閾値 Lv.1/Lv.2/Lv.3 の5つ
                    # 各セル内のinputやテキストを走査
                    for td in tds[3:8]:
                        # セル内のテキストおよびinputのvalueを取得して結合
                        val_str = ""
                        for child in td.children:
                            if child.name == "input":
                                val_str += child.get("value", "")
                            elif isinstance(child, str):
                                val_str += child
                            elif child.name == "select":
                                opt = child.find("option", selected=True)
                                if opt: val_str += opt.get_text()
                        
                        # 数値、ドット、マイナス、プラス以外を除去してfloatに変換
                        val_cleaned = "".join([c for c in val_str if c.isdigit() or c == "."])
                        try:
                            volts.append(float(val_cleaned))
                        except ValueError:
                            volts.append(None)
                            
                    if idx_cleaned < len(cleaned_rows):
                        if len(volts) >= 5:
                            cleaned_rows[idx_cleaned]["閾値_AT異常"] = volts[0] if volts[0] is not None else 24.0
                            cleaned_rows[idx_cleaned]["閾値_画面強調"] = volts[1] if volts[1] is not None else 24.0
                            cleaned_rows[idx_cleaned]["閾値_Lv1"] = volts[2] if volts[2] is not None else 24.6
                            cleaned_rows[idx_cleaned]["閾値_Lv2"] = volts[3] if volts[3] is not None else 25.3
                            cleaned_rows[idx_cleaned]["閾値_Lv3"] = volts[4] if volts[4] is not None else 26.4
                        idx_cleaned += 1
                except Exception as ex:
                    print(f" 行しきい値抽出でエラー: {ex}")
                    idx_cleaned += 1

    df_master = pd.DataFrame(cleaned_rows)
    print(f" 車種設定マスタを {len(df_master)} 件取得しました。")
    return df_master

def scrape_bike_types_in_area(driver, area_name: str) -> list[dict]:
    """
    現在のエリアで「車両情報」一覧から各車両の個別画面を開き、車種を取得します。
    既に車種名が既知（マスタCSVや既存データに存在）の車両は個別詳細へのアクセスをスキップします（差分取得によるサーバー負荷激減設計）。
    """
    print(f" エリア '{area_name}' の車両車種情報の取得を開始します...")
    
    # 既知の車種データをロードして読み込みスキップ用の辞書を作成
    known_bikes = {}
    
    # 1. 車両閾値設定.csv から読み込み
    from src.config import ROOT_DIR
    threshold_path = os.path.join(str(ROOT_DIR), "車両閾値設定.csv")
    if os.path.exists(threshold_path):
        try:
            df_th = None
            for enc in ["utf-8", "cp932", "shift_jis", "utf-8-sig"]:
                try:
                    df_th = pd.read_csv(threshold_path, encoding=enc)
                    break
                except Exception:
                    continue
            if df_th is not None:
                id_col = df_th.columns[0]
                type_col = df_th.columns[1]
                for _, row in df_th.iterrows():
                    bid = str(row[id_col]).strip()
                    btype = str(row[type_col]).strip()
                    if bid and btype and btype != "nan":
                        known_bikes[bid] = btype
            else:
                print("Warning: 車両閾値設定.csv のエンコーディング解析に失敗しました。")
        except Exception as e:
            print(f"Warning: 車両閾値設定.csv の既知データロードに失敗しました: {e}")

    # 2. 既存の output/bike_types.csv から読み込み
    bikes_path = os.path.join(Config.OUTPUT_DIR, "bike_types.csv")
    if os.path.exists(bikes_path):
        try:
            df_bt = None
            for enc in ["utf-8", "cp932", "shift_jis", "utf-8-sig"]:
                try:
                    df_bt = pd.read_csv(bikes_path, encoding=enc)
                    break
                except Exception:
                    continue
            if df_bt is not None:
                for _, row in df_bt.iterrows():
                    bid = str(row["識別番号"]).strip()
                    btype = str(row["車種"]).strip()
                    if bid and btype and btype != "nan":
                        known_bikes[bid] = btype
            else:
                print("Warning: bike_types.csv のエンコーディング解析に失敗しました。")
        except Exception as e:
            print(f"Warning: bike_types.csv の既知データロードに失敗しました: {e}")
            
    print(f" Info: データベースより {len(known_bikes)} 件の既知車種データをロードしました（これらは個別アクセスを自動スキップします）。")

    utils = BrowserUtils(driver)
    
    # 1. 「車両情報」一覧画面へ遷移
    btn = utils.W(utils.wait_short).until(EC.element_to_be_clickable(BikeTypeLocators.BTN_VEHICLE_INFO))
    utils.click_js(btn)
    time.sleep(2)
    
    # 2. 500件表示へ切り替え
    set_page_size_500(driver)
    
    bikes_data = []
    page = 1
    
    while True:
        soup = BeautifulSoup(driver.page_source, "html.parser")
        rows = soup.select("#scroll_table > table > tbody > tr")
        
        row_count = len(rows)
        print(f" ページ {page}: 車両を {row_count} 件検出しました。差分スキャンを行います...")
        
        # メインタブのハンドルを記憶
        main_window = driver.current_window_handle
        
        skipped_count = 0
        for idx in range(row_count):
            try:
                # BeautifulSoupでパース済みの要素から安全かつ高速に識別番号を取得（非表示でも確実に取得可能）
                row_soup = rows[idx]
                tds_soup = row_soup.find_all("td")
                if len(tds_soup) < 2:
                    continue
                bike_id = tds_soup[1].get_text(strip=True)
                if not bike_id:
                    continue
                    
                # TRGエリアの一時的な初回高速化ルール適用 (丸形=グリッター・EB, 四角型=SW)
                # すでに有効な車種(SWやグリッター・EB)が既知である場合は、この判定をスルーして通常の既知スキップに流します
                is_trg_area = "TRG" in area_name or bike_id.startswith("TRG")
                has_valid_known_type = bike_id in known_bikes and known_bikes[bike_id] not in ("その他", "nan", "")
                if is_trg_area and not has_valid_known_type:
                    bike_type = None
                    try:
                        # ヘッダーから「AT種別」の列インデックスを動的に検索
                        header_ths = soup.select("#scroll_table > table > thead > tr > th")
                        if not header_ths:
                            header_ths = soup.select("#scroll_table > table > tbody > tr:nth-child(1) > td")
                        
                        at_type_col_idx = -1
                        for h_idx, th in enumerate(header_ths):
                            if "AT種別" in th.get_text():
                                at_type_col_idx = h_idx
                                break
                        
                        if at_type_col_idx != -1 and len(tds_soup) > at_type_col_idx:
                            at_val = tds_soup[at_type_col_idx].get_text(strip=True)
                            if "丸形" in at_val:
                                bike_type = "グリッター・EB"
                            elif "四角型" in at_val:
                                bike_type = "SW"
                    except Exception as ex:
                        print(f"  Warning: TRG高速判定処理中にエラーが発生しました: {ex}")
                    
                    if bike_type:
                        bikes_data.append({
                            "エリア名": area_name,
                            "識別番号": bike_id,
                            "車種": bike_type
                        })
                        skipped_count += 1
                        continue

                # 金沢（まちのり、KNZ）エリアの高速化ルール適用
                if "KNZ" in area_name or "まちのり" in area_name or bike_id.startswith("KNZ"):
                    try:
                        # 車流IDの数値部分を抽出して判定 (例: KNZ0015 -> 15)
                        num_part = "".join([c for c in bike_id if c.isdigit()])
                        num_val = int(num_part) if num_part else 0
                        if num_val <= 500:
                            bike_type = "DD"
                        else:
                            bike_type = "PasCityC"
                    except Exception:
                        bike_type = "PasCityC"
                        
                    bikes_data.append({
                        "エリア名": area_name,
                        "識別番号": bike_id,
                        "車種": bike_type
                    })
                    skipped_count += 1
                    continue
                    
                # 既に車種名が分かっている（かつ、「その他」等の不明な値ではない）場合は詳細画面を開かずにスキップ！
                if bike_id in known_bikes and known_bikes[bike_id] not in ("その他", "nan", ""):
                    bike_type = known_bikes[bike_id]
                    bikes_data.append({
                        "エリア名": area_name,
                        "識別番号": bike_id,
                        "車種": bike_type
                    })
                    skipped_count += 1
                    continue
                    
                # 未登録・新規の車両のみ個別詳細画面にアクセスする (セッション衝突を防ぐため、同タブで遷移してメニューで戻る設計)
                links_current = driver.find_elements(By.CSS_SELECTOR, "#scroll_table > table > tbody > tr > td:nth-child(2) > a")
                if idx < len(links_current):
                    link_el = links_current[idx]
                    utils.click_js(link_el)
                else:
                    print(f"Warning: 車両 {bike_id} のリンクを検出できませんでした。")
                    continue
                
                # 詳細画面の読み込み待機 (「車両情報 詳細画面」などの表示)
                utils.W(15).until(
                    EC.presence_of_element_located((By.XPATH, "//*[contains(text(), '車両情報 詳細画面') or contains(text(), '車種')]"))
                )
                
                # 車種 (CycleType) のセレクトボックスから選択されている値を取得
                bike_type = "その他"
                try:
                    select_el = utils.W(5).until(
                        EC.presence_of_element_located((By.CSS_SELECTOR, "select[name='CycleType'], select"))
                    )
                    active_opt = select_el.find_element(By.CSS_SELECTOR, "option[selected], option:checked")
                    bike_type = active_opt.text.strip()
                except Exception:
                    try:
                        td_el = driver.find_element(By.XPATH, "//td[contains(text(), '車種')]/following-sibling::td[1]")
                        bike_type = td_el.text.strip()
                    except Exception:
                        pass
                        
                # 保存用のレコードを追加
                bikes_data.append({
                    "エリア名": area_name,
                    "識別番号": bike_id,
                    "車種": bike_type
                })
                print(f"  - [{idx+1}/{row_count}] 新規車両検出: {bike_id} -> 車種: {bike_type}")
                
                # 左メニューの「車両情報」ボタンをクリックして一覧へ戻る（戻るボタンは使用不可）
                btn_return = utils.W(utils.wait_short).until(EC.element_to_be_clickable(BikeTypeLocators.BTN_VEHICLE_INFO))
                utils.click_js(btn_return)
                time.sleep(2)
                
                # 500件表示の再設定
                set_page_size_500(driver)
                
                # 処理していた元のページへ再遷移（page > 1 の場合のみ）
                if page > 1:
                    paging_link = utils.W(utils.wait_short).until(
                        EC.element_to_be_clickable((By.LINK_TEXT, str(page)))
                    )
                    utils.click_js(paging_link)
                    utils.W(utils.wait_long).until(
                        EC.presence_of_element_located(BikeTypeLocators.TABLE_FIRST_ROW)
                    )
                    time.sleep(1)
                    
            except Exception as e:
                print(f" 車両インデックス {idx+1} の処理中にエラーが発生しました: {e}")
                # 例外発生時の安全なリカバリ処理
                try:
                    # 一覧画面に戻ることを試みる
                    driver.get(driver.current_url) # 画面リロード
                    time.sleep(2)
                    btn_return = utils.W(utils.wait_short).until(EC.element_to_be_clickable(BikeTypeLocators.BTN_VEHICLE_INFO))
                    utils.click_js(btn_return)
                    time.sleep(2)
                    set_page_size_500(driver)
                    if page > 1:
                        paging_link = driver.find_element(By.LINK_TEXT, str(page))
                        utils.click_js(paging_link)
                        time.sleep(1)
                except Exception:
                    pass
                    
        print(f"   ページ {page} の処理が終了しました（既知車両 {skipped_count} 台のスキップ完了）。")
        # ページめくり処理
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
                EC.presence_of_element_located(BikeTypeLocators.TABLE_FIRST_ROW)
            )
        except TimeoutException:
            # 次のページが存在しない場合はループを終了
            break
            
    return bikes_data

def run_bike_types_scraping():
    """
    手動実行用の車種・設定マスタ取得スクレイピングメイン処理。
    """
    Config.validate(is_worker=False)  # 事業者管理画面（ENTSYS・VPN環境）を使用
    
    print("\n==============================================")
    print(" 事業者用管理画面から車種情報のスクレイピングを開始します...")
    print("==============================================\n")
    
    driver = build_driver()
    
    try:
        # 1. ログインして全エリアのリストを取得
        areas_info = login_and_get_areas(driver)
        area_names = [area["area_name"] for area in areas_info]
        print(f"管轄エリアを {len(area_names)} 個検出しました: {', '.join(area_names)}")
        
        all_bikes = []
        df_master = pd.DataFrame()
        
        # エリア巡回
        for idx, area_name in enumerate(area_names):
            if idx > 0:
                print("\n セッション切替のため、一度ログアウトして再ログインします...")
                try:
                    logout_btn = driver.find_element(By.CSS_SELECTOR, "input[value='ログアウト']")
                    driver.execute_script("arguments[0].click();", logout_btn)
                    time.sleep(2)
                except Exception as le:
                    print(f"Warning: ログアウト処理中にエラーが発生しました: {le}")
                    
                time.sleep(3)
                login_and_get_areas(driver)
                
            print(f"\n[{idx+1}/{len(area_names)}] エリア '{area_name}' の処理を開始します...")
            area_selection_url = driver.current_url
            
            # エリア画面へのナビゲーションクリック
            buttons = driver.find_elements(*Locators.BTN_TO_TOP)
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
                target_btn = buttons[idx]
                
            driver.execute_script("arguments[0].click();", target_btn)
            time.sleep(2)
            
            # --- しきい値マスタ情報を最初のエリアでのみ取得（マスタは共通なため） ---
            if df_master.empty:
                try:
                    df_master = retrieve_vehicle_type_master(driver)
                    # マスタ保存
                    master_path = os.path.join(Config.OUTPUT_DIR, "vehicle_type_master.csv")
                    df_master.to_csv(master_path, index=False, encoding="utf-8-sig")
                    print(f" 車種設定マスタを保存しました: {master_path}")
                except Exception as me:
                    print(f" 車種設定マスタ取得中にエラーが発生しました: {me}")
                    
            # --- 車両ごとの車種を取得 ---
            try:
                area_bikes = scrape_bike_types_in_area(driver, area_name)
                all_bikes.extend(area_bikes)
                print(f" エリア '{area_name}' の車両 {len(area_bikes)} 件の車種を取得完了。")
            except Exception as se:
                print(f" エリア '{area_name}' の車種取得中にエラーが発生しました: {se}")
                
        # 2. 全エリアの車両車種データをまとめて保存
        if all_bikes:
            df_bikes = pd.DataFrame(all_bikes)
            bikes_path = os.path.join(Config.OUTPUT_DIR, "bike_types.csv")
            df_bikes.to_csv(bikes_path, index=False, encoding="utf-8-sig")
            print("\n==============================================")
            print(" すべての車種情報の取得が正常に完了しました！")
            print(f"- 車種設定マスタ数: {len(df_master)} 件")
            print(f"- 車両車種マッピング数: {len(df_bikes)} 件")
            print(f"- 保存先: {bikes_path}")
            print("==============================================\n")
            
            # フロントエンド（JSON/JS生成）への即時再マージ処理を実行
            print(" 新しく取得した車種情報を反映するため、ダッシュボードデータを再生成します...")
            from src.dashboard_generator import generate_dashboard_json
            generate_dashboard_json()
            
        else:
            print("\n 車両車種データを1件も取得できませんでした。")
            
    except Exception as e:
        print(f" 車種スクレイピング処理全体で致命的なエラーが発生しました: {e}")
    finally:
        try:
            driver.quit()
        except Exception:
            pass
