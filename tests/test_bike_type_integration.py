# -*- coding: utf-8 -*-
import os
import sys
import unittest
import pandas as pd
import json
from unittest.mock import patch, MagicMock

# テスト対象のディレクトリを追加
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from src.config import Config
from src.dashboard_generator import generate_dashboard_json

class TestBikeTypeIntegration(unittest.TestCase):
    def setUp(self):
        # テスト用のダミーファイルパス設定
        self.dummy_vehicle_csv = os.path.join(Config.OUTPUT_DIR, "車両情報_test.csv")
        self.dummy_threshold_csv = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "車両閾値設定.csv")
        self.dummy_bike_types_csv = os.path.join(Config.OUTPUT_DIR, "bike_types.csv")
        self.dummy_master_csv = os.path.join(Config.OUTPUT_DIR, "vehicle_type_master.csv")
        
        # バックアップ用の辞書
        self.exists_backup = {}
        
    def tearDown(self):
        # 生成されたダミーファイルのクリーンアップ
        for path in [self.dummy_vehicle_csv, self.dummy_bike_types_csv, self.dummy_master_csv]:
            if os.path.exists(path):
                try:
                    os.remove(path)
                except Exception:
                    pass

    def test_dashboard_generator_dynamic_merge(self):
        """
        scrapedされた bike_types.csv と vehicle_type_master.csv が
        dashboard_generator にて正しく動的ロード・マージされることを検証します。
        """
        # 1. モック車両データの作成 (AT種別列を追加)
        df_veh = pd.DataFrame({
            "エリア名": ["KNZ_金沢市公共シェアサイクルまちのり事務局", "KNZ_金沢市公共シェアサイクルまちのり事務局", "TRG_Tokyo Ring", "TRG_Tokyo Ring"],
            "識別番号": ["KNZ9999", "KNZ9998", "TRG9999", "TRG9998"],
            "車両状態": ["利用可能", "利用可能", "利用可能", "利用可能"],
            "ポート名": ["ポートA", "ポートB", "ポートC", "ポートC"],
            "電圧": ["34.5", "23.5", "25.0", "22.0"],
            "AT通知受信日時": ["2026-06-02 10:00:00", "2026-06-02 10:00:00", "2026-06-02 10:00:00", "2026-06-02 10:00:00"],
            "lat": [36.577, 36.577, 35.631, 35.631],
            "lon": [136.647, 136.647, 136.064, 136.064],
            "station_id": [1, 2, 3, 4],
            "AT種別": ["", "", "四角型", "丸形"]
        })
        df_veh.to_csv(self.dummy_vehicle_csv, index=False, encoding="utf-8-sig")
        
        # 2. モック車種データの作成 (TRG車両を除外し、AT種別からの直接判定をテスト)
        df_types = pd.DataFrame({
            "エリア名": ["KNZ_金沢市公共シェアサイクルまちのり事務局", "KNZ_金沢市公共シェアサイクルまちのり事務局"],
            "識別番号": ["KNZ9999", "KNZ9998"],
            "車種": ["PasCityC", "VIENTA5"]
        })
        df_types.to_csv(self.dummy_bike_types_csv, index=False, encoding="utf-8-sig")
        
        # 3. モック車種設定マスタの作成 (TRGはマスタになくハードコード補正にかかるテスト)
        df_master = pd.DataFrame({
            "車種名": ["PasCityC", "VIENTA5"],
            "電動アシスト": ["有り", "有り"],
            "車両分類名": ["シティタイプ", "スポーツタイプ"],
            "閾値_AT異常": [24.0, 22.0],
            "閾値_画面強調": [24.0, 22.0],
            "閾値_Lv1": [24.6, 23.0],
            "閾値_Lv2": [25.3, 24.0],
            "閾値_Lv3": [26.4, 25.0],
            "免許証要否": ["不要", "不要"],
            "テスト要否": ["不要", "不要"]
        })
        df_master.to_csv(self.dummy_master_csv, index=False, encoding="utf-8-sig")
        
        # 4. 可視化JSONの生成実行
        json_path, js_path = generate_dashboard_json(self.dummy_vehicle_csv)
        
        self.assertIsNotNone(json_path)
        self.assertTrue(os.path.exists(json_path))
        
        # 5. 出力JSONの検証
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            
        ports = data["ports"]
        self.assertTrue(len(ports) > 0)
        
        # 車料情報の確認
        knz_9999_found = False
        knz_9998_found = False
        trg_9999_found = False
        trg_9998_found = False
        
        for port in ports:
            for bike in port["bikes"]:
                if bike["bike_id"] == "KNZ9999":
                    knz_9999_found = True
                    # PasCityC は自動で "グリッター・EB" に正式名変更される
                    self.assertEqual(bike["model_name"], "グリッター・EB")
                    # しきい値がマスタ（PasCityC）から引き当たっているか検証
                    self.assertEqual(bike["thresholds"]["at_error"], 24.0)
                    self.assertEqual(bike["thresholds"]["lv1"], 24.6)
                    self.assertEqual(bike["thresholds"]["lv3"], 26.4)
                elif bike["bike_id"] == "KNZ9998":
                    knz_9998_found = True
                    self.assertEqual(bike["model_name"], "VIENTA5")
                    # しきい値がマスタ（VIENTA5）から引き当たっているか検証
                    self.assertEqual(bike["thresholds"]["at_error"], 22.0)
                    self.assertEqual(bike["thresholds"]["lv1"], 23.0)
                    self.assertEqual(bike["thresholds"]["lv3"], 25.0)
                elif bike["bike_id"] == "TRG9999":
                    trg_9999_found = True
                    self.assertEqual(bike["model_name"], "SW")
                    # SWの補正閾値検証
                    self.assertEqual(bike["thresholds"]["at_error"], 20.5)
                    self.assertEqual(bike["thresholds"]["strong"], 24.5)
                    self.assertEqual(bike["thresholds"]["lv1"], 23.9)
                    self.assertEqual(bike["thresholds"]["lv2"], 24.7)
                    self.assertEqual(bike["thresholds"]["lv3"], 26.3)
                elif bike["bike_id"] == "TRG9998":
                    trg_9998_found = True
                    self.assertEqual(bike["model_name"], "グリッター・EB")
                    # グリッター・EBの補正閾値検証 (新しい5段階閾値)
                    self.assertEqual(bike["thresholds"]["at_error"], 23.9)
                    self.assertEqual(bike["thresholds"]["strong"], 25.2)
                    self.assertEqual(bike["thresholds"]["lv1"], 25.9)
                    self.assertEqual(bike["thresholds"]["lv2"], 27.9)
                    self.assertIsNone(bike["thresholds"]["lv3"])
                    
        self.assertTrue(knz_9999_found, "KNZ9999 がJSONに含まれていません")
        self.assertTrue(knz_9998_found, "KNZ9998 がJSONに含まれていません")
        self.assertTrue(trg_9999_found, "TRG9999 (SW) がJSONに含まれていません")
        self.assertTrue(trg_9998_found, "TRG9998 (グリッター・EB) がJSONに含まれていません")
        print("[SUCCESS] Integration data generation test succeeded!")

if __name__ == "__main__":
    unittest.main()
