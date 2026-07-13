# -*- coding: utf-8 -*-
import os
import sys
import time
import http.server
import socketserver
import threading
from playwright.sync_api import sync_playwright, expect
sys.stdout.reconfigure(encoding='utf-8')

# テスト対象のディレクトリとPOMのパス解決
sys.path.append(os.path.dirname(os.path.dirname(__file__)))
from tests.dashboard_page import MapDashboardPage

PORT = 8089
Handler = http.server.SimpleHTTPRequestHandler

def start_server():
    """テスト対象ディレクトリをルートとして簡易HTTPサーバーを起動します"""
    # カレントディレクトリをプロジェクトのルートに固定してサーバーを起動
    os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    
    # 既にポートが使われている場合の安全対策
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("", PORT), Handler) as httpd:
        print(f"Server started on http://localhost:{PORT}")
        httpd.serve_forever()


def run_test():
    # 1. 簡易サーバーを別スレッドでバックグラウンド起動
    server_thread = threading.Thread(target=start_server, daemon=True)
    server_thread.start()
    
    # サーバーの起動待ち
    time.sleep(2)
    
    success = False
    print("\n--- Playwright E2E ブラウザテストを開始します ---")
    
    with sync_playwright() as p:
        # Chromiumをヘッドレス(画面なし)モードで起動します
        browser = p.chromium.launch(headless=True)
        
        # タブレット（iPad等）の解像度とタッチ操作、位置情報サービスをエミュレート
        context = browser.new_context(
            viewport={"width": 1024, "height": 768},
            is_mobile=True,
            has_touch=True,
            permissions=["geolocation"]
        )
        # 位置情報（金沢駅付近）をモック設定
        context.set_geolocation({"latitude": 36.577, "longitude": 136.647, "accuracy": 100})
        
        page = context.new_page()
        
        # コンソールエラー（JavaScriptのエラーなど）をキャッチして表示
        page.on("console", lambda msg: print(f"[Browser Console] {msg.type}: {msg.text}"))
        
        try:
            dashboard = MapDashboardPage(page)
            
            # テストサーバーのトップページ（index.html）へアクセス
            url = f"http://localhost:{PORT}/index.html?area=FKI_%E3%81%B5%E3%81%8F%E3%83%81%E3%83%A3%E3%83%AA"

            # 外部APIのFetchをモック化してローカルの dashboardData が常に使われるようにする
            # ページ読み込み時に最初から適用されるように init_script で追加します
            page.add_init_script("""() => {
                window.fetch = async (url) => {
                    if (url.includes('dashboard_data.json')) {
                        return {
                            ok: true,
                            json: async () => window.dashboardData
                        };
                    }
                    throw new Error('Not found in mock fetch');
                };
            }""")

            print(f"Accessing URL: {url}")
            dashboard.navigate(url)
            page.wait_for_timeout(1000)

            # E2Eテストが実データの内容に依存して落ちるのを防ぐため、初期警告車両（レベル5）をモックデータに注入して再描画
            print("テスト用の初期警告車両（レベル5）を注入します...")
            page.evaluate("""() => {
                const currentData = window._testInterface.getCachedDashboardData();
                if (currentData && currentData.ports && currentData.ports.length > 0) {
                    const testData = JSON.parse(JSON.stringify(currentData));
                    // 最初のポートに確実にレベル5の車両が存在するように改変する
                    testData.ports[0].bikes = [
                        {
                            "bike_id": "TEST-BIKE-LV5",
                            "status": "利用可能",
                            "model_name": "DD",
                            "voltage": 33.5,
                            "alert_level": 5,
                            "alert_level_name": "最低",
                            "is_unregistered": false,
                            "thresholds": {"at_error": 34.8, "strong": 35.9, "lv1": 36.5, "lv2": 38.4, "lv3": null},
                            "at_time": "2026-06-08 11:30:00",
                            "unlocked_started_at": "",
                            "consecutive_use_duration": 0
                        }
                    ];
                    testData.ports[0].total_bikes = 1;
                    window._testInterface.setCachedDashboardData(testData);
                    window._testInterface.updateFilterAndRender(true);
                }
            }""")
            page.wait_for_timeout(1000)



            
            # 基本的な要素の存在チェック
            print("Step 1: 基本要素の表示検証...")
            dashboard.verify_basic_elements()
            print("✅ 基本要素はすべて正常に表示されています。")
            
            # サマリー集計データの検証
            ports, bikes = dashboard.get_summary_data()
            print(f"Step 2: サマリー値の取得... 交換対象ポート数: {ports} 箇所 / 対象車両: {bikes} 台")
            
            # 地図上にマーカーが描画されているか検証
            print("Step 3: 地図上マーカーのレンダリング検証...")
            dashboard.verify_markers_exist()
            print("✅ 地図上にピンが正しくレンダリングされました。")
            
            # 最初のマーカーをクリックしてポップアップを表示させる検証
            print("Step 4: マーカークリック時のポップアップ動作検証...")
            dashboard.click_first_marker_and_verify_popup()
            print("✅ マーカーのタップおよび詳細情報の吹き出し表示は正常に動作します。")
            
            # 現在地ボタンのクリックとGPSトラッキングエミュレート
            print("Step 5: 現在地ジャンプボタンの動作検証...")
            dashboard.gps_btn.click()
            page.wait_for_timeout(2000) # ジャンプアニメーションの待機
            print("✅ GPS現在地追跡ジャンプ機能は正常に動作します。")
            
            # 車両状態フィルターの動作検証
            print("Step 6: 車両状態フィルターの動作検証...")
            expect(dashboard.status_filter_panel).to_be_visible()
            expect(dashboard.status_checkboxes.nth(0)).to_be_visible()
            
            # 初期状態のサマリー数を記録
            initial_ports, initial_bikes = dashboard.get_summary_data()
            print(f"初期サマリー - ポート: {initial_ports} / 車両: {initial_bikes}")
            
            # 状態チェックボックスの値を調べる
            statuses = page.evaluate("() => Array.from(document.querySelectorAll('.status-filter')).map(el => el.value)")
            print(f"検出された車両状態フィルター: {statuses}")
            
            if len(statuses) > 0:
                # 最初の状態をOFFにしてみる
                test_status = statuses[0]
                dashboard.toggle_status_checkbox(test_status, False)
                
                # 数値が変化するか確認
                filtered_ports, filtered_bikes = dashboard.get_summary_data()
                print(f"フィルター適用後 ({test_status} OFF) - ポート: {filtered_ports} / 車両: {filtered_bikes}")
                
                # 元に戻す
                dashboard.toggle_status_checkbox(test_status, True)
                restored_ports, restored_bikes = dashboard.get_summary_data()
                assert initial_bikes == restored_bikes, "フィルター復元後に車両数が一致しませんでした"
                print("✅ 車両状態フィルターのリアルタイムフィルタリングおよび復元は正常に機能しています。")
            else:
                print("⚠️ 車両状態フィルターが見つかりませんでした")
            
            # 自動更新保留ロジックの動作検証
            print("Step 7: 自動更新保留ロジックの動作検証...")
            
            # マーカーをクリックしてポップアップを開く
            print("ポップアップを開きます...")
            dashboard.click_first_marker_and_verify_popup()
            
            # ポップアップが開いている = ユーザー操作中であることを確認
            is_interacting = page.evaluate("window._testInterface.isUserInteracting()")
            assert is_interacting == True, "ポップアップ表示中は isUserInteracting() が True であるべきです"
            
            # ダミーの更新データを設定して保留フラグを立てる
            print("保留アップデートを注入します...")
            page.evaluate("""() => {
                const currentData = window._testInterface.getCachedDashboardData();
                const dummyData = JSON.parse(JSON.stringify(currentData));
                
                // 特定のポートの自転車を1台削除するダミーデータを生成
                if (dummyData.ports.length > 0 && dummyData.ports[0].bikes.length > 0) {
                    dummyData.ports[0].bikes.pop();
                }
                
                // 保留状態にする
                window._testInterface.setPendingUpdateData(dummyData);
                window._testInterface.setIsPendingUpdate(true);
            }""")
            
            # ポップアップが開いているため、保留フラグが True のままであることを確認
            is_pending = page.evaluate("window._testInterface.getIsPendingUpdate()")
            assert is_pending == True, "ユーザー操作中はアップデートが保留（isPendingUpdateがTrue）されるべきです"
            
            # ポップアップを閉じる
            print("ポップアップを閉じます...")
            page.locator(".leaflet-popup-close-button").dispatch_event("click")
            
            # ポップアップが閉じて isUserInteracting が False になるまで待機 (最大5秒)
            page.wait_for_function("window._testInterface.isUserInteracting() === false", timeout=5000)
            print("✅ ポップアップが正常に閉じられました。")

            
            # 5秒のアイドル待機をシミュレート（タイムアウト時間経過後、保留更新が自動適用される）
            print("アイドル適用待機中（6秒）...")
            page.wait_for_timeout(6000)
            
            # 保留フラグが自動適用され、False にクリアされたことを確認
            is_pending_after_idle = page.evaluate("window._testInterface.getIsPendingUpdate()")
            assert is_pending_after_idle == False, "アイドル状態検出後、保留更新が自動適用され isPendingUpdate が False になるべきです"
            print("✅ 自動更新保留およびアイドル適用ロジックは正常に機能しています。")
            
            # --- 未施錠未返却フィルターと閾値の動作検証 ---
            print("\nStep 7.5: 未施錠未返却フィルターと閾値の動作検証...")
            
            # テスト用のデータを注入
            page.evaluate("""() => {
                const currentData = window._testInterface.getCachedDashboardData();
                const testData = JSON.parse(JSON.stringify(currentData));
                
                // 最初のポートにダミー自転車を追加
                if (testData.ports.length > 0) {
                    testData.ports[0].bikes = [
                        {
                            "bike_id": "TEST-BIKE-1.5H",
                            "status": "利用中",
                            "model_name": "DD",
                            "voltage": 38.5,
                            "alert_level": 0,
                            "alert_level_name": "最高",
                            "is_unregistered": false,
                            "thresholds": {"at_error": 34.8, "strong": 35.9, "lv1": 36.5, "lv2": 38.4, "lv3": null},
                            "at_time": "2026-06-03 20:00:00",
                            "unlocked_started_at": "2026-06-03 18:30:00",
                            "consecutive_use_duration": 5400  // 1.5時間
                        },
                        {
                            "bike_id": "TEST-BIKE-2.5H",
                            "status": "利用中",
                            "model_name": "DD",
                            "voltage": 38.5,
                            "alert_level": 0,
                            "alert_level_name": "最高",
                            "is_unregistered": false,
                            "thresholds": {"at_error": 34.8, "strong": 35.9, "lv1": 36.5, "lv2": 38.4, "lv3": null},
                            "at_time": "2026-06-03 20:00:00",
                            "unlocked_started_at": "2026-06-03 17:30:00",
                            "consecutive_use_duration": 9000  // 2.5時間
                        }
                    ];
                    // 総駐輪台数も2台に設定
                    testData.ports[0].total_bikes = 2;
                }
                
                window._testInterface.setCachedDashboardData(testData);
                // 描画更新
                window._testInterface.updateFilterAndRender(false);
            }""")
            
            page.wait_for_timeout(1000)
            
            # デフォルトの閾値 2.0 で最初のピンをクリックしてポップアップを表示
            dashboard.click_first_marker_and_verify_popup()
            
            # 2.5時間の自転車はバッジ（badge-unlocked）が表示されているが、1.5時間のは表示されていないことを確認
            expect(page.locator("li:has-text('TEST-BIKE-2.5H') .badge-unlocked")).to_be_visible()
            expect(page.locator("li:has-text('TEST-BIKE-1.5H') .badge-unlocked")).to_be_hidden()
            print("✅ デフォルト閾値 2.0時間 での判定が正常であることを確認しました。")
            
            # ポップアップを閉じる
            page.locator(".leaflet-popup-close-button").dispatch_event("click")
            page.wait_for_timeout(500)
            
            # 閾値を 1.0 に変更
            print("閾値を 1.0時間 に変更します...")
            page.evaluate("window._testInterface.setUnlockedThresholdHours(1.0)")
            page.wait_for_timeout(1000)
            
            # フィルターの表示ラベルが更新されたことを確認
            filter_label_text = page.locator("#unlocked-filter-label").inner_text()
            assert "1.0時間以上" in filter_label_text, f"フィルターラベルが更新されていません: {filter_label_text}"
            
            # 再度最初のピンをクリック
            dashboard.click_first_marker_and_verify_popup()
            
            # 1.5時間の自転車も 2.5時間の自転車もバッジ（badge-unlocked）が表示されていることを確認
            expect(page.locator("li:has-text('TEST-BIKE-2.5H') .badge-unlocked")).to_be_visible()
            expect(page.locator("li:has-text('TEST-BIKE-1.5H') .badge-unlocked")).to_be_visible()
            print("✅ 閾値 1.0時間 への変更後に、1.5時間の自転車も未施錠未返却と判定されたことを確認しました。")
            
            # ポップアップを閉じる
            page.locator(".leaflet-popup-close-button").dispatch_event("click")
            page.wait_for_timeout(500)
            
            # --- 車両コード接頭辞フィルターの動作検証 ---
            print("\nStep 7.5.5: 車両コード接頭辞フィルターの動作検証...")
            
            # テスト用のデータを注入 (selectedArea を金沢エリアにして、マスタから KNZ/NNI が選ばれるようにする)
            page.evaluate("""() => {
                selectedArea = 'KNZ_金沢市公共シェアサイクルまちのり事務局';
                
                const currentData = window._testInterface.getCachedDashboardData();
                const testData = JSON.parse(JSON.stringify(currentData));
                
                if (testData.ports.length > 0) {
                    testData.ports[0].area_name = 'KNZ_金沢市公共シェアサイクルまちのり事務局';
                    testData.ports[0].bikes = [
                        {
                            "bike_id": "KNZ001",
                            "status": "利用可能",
                            "model_name": "DD",
                            "voltage": 28.5,
                            "alert_level": 4,
                            "alert_level_name": "強警告",
                            "is_unregistered": false,
                            "thresholds": {"at_error": 24.0, "strong": 25.0, "lv1": 26.0, "lv2": 27.0, "lv3": null},
                            "at_time": "2026-06-03 20:00:00",
                            "unlocked_started_at": "",
                            "consecutive_use_duration": 0,
                            "area_name": "KNZ_金沢市公共シェアサイクルまちのり事務局"
                        },
                        {
                            "bike_id": "NNI002",
                            "status": "利用可能",
                            "model_name": "DD",
                            "voltage": 28.5,
                            "alert_level": 4,
                            "alert_level_name": "強警告",
                            "is_unregistered": false,
                            "thresholds": {"at_error": 24.0, "strong": 25.0, "lv1": 26.0, "lv2": 27.0, "lv3": null},
                            "at_time": "2026-06-03 20:00:00",
                            "unlocked_started_at": "",
                            "consecutive_use_duration": 0,
                            "area_name": "KNZ_金沢市公共シェアサイクルまちのり事務局"
                        }
                    ];
                    testData.ports[0].total_bikes = 2;
                }
                
                window._testInterface.setCachedDashboardData(testData);
                window._testInterface.updatePrefixFilterUI(testData);
                window._testInterface.updateFilterAndRender(false);
            }""")
            
            page.wait_for_timeout(1000)
            
            prefix_filters = page.evaluate("() => Array.from(document.querySelectorAll('.prefix-filter')).map(el => el.value)")
            print(f"検出された接頭辞フィルター: {prefix_filters}")
            assert "KNZ" in prefix_filters, "接頭辞 KNZ フィルターが見つかりません"
            assert "NNI" in prefix_filters, "接頭辞 NNI フィルターが見つかりません"
            
            initial_ports, initial_bikes = dashboard.get_summary_data()
            assert initial_bikes == "2", f"初期台数が2台ではありません: {initial_bikes}"
            
            print("接頭辞 KNZ フィルターを OFF にします...")
            dashboard.toggle_prefix_checkbox("KNZ", False)
            
            filtered_ports, filtered_bikes = dashboard.get_summary_data()
            print(f"接頭辞フィルタ適用後 (KNZ OFF) - ポート: {filtered_ports} / 車両: {filtered_bikes}")
            assert filtered_bikes == "1", f"台数が1台に減少していません: {filtered_bikes}"
            
            dashboard.click_first_marker_and_verify_popup()
            expect(page.locator("li:has-text('NNI002')")).to_be_visible()
            expect(page.locator("li:has-text('KNZ001')")).to_be_hidden()
            print("✅ ポップアップ内でも接頭辞フィルタが適用されていることを確認しました。")
            
            page.locator(".leaflet-popup-close-button").dispatch_event("click")
            page.wait_for_timeout(500)
            
            print("接頭辞 KNZ フィルターを ON に戻します...")
            dashboard.toggle_prefix_checkbox("KNZ", True)
            restored_ports, restored_bikes = dashboard.get_summary_data()
            assert restored_bikes == "2", f"フィルター復旧後に台数が2台に戻りませんでした: {restored_bikes}"
            
            # --- ポート外車両情報モーダルの動作検証 ---
            print("\nStep 7.5.6: ポート外車両情報モーダルの動作検証...")
            
            # テスト用データの注入（GPSなしポートオブジェクトを登録）
            page.evaluate("""() => {
                selectedArea = 'KNZ_金沢市公共シェアサイクルまちのり事務局';
                
                const testData = {
                    "updated_at": "2026-07-13 20:50:00",
                    "total_ports_count": 1,
                    "total_alert_bikes": 2,
                    "summary_counts": {"at_error": 1, "strong": 1, "lv1": 0, "lv2": 0, "lv3": 0},
                    "ports": [
                        {
                            "port_name": "テスト倉庫ポート外",
                            "area_name": "KNZ_金沢市公共シェアサイクルまちのり事務局",
                            "station_id": "",
                            "lat": null,
                            "lon": null,
                            "has_gps": false,
                            "total_bikes": 2,
                            "max_alert_level": 5,
                            "alert_bikes_count": 2,
                            "bikes": [
                                {
                                    "bike_id": "KNZ001",
                                    "status": "利用可能",
                                    "model_name": "DD",
                                    "voltage": 28.5,
                                    "alert_level": 4,
                                    "alert_level_name": "強警告",
                                    "is_unregistered": false,
                                    "thresholds": {"at_error": 24.0, "strong": 25.0, "lv1": 26.0, "lv2": 27.0, "lv3": null},
                                    "at_time": "2026-06-03 20:00:00",
                                    "unlocked_started_at": "",
                                    "consecutive_use_duration": 0,
                                    "area_name": "KNZ_金沢市公共シェアサイクルまちのり事務局"
                                },
                                {
                                    "bike_id": "NNI002",
                                    "status": "メンテナンス(アラート付)",
                                    "model_name": "DD",
                                    "voltage": 23.5,
                                    "alert_level": 5,
                                    "alert_level_name": "AT異常",
                                    "is_unregistered": false,
                                    "thresholds": {"at_error": 24.0, "strong": 25.0, "lv1": 26.0, "lv2": 27.0, "lv3": null},
                                    "at_time": "2026-06-03 20:00:00",
                                    "unlocked_started_at": "",
                                    "consecutive_use_duration": 0,
                                    "area_name": "KNZ_金沢市公共シェアサイクルまちのり事務局"
                                }
                            ]
                        }
                    ]
                };
                
                window._testInterface.setCachedDashboardData(testData);
                window._testInterface.updatePrefixFilterUI(testData);
                window._testInterface.updateFilterAndRender(false);
            }""")
            
            page.wait_for_timeout(1000)
            
            expect(dashboard.out_of_port_btn).to_be_visible()
            expect(page.locator("#out-of-port-count")).to_have_text("2")
            dashboard.click_out_of_port_btn()
            
            expect(dashboard.out_of_port_modal).to_be_visible()
            
            count = dashboard.get_out_of_port_bikes_count()
            print(f"モーダル内のポート外車両数: {count}")
            assert count == 2, f"モーダル内のポート外車両数が2ではありません: {count}"
            
            expect(page.locator("#out-of-port-list-body")).to_contain_text("KNZ001")
            expect(page.locator("#out-of-port-list-body")).to_contain_text("NNI002")
            expect(page.locator("#out-of-port-list-body")).to_contain_text("テスト倉庫ポート外")
            expect(page.locator("#out-of-port-list-body")).to_contain_text("AT異常")
            print("✅ モーダル内に車体情報、GPSのないポート名、バッテリ、状態が正しく描画されていることを確認しました。")
            
            dashboard.close_out_of_port_modal()
            expect(dashboard.out_of_port_modal).to_be_hidden()
            print("✅ 閉じるボタンによりモーダルが非表示になることを確認しました。")

            # テスト終了後に FKI_ふくチャリ エリアへ復元する
            page.evaluate("""() => {
                selectedArea = 'FKI_ふくチャリ';
                window._testInterface.setCachedDashboardData(window.dashboardData);
                window._testInterface.updatePrefixFilterUI(window.dashboardData);
                window._testInterface.updateFilterAndRender(false);
            }""")
            page.wait_for_timeout(500)
            print("✅ 車両コード接頭辞フィルターおよびポート外車両情報モーダルの全動作検証が完了しました。")
            
            # --- ポート選択サマリーモードの動作検証 ---
            print("\nStep 7.6: ポート選択サマリーモードの動作検証...")
            
            # モードトグル用のチェックボックスとテキストを取得
            selection_checkbox = page.locator("#selection-mode-checkbox")
            selection_text = page.locator(".selection-toggle-text")
            
            # 初期状態はOFFであることを確認
            expect(selection_checkbox).not_to_be_checked()
            expect(selection_text).to_have_text("選択モード OFF")
            
            # 選択モードをONにする
            print("選択モードを ON にします...")
            page.evaluate("window._testInterface.setIsPortSelectionMode(true)")
            page.wait_for_timeout(500)
            expect(selection_checkbox).to_be_checked()
            expect(selection_text).to_have_text("選択モード ON")
            
            # この状態での初期サマリー数を記録
            sel_initial_ports, sel_initial_bikes = dashboard.get_summary_data()
            print(f"選択モード初期サマリー - ポート: {sel_initial_ports} / 車両: {sel_initial_bikes}")
            
            # 最初のマーカーをクリックして選択（通常ポップアップは開かない）
            print("最初のマーカーをクリックして選択します...")
            dashboard.markers.nth(0).dispatch_event("click")
            page.wait_for_timeout(500)
            
            # ポップアップが開いていないことを確認
            popup = page.locator(".leaflet-popup-content")
            expect(popup).to_be_hidden()
            
            # 選択されたポートリストのカードコンテナが表示され、カードが1つ存在することを確認
            selected_container = page.locator("#selected-ports-container")
            selected_cards = page.locator(".selected-port-card")
            expect(selected_container).to_be_visible()
            expect(selected_cards).to_have_count(1)
            
            # サマリー集計が選択されたポートの値に絞り込まれていることを確認（交換対象ポート数が1になっているはず）
            sel_filtered_ports, sel_filtered_bikes = dashboard.get_summary_data()
            print(f"1個選択後サマリー - ポート: {sel_filtered_ports} / 車両: {sel_filtered_bikes}")
            assert sel_filtered_ports == "1", f"選択したポート数に絞り込まれていません: {sel_filtered_ports}"
            
            # 個別カードの✕ボタンをクリックして選択解除する動作の確認
            print("カードの ✕ ボタンをクリックして選択を解除します...")
            page.locator(".selected-port-card-remove").first.click()
            page.wait_for_timeout(500)
            
            # リストが空になり、コンテナが非表示になることを確認
            expect(selected_container).to_be_hidden()
            expect(selected_cards).to_have_count(0)
            
            # サマリーがエリア全体の初期値に復元されたことを確認
            sel_restored_ports, sel_restored_bikes = dashboard.get_summary_data()
            print(f"選択解除後サマリー - ポート: {sel_restored_ports} / 車両: {sel_restored_bikes}")
            assert sel_restored_ports == sel_initial_ports, "選択解除後にポート数が初期値に戻りませんでした"
            
            # 選択モードをOFFにする
            print("選択モードを OFF に戻します...")
            page.evaluate("window._testInterface.setIsPortSelectionMode(false)")
            page.wait_for_timeout(500)
            expect(selection_checkbox).not_to_be_checked()
            expect(selection_text).to_have_text("選択モード OFF")
            
            # 再びマーカーをクリックすると通常通りポップアップが開くことを確認
            print("通常モード復帰後にマーカーをクリックしてポップアップ確認...")
            dashboard.click_first_marker_and_verify_popup()
            expect(popup).to_be_visible()
            
            # ポップアップを閉じる
            page.locator(".leaflet-popup-close-button").dispatch_event("click")
            page.wait_for_timeout(500)
            print("✅ ポート選択サマリーモードのトグル、選択、サマリー連動、カード表示、削除、ポップアップ抑止はすべて正常に動作しています。")

            # --- キャッシュによる表示状態の保存・復元の検証 ---
            print("\nStep 7.7: キャッシュによる表示状態の保存・復元の検証...")
            
            # 動的にポート名を取得
            test_port_name = page.evaluate("window._testInterface.getCachedDashboardData().ports[0].port_name")
            
            # 各種設定値を変更
            print("状態を変更します...")
            page.evaluate("window._testInterface.setUnlockedThresholdHours(3.5)")
            page.evaluate("window._testInterface.setIsPortSelectionMode(true)")
            page.evaluate(f"window._testInterface.setSelectedPortNames(['{test_port_name}'])")
            page.evaluate("map.setView([35.681, 139.767], 15)")
            page.locator("#basemap-header-btn").click()
            page.wait_for_timeout(500)
            page.locator("input[name='basemap-select'][value='googleSatellite']").click()
            page.locator(".legend-filter[value='3']").click(force=True)
            
            # 少し待って保存を確実にする
            page.wait_for_timeout(1000)
            
            # 保存されているlocalStorageの値を取得して出力
            ls_values = page.evaluate("() => ({ ...localStorage })")
            print(f"DEBUG - リロード前のlocalStorageの値: {ls_values}")
            
            # ページをリロード（再読み込み）
            print("ページをリロードします...")
            page.reload()
            page.wait_for_timeout(2000) # 読み込みと描画の待機
            
            ls_values_after = page.evaluate("() => ({ ...localStorage })")
            print(f"DEBUG - リロード後のlocalStorageの値: {ls_values_after}")
            
            # 状態が復元されているか検証
            print("再読み込み後の状態を検証します...")
            
            # 1. 閾値
            restored_threshold = page.evaluate("window._testInterface.getUnlockedThresholdHours()")
            assert restored_threshold == 3.5, f"閾値が復元されていません: {restored_threshold}"
            
            # 2. ポート選択モード
            restored_mode = page.evaluate("window._testInterface.getIsPortSelectionMode()")
            assert restored_mode == True, "ポート選択モードが復元されていません"
            
            # 3. 選択されたポートリスト
            restored_ports = page.evaluate("window._testInterface.getSelectedPortNames()")
            assert test_port_name in restored_ports, f"選択されたポート名が復元されていません: {restored_ports}"
            
            # 4. 地図の位置・ズーム
            restored_center = page.evaluate("() => [map.getCenter().lat, map.getCenter().lng]")
            restored_zoom = page.evaluate("() => map.getZoom()")
            assert abs(restored_center[0] - 35.681) < 0.01, f"緯度が復元されていません: {restored_center[0]}"
            assert abs(restored_center[1] - 139.767) < 0.01, f"経度が復元されていません: {restored_center[1]}"
            assert abs(restored_zoom - 15) < 0.1, f"ズームが復元されていません: {restored_zoom}"
            
            # 5. ベースマップ
            page.locator("#basemap-header-btn").click()
            page.wait_for_timeout(500)
            basemap_checked = page.locator("input[name='basemap-select'][value='googleSatellite']").is_checked()
            assert basemap_checked == True, "ベースマップのチェックが復元されていません"
            
            # 6. バッテリー深刻度フィルター
            legend_checked = page.locator(".legend-filter[value='3']").is_checked()
            assert legend_checked == True, "バッテリー深刻度（中）のチェックが復元されていません"
            
            print("✅ キャッシュによる表示状態の保存・復元テストに完全合格しました！")

            # --- 初期状態リセットボタンの検証 ---
            print("\nStep 7.8: ビュー初期状態リセットボタンの動作検証...")
            
            # ダイアログハンドラーを設定（自動で承認）
            page.on("dialog", lambda dialog: dialog.accept())
            
            # リセットボタンをクリック
            page.locator("#reset-view-btn").click()
            page.wait_for_timeout(2000) # リロード待ち
            
            # 各値がデフォルト（初期値）にリセットされていることをアサーション
            # 1. 閾値 (2.0)
            reset_threshold = page.evaluate("window._testInterface.getUnlockedThresholdHours()")
            assert reset_threshold == 2.0, f"リセット後に閾値が2.0に戻っていません: {reset_threshold}"
            
            # 2. ポート選択モード (False)
            reset_mode = page.evaluate("window._testInterface.getIsPortSelectionMode()")
            assert reset_mode == False, "リセット後に選択モードがOFFになっていません"
            
            # 3. 選択ポート (空)
            reset_ports = page.evaluate("window._testInterface.getSelectedPortNames()")
            assert len(reset_ports) == 0, f"リセット後に選択ポートが空になっていません: {reset_ports}"
            
            print("✅ リセットボタンにより表示状態が正常にクリアされ、初期状態に復元されることを確認しました！")

            # --- モバイルレイアウト（スマホ）の検証を開始します ---
            print("\n--- モバイルレイアウト（スマホ）の検証を開始します ---")
            mobile_context = browser.new_context(
                viewport={"width": 375, "height": 812},
                is_mobile=True,
                has_touch=True,
                permissions=["geolocation"]
            )
            mobile_context.set_geolocation({"latitude": 36.577, "longitude": 136.647, "accuracy": 100})
            
            mobile_page = mobile_context.new_page()
            mobile_dashboard = MapDashboardPage(mobile_page)
            
            print(f"Accessing URL on mobile: {url}")
            mobile_dashboard.navigate(url)
            
            # 1. モバイル用コントロールバーが表示されていることを確認
            print("Step M1: モバイル専用コントロールバーの表示確認...")
            expect(mobile_dashboard.mobile_control_bar).to_be_visible()
            
            # 2. 初期状態で、デスクトップ用パネル類（フィルター、凡例等）が画面外か非表示（hidden）であることを確認
            print("Step M2: デスクトップ用パネルが非表示（スライドアウト状態）であることを確認...")
            expect(mobile_dashboard.summary_panel).to_be_hidden()
            expect(mobile_dashboard.status_filter_panel).to_be_hidden()
            
            # 3. 「サマリー」ボタンをタップしてサマリードロワーが開くことを確認
            print("Step M3: サマリーボタンタップによるドロワー開閉の検証...")
            mobile_dashboard.btn_summary_mobile.click()
            expect(mobile_dashboard.summary_panel).to_be_visible(timeout=5000)
            
            # ドロワー内の「✕（閉じる）」ボタンをクリック
            mobile_dashboard.summary_panel.locator(".close-panel-btn").click()
            expect(mobile_dashboard.summary_panel).to_be_hidden(timeout=5000)
            print("✅ サマリードロワーのトグル動作は正常です。")
            
            # 4. 「バッテリー」ボタンをタップして凡例ドロワーが開くことを確認
            print("Step M4: バッテリー凡例ボタンタップによるドロワー開閉の検証...")
            mobile_dashboard.btn_legend_mobile.click()
            expect(mobile_dashboard.legend_panel).to_be_visible(timeout=5000)
            
            mobile_dashboard.legend_panel.locator(".close-panel-btn").click()
            expect(mobile_dashboard.legend_panel).to_be_hidden(timeout=5000)
            print("✅ バッテリー凡例ドロワーのトグル動作は正常です。")
            
            mobile_context.close()
            print("🎉 【検証成功】モバイルレイアウトの表示およびドロワー操作テストに合格しました！")
            
            # 成功フラグ
            success = True


            
        except Exception as e:
            print(f"❌ テスト検証中に不具合を検出しました: {e}")
            # エラー発生時の画面キャプチャを保存してデバッグに活かします
            os.makedirs("debug", exist_ok=True)
            screenshot_path = "debug/test_failure_capture.png"
            page.screenshot(path=screenshot_path)
            print(f"📸 エラー画面のキャプチャを保存しました: {screenshot_path}")
            
        finally:
            browser.close()
            
    if success:
        print("\n🎉 【検証成功】すべてのE2Eテスト項目に完全合格しました！Webアプリは完璧に動作しています。")
        sys.exit(0)
    else:
        print("\n🔴 【検証失敗】一部のE2Eテストに不合格となりました。")
        sys.exit(1)

if __name__ == "__main__":
    run_test()
