# -*- coding: utf-8 -*-
import os
from pathlib import Path
from dotenv import load_dotenv

# プロジェクトのルートディレクトリにある.envを読み込む
ROOT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(dotenv_path=ROOT_DIR / ".env")

class Config:
    ACCOUNT = os.getenv("DBS_ACCOUNT", "")
    PASSWORD = os.getenv("DBS_PASSWORD", "")
    TOP_PAGE = os.getenv("DBS_TOP_PAGE", "")
    
    # OUTPUT_DIR を優先し、従来の ONEDRIVE_OUTPUT_DIR もフォールバックとしてサポート
    OUTPUT_DIR_RAW = os.getenv("OUTPUT_DIR", os.getenv("ONEDRIVE_OUTPUT_DIR", "output"))
    
    # 相対パスの場合はプロジェクトルート基準の絶対パスに変換
    if not os.path.isabs(OUTPUT_DIR_RAW):
        OUTPUT_DIR = str((ROOT_DIR / OUTPUT_DIR_RAW).resolve())
    else:
        OUTPUT_DIR = OUTPUT_DIR_RAW
    
    # 文字列の 'true' / 'false' を真偽値に変換
    HEADLESS = os.getenv("HEADLESS", "False").lower() in ("true", "1", "yes")

    # OneDrive 共有リンクとパスワード
    ONEDRIVE_SHARED_LINK = os.getenv("ONEDRIVE_SHARED_LINK", "")
    ONEDRIVE_PASSWORD = os.getenv("ONEDRIVE_PASSWORD", "")


    # 作業員用ページ ログイン情報
    WORKER_ACCOUNT = os.getenv("DBS_WORKER_ACCOUNT", "")
    WORKER_PASSWORD = os.getenv("DBS_WORKER_PASSWORD", "")
    WORKER_TOP_PAGE = os.getenv("DBS_WORKER_TOP_PAGE", "")

    @classmethod
    def validate(cls, is_worker=False):
        """設定値のチェックを行い、不足している場合は例外を発生させます。"""
        missing = []
        if is_worker:
            if not cls.WORKER_ACCOUNT:
                missing.append("DBS_WORKER_ACCOUNT")
            if not cls.WORKER_PASSWORD:
                missing.append("DBS_WORKER_PASSWORD")
            if not cls.WORKER_TOP_PAGE:
                missing.append("DBS_WORKER_TOP_PAGE")
        else:
            if not cls.ACCOUNT:
                missing.append("DBS_ACCOUNT")
            if not cls.PASSWORD:
                missing.append("DBS_PASSWORD")
            if not cls.TOP_PAGE:
                missing.append("DBS_TOP_PAGE")
            
        if missing:
            raise ValueError(
                f".env ファイルに必要な設定が不足しています: {', '.join(missing)}\n"
                f".env.example を参考に、本ディレクトリ直下に .env を作成し、IDとPWを設定してください。"
            )
            
        # 出力先フォルダの作成
        try:
            os.makedirs(cls.OUTPUT_DIR, exist_ok=True)
        except Exception as e:
            raise ValueError(f"指定された出力フォルダにアクセスできません: {cls.OUTPUT_DIR}\nエラー詳細: {e}")

