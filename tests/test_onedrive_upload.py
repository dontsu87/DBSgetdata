# -*- coding: utf-8 -*-
import sys
import os
from pathlib import Path

# ルートディレクトリをインポートパスに追加
ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.append(str(ROOT_DIR))

from src.config import Config
from src.exporter import upload_to_onedrive_web

def test_upload():
    """
    OneDriveへのアップロード機能を単体でテストします。
    ダミーのテストCSVファイルを作成し、アップロードの挙動を確認します。
    """
    Config.validate()
    
    # 1. テスト用のダミーファイルを作成
    test_file_path = ROOT_DIR / "output" / "onedrive_test_dummy.csv"
    os.makedirs(test_file_path.parent, exist_ok=True)
    
    with open(test_file_path, "w", encoding="utf-8-sig") as f:
        f.write("テストカラム1,テストカラム2\n")
        f.write("ダミーデータ1,ダミーデータ2\n")
        
    print(f"📝 テスト用ダミーファイルを作成しました: {test_file_path}")
    
    # 2. アップロードの実行
    success = upload_to_onedrive_web(str(test_file_path))
    
    if success:
        print("\n🎉 OneDriveへのテストアップロードに成功しました！")
    else:
        print("\n❌ テストアップロードに失敗しました。ログを確認してください。")

if __name__ == "__main__":
    # Windowsコンソールでの文字化け・エラー対策
    os.environ["PYTHONIOENCODING"] = "utf-8"
    test_upload()
