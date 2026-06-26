import os
import csv
import json
import shutil
import unittest
from pathlib import Path
from src.config import Config, ROOT_DIR
from src.self_replace_archiver import sync_self_replacement_history_to_onedrive

class TestSelfReplaceArchiver(unittest.TestCase):
    def setUp(self):
        # テスト用の一時的な出力ディレクトリを作成
        self.test_dir = os.path.join(str(ROOT_DIR), "tests", "test_archiver_output")
        os.makedirs(self.test_dir, exist_ok=True)
        
        # テスト用のCSVパスとR2ダミーデータパス
        self.history_csv_path = os.path.join(self.test_dir, "self_replaced_history.csv")
        self.r2_json_path = os.path.join(self.test_dir, "self_replaced_bikes.json")
        
        # ダミーR2データの作成
        self.dummy_r2_data = {
            "KNZ0001": {
                "timestamp": 1781234567000,
                "alert_level": 2,
                "voltage": 24.2
            },
            "KNZ0002": {
                "timestamp": 1781234568000,
                "alert_level": 1,
                "voltage": 25.5
            }
        }
        with open(self.r2_json_path, 'w', encoding='utf-8') as f:
            json.dump(self.dummy_r2_data, f)
            
        # urllib.request.urlopen で読み込めるように file:// URL に変換
        self.r2_url = Path(self.r2_json_path).as_uri()

    def tearDown(self):
        # 一時ディレクトリのクリーンアップ
        if os.path.exists(self.test_dir):
            shutil.rmtree(self.test_dir)

    def test_sync_first_time_creates_csv(self):
        # 1. 初回同期 (CSVが存在しない状態)
        self.assertFalse(os.path.exists(self.history_csv_path))
        
        success = sync_self_replacement_history_to_onedrive(
            r2_url=self.r2_url,
            history_csv_path=self.history_csv_path,
            skip_upload=True
        )
        
        self.assertTrue(success)
        self.assertTrue(os.path.exists(self.history_csv_path))
        
        # CSVの中身の検証
        with open(self.history_csv_path, 'r', encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            rows = list(reader)
            
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['bike_id'], "KNZ0001")
        self.assertEqual(rows[0]['timestamp'], "1781234567000")
        self.assertEqual(rows[1]['bike_id'], "KNZ0002")
        self.assertEqual(rows[1]['timestamp'], "1781234568000")
        self.assertIsNotNone(rows[0]['recorded_at'])

    def test_sync_duplicate_does_not_append(self):
        # 1. 初回同期を実行してCSVを作成
        sync_self_replacement_history_to_onedrive(
            r2_url=self.r2_url,
            history_csv_path=self.history_csv_path,
            skip_upload=True
        )
        
        # 2. もう一度同じデータで同期を実行 (重複データのみ)
        success = sync_self_replacement_history_to_onedrive(
            r2_url=self.r2_url,
            history_csv_path=self.history_csv_path,
            skip_upload=True
        )
        
        # 新規追加がないため結果は False になるはず
        self.assertFalse(success)
        
        # CSVの件数が2件のままであることを確認
        with open(self.history_csv_path, 'r', encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            rows = list(reader)
        self.assertEqual(len(rows), 2)

    def test_sync_appends_new_only(self):
        # 1. 初回同期を実行
        sync_self_replacement_history_to_onedrive(
            r2_url=self.r2_url,
            history_csv_path=self.history_csv_path,
            skip_upload=True
        )
        
        # 2. R2側のデータを更新し、1件新しいデータを追加
        updated_r2_data = self.dummy_r2_data.copy()
        updated_r2_data["KNZ0003"] = {
            "timestamp": 1781234569000,
            "alert_level": 0,
            "voltage": 26.8
        }
        with open(self.r2_json_path, 'w', encoding='utf-8') as f:
            json.dump(updated_r2_data, f)
            
        # 3. 2回目の同期を実行
        success = sync_self_replacement_history_to_onedrive(
            r2_url=self.r2_url,
            history_csv_path=self.history_csv_path,
            skip_upload=True
        )
        
        self.assertTrue(success)
        
        # CSVの件数が3件になっていることを確認
        with open(self.history_csv_path, 'r', encoding='utf-8-sig') as f:
            reader = csv.DictReader(f)
            rows = list(reader)
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[2]['bike_id'], "KNZ0003")
        self.assertEqual(rows[2]['timestamp'], "1781234569000")

if __name__ == '__main__':
    unittest.main()
