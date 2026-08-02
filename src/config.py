# -*- coding: utf-8 -*-
import os
from pathlib import Path
from dotenv import load_dotenv

# プロジェクトのルートディレクトリにある.envを読み込む
ROOT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(dotenv_path=ROOT_DIR / ".env")

def _int_env(name: str, default: int) -> int:
    """環境変数を整数として読み込みます。未設定・不正値の場合は既定値を返します。"""
    try:
        value = os.getenv(name, "").strip()
        return int(value) if value else default
    except ValueError:
        return default


def _bool_env(name: str, default: bool) -> bool:
    """環境変数を真偽値として読み込みます。"""
    value = os.getenv(name, '').strip().lower()
    if not value:
        return default
    if value in ('true', '1', 'yes', 'on'):
        return True
    if value in ('false', '0', 'no', 'off'):
        return False
    return default

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

    # 動作モード判定: "MAP_DATA_ONLY" 等のテストショートカットに対応するため
    RUN_MODE = os.getenv("DBS_RUN_MODE", "")


    # 作業員用ページ ログイン情報
    WORKER_ACCOUNT = os.getenv("DBS_WORKER_ACCOUNT", "")
    WORKER_PASSWORD = os.getenv("DBS_WORKER_PASSWORD", "")
    WORKER_TOP_PAGE = os.getenv("DBS_WORKER_TOP_PAGE", "")

    # 刷新後 (2026年8月〜) の新管理ポータル。
    # 事業者用・作業員用の区別は廃止され、単一のポータルに統合された。
    # 認証基盤は AWS Cognito の Hosted UI で、ログインIDはメールアドレス形式。
    LOGIN_URL = os.getenv("DBS_LOGIN_URL", "")
    LOGIN_EMAIL = os.getenv("DBS_LOGIN_EMAIL", "")
    LOGIN_PASSWORD = os.getenv("DBS_LOGIN_PASSWORD", "")

    @classmethod
    def login_url(cls, is_worker: bool = True) -> str:
        """刷新後ポータルのログインURLを返します。旧ポータルにはフォールバックしません。"""
        return cls.LOGIN_URL

    @classmethod
    def login_credentials(cls, is_worker: bool = True):
        """刷新後ポータルの (メールアドレス, パスワード) を返します。"""
        return cls.LOGIN_EMAIL, cls.LOGIN_PASSWORD

    # 車両位置詳細の追加取得。車両一覧取得とは独立した負荷停止スイッチ。
    # 既定では有効。負荷を下げる場合は DBS_VEHICLE_LOCATION_FETCH_ENABLED=false。
    VEHICLE_LOCATION_FETCH_ENABLED = _bool_env(
        'DBS_VEHICLE_LOCATION_FETCH_ENABLED', True
    )
    VEHICLE_LOCATION_FETCH_MAX_PER_RUN = _int_env(
        'DBS_VEHICLE_LOCATION_FETCH_MAX_PER_RUN', 200
    )
    VEHICLE_LOCATION_FETCH_DELAY_MS = _int_env(
        'DBS_VEHICLE_LOCATION_FETCH_DELAY_MS', 100
    )

    # メール2段階認証コードの受け渡し (Power Automate → OneDrive 共有ファイル)
    # 詳細仕様: docs/email-2fa-power-automate-spec.md
    MAILCODE_SHARE_LINK = os.getenv("DBS_MAILCODE_SHARE_LINK", "")
    MAILCODE_SHARE_PASSWORD = os.getenv("DBS_MAILCODE_SHARE_PASSWORD", "")
    MAILCODE_TIMEOUT_SEC = _int_env("DBS_MAILCODE_TIMEOUT_SEC", 180)
    MAILCODE_POLL_SEC = _int_env("DBS_MAILCODE_POLL_SEC", 10)
    MAILCODE_MAX_AGE_SEC = _int_env("DBS_MAILCODE_MAX_AGE_SEC", 600)
    # 受信時刻のクロックずれ許容幅（Exchange のサーバ時刻とローカル時計の差を吸収）
    MAILCODE_CLOCK_SKEW_SEC = _int_env("DBS_MAILCODE_CLOCK_SKEW_SEC", 60)
    # 空の場合は既定の抽出ロジック（キーワード近傍の4〜8桁）を使用
    MAILCODE_REGEX = os.getenv("DBS_MAILCODE_REGEX", "")

    @classmethod
    def validate(cls, is_worker=False):
        """設定値のチェックを行い、不足している場合は例外を発生させます。"""
        missing = []
        if not cls.LOGIN_URL:
            missing.append("DBS_LOGIN_URL")
        if not cls.LOGIN_EMAIL:
            missing.append("DBS_LOGIN_EMAIL")
        if not cls.LOGIN_PASSWORD:
            missing.append("DBS_LOGIN_PASSWORD")
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

