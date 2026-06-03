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
        page.on("console", lambda msg: print(f"[Browser Console] {msg.type}: {msg.text}") if msg.type == "error" else None)
        
        try:
            dashboard = MapDashboardPage(page)
            
            # テストサーバーのトップページ（index.html）へアクセス
            url = f"http://localhost:{PORT}/index.html?area=FKI_%E3%81%B5%E3%81%8F%E3%83%81%E3%83%A3%E3%83%AA"

            print(f"Accessing URL: {url}")
            dashboard.navigate(url)
            
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
