# -*- coding: utf-8 -*-
import unittest
from unittest.mock import patch
from src.config import Config

class TestConfig(unittest.TestCase):
    @patch('src.config.os.getenv')
    def test_validate_missing_variables(self, mock_getenv):
        # 必須環境変数が無い場合をシミュレート
        mock_getenv.side_effect = lambda key, default="": ""
        Config.ACCOUNT = ""
        Config.PASSWORD = ""
        Config.OUTPUT_DIR = ""
        
        with self.assertRaises(ValueError) as context:
            Config.validate()
        
        self.assertIn("DBS_ACCOUNT", str(context.exception))
        self.assertIn("DBS_PASSWORD", str(context.exception))

    @patch('src.config.os.getenv')
    @patch('src.config.os.makedirs')
    def test_validate_success(self, mock_makedirs, mock_getenv):
        # 必要な環境変数が揃っている場合をシミュレート
        Config.ACCOUNT = "test_user"
        Config.PASSWORD = "test_pass"
        Config.OUTPUT_DIR = "C:\\dummy_onedrive_path"
        
        # 例外が発生しないことを確認
        try:
            Config.validate()
        except ValueError as e:
            self.fail(f"Config.validate() raised ValueError unexpectedly: {e}")
            
        mock_makedirs.assert_called_once_with("C:\\dummy_onedrive_path", exist_ok=True)


if __name__ == '__main__':
    unittest.main()
