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
        
        # テスト用のダミーの「前回の車両情報CSV」を作成して保存
        prev_df = pd.DataFrame([
            {"識別番号": "KNZ0001", "電圧": 24.0, "エリア名": "金沢", "車両状態": "利用可能", "ポート名": "ポートA"},
            {"識別番号": "KNZ0002", "電圧": 24.0, "エリア名": "金沢", "車両状態": "利用可能", "ポート名": "ポートA"},
            {"識別番号": "KNZ0003", "電圧": 26.0, "エリア名": "金沢", "車両状態": "利用可能", "ポート名": "ポートA"},
            {"識別番号": "KNZ0004", "電圧": 26.0, "エリア名": "金沢", "車両状態": "利用可能", "ポート名": "ポートA"},
        ])
        prev_csv_path = os.path.join(self.test_output_dir, "車両情報_20260609_090000.csv")
        prev_df.to_csv(prev_csv_path, index=False, encoding="utf-8-sig")

    def tearDown(self):
        # テンポラリ出力ディレクトリの削除
        if os.path.exists(self.test_output_dir):
            shutil.rmtree(self.test_output_dir)
            
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

        # battery_replacements.json の検証
        repl_json_path = os.path.join(self.test_output_dir, "battery_replacements.json")
        self.assertTrue(os.path.exists(repl_json_path))
        with open(repl_json_path, "r", encoding="utf-8") as f:
            replacements = json.load(f)
        
        # 検知された車両が履歴に入っていることを確認
        self.assertIn("KNZ0002", replacements)
        self.assertIn("KNZ0004", replacements)
        self.assertNotIn("KNZ0001", replacements)
        self.assertNotIn("KNZ0003", replacements)
        
        self.assertEqual(replacements["KNZ0002"]["replace_original_volt"], 24.0)
        self.assertEqual(replacements["KNZ0002"]["replace_increased_volt"], 26.0)

if __name__ == "__main__":
    unittest.main()
