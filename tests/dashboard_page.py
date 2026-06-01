# -*- coding: utf-8 -*-
from playwright.sync_api import Page, expect

class MapDashboardPage:
    """
    Page Object Model (POM) に基づくバッテリー低下車両マップの操作・検証用クラス
    """
    def __init__(self, page: Page):
        self.page = page
        
        # セレクター定義
        self.header_title = page.locator("header h1")
        self.update_time = page.locator("#update-time")
        self.summary_panel = page.locator("#summary-panel")
        self.alert_ports_count = page.locator("#alert-ports-count")
        self.alert_bikes_count = page.locator("#alert-bikes-count")
        self.gps_btn = page.locator("#gps-btn")
        self.map_element = page.locator("#map")
        self.loader = page.locator("#loader")
        self.error_screen = page.locator("#error-screen")
        
        # Leafletのサークルマーカー (svgのpath要素として描画されます)
        self.markers = page.locator("path.leaflet-interactive")

    def navigate(self, url: str):
        """ページへアクセスし、ローディング画面が消えるまで待機します"""
        self.page.goto(url)
        # ローディング画面が非表示になるのを待機
        self.loader.wait_for(state="hidden", timeout=10000)

    def verify_basic_elements(self):
        """ヘッダー、マップ、現在地ボタンなど、基本的な要素が表示されていることを検証します"""
        expect(self.header_title).to_be_visible()
        expect(self.map_element).to_be_visible()
        expect(self.gps_btn).to_be_visible()
        expect(self.summary_panel).to_be_visible()

    def get_summary_data(self) -> tuple[str, str]:
        """サマリーパネルの交換対象ポート数と交換必要車両数を取得します"""
        ports = self.alert_ports_count.text_content()
        bikes = self.alert_bikes_count.text_content()
        return ports, bikes

    def verify_markers_exist(self):
        """地図上にサークルマーカーが少なくとも1つ以上描画されているか検証します"""
        # LeafletサークルマーカーはSVGのpathとして生成されるため、カウントが1以上であることを確認します
        count = self.markers.count()
        assert count > 0, f"地図上にピン（マーカー）が描画されていません。カウント: {count}"
        print(f"Verified: 地図上に {count} 個のマーカーが描画されています。")

    def click_first_marker_and_verify_popup(self):
        """最初のピンをクリックし、ポップアップ（吹き出し）が開き、情報が表示されるか検証します"""
        if self.markers.count() > 0:
            first_marker = self.markers.nth(0)
            
            # アニメーション遅延等に備え、少し待機してから強制クリックを送信
            self.page.wait_for_timeout(500)
            first_marker.click(force=True)
            
            # ポップアップが表示されるのを待機
            popup = self.page.locator(".leaflet-popup-content")
            expect(popup).to_be_visible(timeout=8000)
            
            # ポップアップ内にポート名が含まれているか確認
            title = self.page.locator(".popup-title")
            expect(title).not_to_be_empty()
            print(f"Verified: ポップアップが開き、ポート名 '{title.text_content()}' が表示されました。")
        else:
            raise AssertionError("クリックするマーカーが見つかりません。")
