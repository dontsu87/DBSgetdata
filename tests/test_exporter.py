# -*- coding: utf-8 -*-
import os
import shutil
import tempfile
import unittest
import pandas as pd
from src.config import Config
from src.exporter import export_to_onedrive

class TestExporter(unittest.TestCase):
    def setUp(self):
        # 一時ディレクトリを作成してConfigに設定
        self.test_dir = tempfile.mkdtemp()
        Config.OUTPUT_DIR = self.test_dir


    def tearDown(self):
        # 一時ディレクトリを削除
        shutil.rmtree(self.test_dir)

    def test_export_to_onedrive(self):
        # テスト用のダミーデータを作成
        df1 = pd.DataFrame({
            'エリア名': ['千代田区'],
            '識別番号': ['A-123'],
            '車両状態': ['正常'],
            'ポート名': ['東京駅前'],
            '電圧': ['4.1V'],
            'AT通知受信日時': ['2026-06-01 09:00:00']
        })
        
        df2 = pd.DataFrame({
            'エリア名': ['港区'],
            '識別番号': ['B-456'],
            '車両状態': ['メンテナンス中'],
            'ポート名': ['六本木ヒルズ'],
            '電圧': ['3.8V'],
            'AT通知受信日時': ['2026-06-01 09:05:00']
        })

        # エクスポート実行
        output_path = export_to_onedrive([df1, df2])

        # ファイルが作成されたか確認
        self.assertTrue(os.path.exists(output_path))
        self.assertTrue(output_path.endswith('.csv'))

        # 作成されたCSVファイルを読み込んで検証
        # BOM付きUTF-8 (utf-8-sig) で読み込む
        loaded_df = pd.read_csv(output_path, encoding='utf-8-sig')

        # 行数と列数の検証
        self.assertEqual(len(loaded_df), 2)
        
        # カラム順序の検証
        expected_columns = ['エリア名', '識別番号', '車両状態', 'ポート名', 'station_id', 'lat', 'lon', '電圧', 'AT通知受信日時', '連続利用開始日時', '同一ポート継続利用時間(秒)', '交換前電圧', '交換後電圧', '交換日時']
        self.assertEqual(list(loaded_df.columns), expected_columns)

        # 内容の検証
        self.assertEqual(loaded_df.iloc[0]['エリア名'], '千代田区')
        self.assertEqual(loaded_df.iloc[1]['エリア名'], '港区')
        self.assertEqual(loaded_df.iloc[0]['識別番号'], 'A-123')
        self.assertEqual(loaded_df.iloc[1]['識別番号'], 'B-456')

if __name__ == '__main__':
    unittest.main()
