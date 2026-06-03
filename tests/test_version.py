# -*- coding: utf-8 -*-
import os
import re
import unittest
from datetime import datetime

class TestVersionTimestamp(unittest.TestCase):
    def test_version_up_to_date(self):
        """index.html のバージョン表記 (ver.YYYYMMDDHHMMSS) が、主要ファイルの最終更新日時より新しくなっていることを検証します"""
        project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        
        # 監視対象の主要ファイル
        target_files = [
            os.path.join(project_root, "index.html"),
            os.path.join(project_root, "main.js"),
            os.path.join(project_root, "style.css"),
            os.path.join(project_root, "main.py"),
            os.path.join(project_root, "車両閾値設定.csv"),
            os.path.join(project_root, "src", "dashboard_generator.py"),
            os.path.join(project_root, "src", "config.py"),
        ]

        # 1. 主要ファイルの最新 mtime を取得して datetime に変換 (ローカルタイム)
        latest_mtime = 0.0
        latest_file = None
        for file_path in target_files:
            if os.path.exists(file_path):
                mtime = os.path.getmtime(file_path)
                if mtime > latest_mtime:
                    latest_mtime = mtime
                    latest_file = file_path

        self.assertIsNotNone(latest_file, "主要ファイルが1つも見つかりませんでした。")
        
        # 主要ファイルの最新更新日時を YYYYMMDDHHMMSS 形式の文字列に変換
        latest_dt = datetime.fromtimestamp(latest_mtime)
        latest_str = latest_dt.strftime("%Y%m%d%H%M%S")
        latest_display = latest_dt.strftime("%Y-%m-%d %H:%M:%S")

        # 2. index.html から ver.YYYYMMDDHHMMSS を抽出
        index_path = os.path.join(project_root, "index.html")
        self.assertTrue(os.path.exists(index_path), "index.html が存在しません。")
        
        with open(index_path, "r", encoding="utf-8") as f:
            html_content = f.read()

        # ver.20260603201400 のような文字列を抽出
        match = re.search(r"ver\.(\d{14})", html_content)
        self.assertIsNotNone(match, "index.html 内に 'ver.YYYYMMDDHHMMSS' 形式のバージョン表記が見つかりませんでした。")
        
        version_str = match.group(1)
        version_dt = datetime.strptime(version_str, "%Y%m%d%H%M%S")
        version_display = version_dt.strftime("%Y-%m-%d %H:%M:%S")

        # 3. 比較検証
        # ファイルの最終更新日時よりバージョン日時が古い（遅れている）場合はエラー
        # ※ 編集からテスト実行までの若干のタイムラグを考慮し、10秒程度の猶予は許容する、
        # または単にバージョン日時の方が最新更新日時以上であることを確認する
        self.assertTrue(
            version_dt >= version_dt,  # 基本的なアサーション構成
        )
        
        # 厳密な比較: version_dt (秒切り捨て) が最新の mtime (latest_dt, 秒切り捨て) 以上であること
        # (ファイルが更新されたら、必ずそれ以上のバージョン時刻に index.html を書き換えていなければならない)
        version_dt_min = version_dt.replace(second=0, microsecond=0)
        latest_dt_min = latest_dt.replace(second=0, microsecond=0)
        
        self.assertGreaterEqual(
            version_dt_min, 
            latest_dt_min, 
            msg=(
                f"\n[バージョン更新忘れを検知しました]\n"
                f"変更された最新ファイル: {os.path.basename(latest_file)} (最終更新: {latest_display})\n"
                f"現在のバージョン表記  : ver.{version_str} ({version_display})\n"
                f"ファイルを修正した際は、必ず index.html の 'ver.YYYYMMDDHHMMSS' も最新の分単位の日時（例: {latest_dt.strftime('%Y%m%d%H%M')}00）に更新してください。"
            )
        )

if __name__ == '__main__':
    unittest.main()
