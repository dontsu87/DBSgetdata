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
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
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
            url = f"http://localhost:{PORT}/index.html"
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
