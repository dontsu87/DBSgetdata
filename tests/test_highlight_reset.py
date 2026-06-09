# -*- coding: utf-8 -*-
import os
import sys
import time
import http.server
import socketserver
import threading
from playwright.sync_api import sync_playwright, expect

sys.stdout.reconfigure(encoding='utf-8')

sys.path.append(os.path.dirname(os.path.dirname(__file__)))

PORT = 8095
Handler = http.server.SimpleHTTPRequestHandler

def start_server():
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("", PORT), Handler) as httpd:
        httpd.serve_forever()

def run_test():
    server_thread = threading.Thread(target=start_server, daemon=True)
    server_thread.start()
    time.sleep(1)
    
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1024, "height": 768})
        page = context.new_page()
        
        # モックフェッチで静的なモックデータを返す (リロード後も永続的に有効)
        page.add_init_script("""() => {
            const mockData = {
                "updated_at": "2026-06-09 13:41:26",
                "total_ports_count": 1,
                "total_alert_bikes": 2,
                "ports": [
                    {
                        "port_name": "テストポート",
                        "area_name": "FKI_ふくチャリ",
                        "station_id": "00001412",
                        "lat": 36.061486,
                        "lon": 136.222531,
                        "total_bikes": 2,
                        "bikes": [
                            {
                                "bike_id": "TEST-AT-1",
                                "status": "AT異常(AT通知受信なし)",
                                "model_name": "DD",
                                "voltage": 33.5,
                                "alert_level": 5,
                                "alert_level_name": "最低",
                                "is_unregistered": false,
                                "at_time": "2026-06-08 11:30:00",
                                "consecutive_use_duration": 0
                            },
                            {
                                "bike_id": "TEST-AT-2",
                                "status": "AT異常(電池なし)",
                                "model_name": "DD",
                                "voltage": 32.5,
                                "alert_level": 5,
                                "alert_level_name": "最低",
                                "is_unregistered": false,
                                "at_time": "2026-06-08 11:30:00",
                                "consecutive_use_duration": 0
                            }
                        ]
                    }
                ]
            };
            window.fetch = async (url) => {
                if (url.includes('dashboard_data.json')) {
                    return {
                        ok: true,
                        json: async () => mockData
                    };
                }
                throw new Error('Not found in mock fetch');
            };
        }""")
        
        try:
            # kanriall パラメータを付与して車両状態フィルターを強制的に全件生成させる
            url = f"http://localhost:{PORT}/index.html?kanriall"
            page.goto(url)
            page.wait_for_timeout(1000)
            
            # 念のため、キャッシュにカスタム値を汚染保存しておく
            page.evaluate("""() => {
                localStorage.setItem('checked_highlight_statuses', JSON.stringify(['利用可能']));
            }""")
            
            # 一度リロードして汚染状態を反映させる
            page.reload()
            page.wait_for_timeout(1500)
            
            # リセット実行
            print("リセットを実行します...")
            page.on("dialog", lambda dialog: dialog.accept())
            page.locator("#reset-view-btn").click()
            page.wait_for_timeout(2000) # リロード待ち
            
            # 車両状態フィルターパネルを展開
            print("車両状態フィルターパネルを展開します...")
            page.locator("#status-header-btn").click()
            page.wait_for_timeout(500)
            
            # 実際に生成されたチェックボックスの value をログ出力
            values = page.evaluate("() => Array.from(document.querySelectorAll('.status-highlight')).map(el => el.value)")
            print(f"検出された強調チェックボックスの value 一覧: {values}")
            
            # キャッシュの中身を確認
            cached = page.evaluate("() => localStorage.getItem('checked_highlight_statuses')")
            print(f"リセット後のローカルストレージ値: {cached}")

            # 各チェックボックスの状態をDOMから直接取得
            is_unlocked_highlighted = page.evaluate("""() => {
                const el = Array.from(document.querySelectorAll('.status-highlight')).find(el => el.value === 'AT異常(AT通知受信なし)');
                return el ? el.checked : null;
            }""")
            is_battery_highlighted = page.evaluate("""() => {
                const el = Array.from(document.querySelectorAll('.status-highlight')).find(el => el.value === 'AT異常(電池なし)');
                return el ? el.checked : null;
            }""")
            
            print(f"AT異常(AT通知受信なし)の強調チェック状態: {is_unlocked_highlighted}")
            print(f"AT異常(電池なし)の強調チェック状態: {is_battery_highlighted}")
            
            assert is_unlocked_highlighted is True, "AT異常(AT通知受信なし)の強調表示チェックが入っていません"
            assert is_battery_highlighted is True, "AT異常(電池なし)の強調表示チェックが入っていません"
            
            # スクリーンショットを撮影して目視確認できるようにする
            os.makedirs("debug", exist_ok=True)
            screenshot_path = "debug/screenshot_after_reset.png"
            page.screenshot(path=screenshot_path)
            print(f"📸 状態確認用スクリーンショットを保存しました: {screenshot_path}")
            
            print("✅ 目視用スクリーンショット撮影とチェックボックスONの検証に成功しました！")
            
        except Exception as e:
            print(f"❌ テスト失敗: {e}")
        finally:
            browser.close()

if __name__ == "__main__":
    run_test()
