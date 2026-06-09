import os
import sys
import json
import shutil
import unittest
import pandas as pd
from datetime import datetime

# プロジェクトルートを追加
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from src.config import Config, ROOT_DIR
from src.exporter import export_to_onedrive
from src.dashboard_generator import generate_dashboard_json

class TestBatteryReplacement(unittest.TestCase):
    def setUp(self):
        # テスト用のテンポラリ出力ディレクトリを設定
        self.original_output_dir = Config.OUTPUT_DIR
        self.test_output_dir = os.path.join(str(ROOT_DIR), "tests", "test_output")
        os.makedirs(self.test_output_dir, exist_ok=True)
        Config.OUTPUT_DIR = self.test_output_dir
        
        # テスト用の dashboard_data.json パス
        self.json_path = os.path.join(str(ROOT_DIR), "dashboard_data.json")
        self.json_backup_path = os.path.join(str(ROOT_DIR), "dashboard_data_backup.json")
        
        # 既存の dashboard_data.json があればバックアップ退避
        if os.path.exists(self.json_path):
            shutil.copy2(self.json_path, self.json_backup_path)
            
        # テスト用のダミーの「前回のデータ」を作成して保存
        self.prev_data = {
            "ports": [
                {
                    "port_name": "ポートA",
                    "bikes": [
                        {
                            "bike_id": "KNZ0001",
                            "voltage": 24.0,  # 低 (<= 25.2)
                            "replace_original_volt": "",
                            "replace_increased_volt": "",
                            "replaced_at": "",
                            "status": "利用可能",
                            "thresholds": {
                                "strong": 25.2,
                                "lv1": 25.9
                            }
                        },
                        {
                            "bike_id": "KNZ0002",
                            "voltage": 24.0,  # 低 (<= 25.2)
                            "replace_original_volt": "",
                            "replace_increased_volt": "",
                            "replaced_at": "",
                            "status": "利用可能",
                            "thresholds": {
                                "strong": 25.2,
                                "lv1": 25.9
                            }
                        },
                        {
                            "bike_id": "KNZ0003",
                            "voltage": 26.0,  # 中 (> 25.2)
                            "replace_original_volt": "",
                            "replace_increased_volt": "",
                            "replaced_at": "",
                            "status": "利用可能",
                            "thresholds": {
                                "strong": 25.2,
                                "lv1": 25.9
                            }
                        },
                        {
                            "bike_id": "KNZ0004",
                            "voltage": 26.0,  # 中 (> 25.2)
                            "replace_original_volt": "",
                            "replace_increased_volt": "",
                            "replaced_at": "",
                            "status": "利用可能",
                            "thresholds": {
                                "strong": 25.2,
                                "lv1": 25.9
                            }
                        }
                    ]
                }
            ]
        }
        with open(self.json_path, "w", encoding="utf-8") as f:
            json.dump(self.prev_data, f, ensure_ascii=False, indent=2)

    def tearDown(self):
        # テンポラリ出力ディレクトリの削除
        if os.path.exists(self.test_output_dir):
            shutil.rmtree(self.test_output_dir)
            
        # テスト用 JSON ファイルのクリーアップとバックアップ復元
        if os.path.exists(self.json_path):
            os.remove(self.json_path)
        if os.path.exists(self.json_backup_path):
            shutil.move(self.json_backup_path, self.json_path)
            
        # 設定の復元
        Config.OUTPUT_DIR = self.original_output_dir

    def test_battery_replacement_logic(self):
        # 今回取得したという設定のテスト用 DataFrame
        # KNZ0001: 24.0V(低) -> 25.5V(中)  [上昇 +1.5V だが交換後は「中」のため検知されない]
        # KNZ0002: 24.0V(低) -> 26.0V(高)  [上昇 +2.0V >= 1.5V かつ交換後が「高」のため検知される]
        # KNZ0003: 26.0V(中) -> 27.5V(高)  [上昇 +1.5V < 3.0V のため検知されない]
        # KNZ0004: 26.0V(中) -> 29.5V(最高) [上昇 +3.5V >= 3.0V かつ交換後が「最高」のため検知される]
        
        df_data = pd.DataFrame([
            {
                "エリア名": "金沢",
                "識別番号": "KNZ0001",
                "車両状態": "利用可能",
                "ポート名": "ポートA",
                "電圧": 25.5,
                "AT通知受信日時": "2026-06-09 10:00:00"
            },
            {
                "エリア名": "金沢",
                "識別番号": "KNZ0002",
                "車両状態": "利用可能",
                "ポート名": "ポートA",
                "電圧": 26.0,
                "AT通知受信日時": "2026-06-09 10:00:00"
            },
            {
                "エリア名": "金沢",
                "識別番号": "KNZ0003",
                "車両状態": "利用可能",
                "ポート名": "ポートA",
                "電圧": 27.5,
                "AT通知受信日時": "2026-06-09 10:00:00"
            },
            {
                "エリア名": "金沢",
                "識別番号": "KNZ0004",
                "車両状態": "利用可能",
                "ポート名": "ポートA",
                "電圧": 29.5,
                "AT通知受信日時": "2026-06-09 10:00:00"
            }
        ])
        
        # 1. exporter.py の実行検証
        csv_path = export_to_onedrive([df_data])
        self.assertTrue(os.path.exists(csv_path))
        
        # CSV の中身の検証
        df_out = pd.read_csv(csv_path)
        
        # 列の存在チェック
        self.assertIn("交換前電圧", df_out.columns)
        self.assertIn("交換後電圧", df_out.columns)
        self.assertIn("交換日時", df_out.columns)
        
        # 車両ごとの値を検証
        bike_1 = df_out[df_out["識別番号"] == "KNZ0001"].iloc[0]
        bike_2 = df_out[df_out["識別番号"] == "KNZ0002"].iloc[0]
        bike_3 = df_out[df_out["識別番号"] == "KNZ0003"].iloc[0]
        bike_4 = df_out[df_out["識別番号"] == "KNZ0004"].iloc[0]
        
        # KNZ0001 (低->中、上昇1.5Vだが交換後中なので検知されない -> 空)
        self.assertTrue(pd.isna(bike_1["交換前電圧"]) or bike_1["交換前電圧"] == "")
        
        # KNZ0002 (低->高、上昇2.0V >= 1.5V、交換後高なので検知される)
        self.assertEqual(float(bike_2["交換前電圧"]), 24.0)
        self.assertEqual(float(bike_2["交換後電圧"]), 26.0)
        self.assertIsNotNone(bike_2["交換日時"])
        
        # KNZ0003 (中->高、上昇1.5V < 3.0V なので検知されない -> 空)
        self.assertTrue(pd.isna(bike_3["交換前電圧"]) or bike_3["交換前電圧"] == "")
        
        # KNZ0004 (中->最高、上昇3.5V >= 3.0V、交換後最高なので検知される)
        self.assertEqual(float(bike_4["交換前電圧"]), 26.0)
        self.assertEqual(float(bike_4["交換後電圧"]), 29.5)
        self.assertIsNotNone(bike_4["交換日時"])

if __name__ == "__main__":
    unittest.main()
