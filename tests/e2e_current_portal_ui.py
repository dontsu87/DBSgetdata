# -*- coding: utf-8 -*-
import http.server
import json
import os
import socketserver
import sys
import threading
import time

from playwright.sync_api import sync_playwright


PORT = 8096
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def start_server():
    os.chdir(ROOT)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(('', PORT), http.server.SimpleHTTPRequestHandler) as server:
        server.serve_forever()


def run():
    threading.Thread(target=start_server, daemon=True).start()
    time.sleep(1)

    mock_data = {
        'updated_at': '2026-08-02 13:30:00',
        'total_ports_count': 3,
        'total_alert_bikes': 2,
        'summary_counts': {'at_error': 0, 'strong': 2, 'lv1': 0, 'lv2': 0, 'lv3': 0},
        'ports': [
            {
                'port_name': '現行金沢ポート',
                'area_name': '金沢',
                'station_id': '00001685',
                'lat': 36.55,
                'lon': 136.69,
                'has_gps': True,
                'total_bikes': 2,
                'max_alert_level': 4,
                'alert_bikes_count': 2,
                'bikes': [
                    {
                        'bike_id': 'KNZ001',
                        'status': 'AT異常(AT通知受信なし)',
                        'model_name': 'DD',
                        'voltage': 25.0,
                        'alert_level': 4,
                        'alert_level_name': '低',
                        'thresholds': {'at_error': 24, 'strong': 25, 'lv1': 26, 'lv2': 27, 'lv3': None},
                        'consecutive_use_duration': 0,
                        'area_name': '金沢',
                    },
                    {
                        'bike_id': 'NNI002',
                        'status': 'メンテナンス(手動)',
                        'model_name': 'DD',
                        'voltage': 25.0,
                        'alert_level': 4,
                        'alert_level_name': '低',
                        'thresholds': {'at_error': 24, 'strong': 25, 'lv1': 26, 'lv2': 27, 'lv3': None},
                        'consecutive_use_duration': 0,
                        'area_name': '金沢',
                    },
                ],
            },
            {
                'port_name': '旧名空ポート',
                'area_name': 'KNZ_金沢市公共シェアサイクルまちのり事務局',
                'station_id': '00089032',
                'lat': 36.57,
                'lon': 136.65,
                'has_gps': True,
                'total_bikes': 0,
                'max_alert_level': 0,
                'alert_bikes_count': 0,
                'bikes': [],
            },
            {
                'port_name': '福井ポート',
                'area_name': '福井',
                'station_id': '00001412',
                'lat': 36.06,
                'lon': 136.22,
                'has_gps': True,
                'total_bikes': 0,
                'max_alert_level': 0,
                'alert_bikes_count': 0,
                'bikes': [],
            },
        ],
    }

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={'width': 375, 'height': 812},
            is_mobile=True,
            has_touch=True,
        )
        page = context.new_page()
        payload = json.dumps(mock_data, ensure_ascii=False)
        page.add_init_script(
            f'''(() => {{
                const data = {payload};
                window.fetch = async url => {{
                    if (String(url).includes('dashboard_data.json')) {{
                        return {{ok: true, json: async () => data}};
                    }}
                    return {{ok: false, json: async () => ({{}})}};
                }};
            }})()'''
        )

        page.goto(f'http://localhost:{PORT}/index.html?kanriall')
        page.locator('#loader').wait_for(state='hidden', timeout=10000)

        assert page.locator('.area-tab.active').get_attribute('data-area') == '金沢'
        assert page.locator('.area-tab[data-area^="KNZ_"]').count() == 0
        prefixes = sorted(
            page.locator('.prefix-filter').evaluate_all('els => els.map(el => el.value)')
        )
        assert prefixes == ['KNZ', 'NNI'], f'不正なプレフィックス一覧: {prefixes}'

        highlighted = page.locator('.status-highlight:checked').evaluate_all('els => els.map(el => el.value)')
        assert sorted(highlighted) == ['AT異常(AT通知受信なし)', 'AT異常(電圧値閾値未満)', 'メンテナンス(手動)']

        page.evaluate(
            '''() => {
                for (const prefix of ['KNZ', 'NNI']) {
                    const checkbox = document.querySelector(
                        '.prefix-filter[value="' + prefix + '"]'
                    );
                    checkbox.checked = false;
                    checkbox.dispatchEvent(new Event('change'));
                }
            }'''
        )
        assert page.locator('#alert-bikes-count').text_content() == '0'

        page.evaluate(
            '''() => localStorage.setItem(
                'selected_area',
                'KNZ_金沢市公共シェアサイクルまちのり事務局'
            )'''
        )
        page.reload()
        page.locator('#loader').wait_for(state='hidden', timeout=10000)
        assert page.locator('.area-tab.active').get_attribute('data-area') == '金沢'
        assert page.evaluate('localStorage.getItem(\'selected_area\')') == '金沢'

        page.on('dialog', lambda dialog: dialog.accept())
        page.locator('#reset-view-btn').click(force=True)
        page.locator('#loader').wait_for(state='hidden', timeout=10000)
        assert page.locator('.area-tab.active').get_attribute('data-area') == '金沢'

        page.goto(f'http://localhost:{PORT}/index.html?area=KNZ')
        page.locator('#loader').wait_for(state='hidden', timeout=10000)
        assert page.locator('.area-tab.active').get_attribute('data-area') == '金沢'

        browser.close()

    print('current portal mobile UI E2E: ok')


if __name__ == '__main__':
    try:
        run()
    except Exception as error:
        print(f'current portal mobile UI E2E: failed: {error}', file=sys.stderr)
        raise
