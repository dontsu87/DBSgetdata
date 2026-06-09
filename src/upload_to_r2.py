"""
Cloudflare R2 アップロードモジュール
dashboard_data.json を R2 バケットにアップロードする
"""

import os
import sys
from pathlib import Path
from dotenv import load_dotenv

# プロジェクトルートの .env を読み込む
load_dotenv(Path(__file__).parent.parent / ".env")


def upload_dashboard_data() -> bool:
    """
    dashboard_data.json を Cloudflare R2 にアップロードする。
    成功した場合 True、失敗した場合 False を返す。
    """
    try:
        import boto3
        from botocore.exceptions import ClientError, NoCredentialsError
    except ImportError:
        print("[ERROR] boto3 がインストールされていません。`pip install boto3` を実行してください。")
        return False

    # 環境変数の読み込み
    account_id = os.getenv("R2_ACCOUNT_ID")
    access_key_id = os.getenv("R2_ACCESS_KEY_ID")
    secret_access_key = os.getenv("R2_SECRET_ACCESS_KEY")
    bucket_name = os.getenv("R2_BUCKET_NAME")
    public_url = os.getenv("R2_PUBLIC_URL")

    # 必須環境変数のチェック
    missing = [k for k, v in {
        "R2_ACCOUNT_ID": account_id,
        "R2_ACCESS_KEY_ID": access_key_id,
        "R2_SECRET_ACCESS_KEY": secret_access_key,
        "R2_BUCKET_NAME": bucket_name,
        "R2_PUBLIC_URL": public_url,
    }.items() if not v]

    if missing:
        print(f"[ERROR] .env に以下のキーが設定されていません: {', '.join(missing)}")
        return False

    # アップロード対象ファイルのパス（プロジェクトルート直下）
    project_root = Path(__file__).parent.parent
    json_file = project_root / "dashboard_data.json"

    if not json_file.exists():
        print(f"[ERROR] アップロード対象ファイルが見つかりません: {json_file}")
        return False

    try:
        # S3互換クライアント（Cloudflare R2）の初期化
        s3 = boto3.client(
            "s3",
            endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            region_name="auto",
        )

        # アップロード実行
        s3.upload_file(
            str(json_file),
            bucket_name,
            "dashboard_data.json",
            ExtraArgs={
                "ContentType": "application/json",
                "CacheControl": "no-cache, max-age=0",  # ブラウザキャッシュを無効化
            }
        )

        print(f"[OK] R2 upload completed: {public_url}/dashboard_data.json")
        return True

    except NoCredentialsError:
        print("[ERROR] R2 の認証情報が無効です。.env の Access Key ID / Secret Access Key を確認してください。")
        return False
    except ClientError as e:
        print(f"[ERROR] R2 アップロードエラー: {e}")
        return False
    except Exception as e:
        print(f"[ERROR] 予期しないエラーが発生しました: {e}")
        return False


def upload_file_to_r2(local_path: str, r2_key: str) -> bool:
    """
    指定されたファイルを Cloudflare R2 にアップロードする。
    """
    try:
        import boto3
        from botocore.exceptions import ClientError, NoCredentialsError
    except ImportError:
        print("[ERROR] boto3 がインストールされていません。")
        return False

    account_id = os.getenv("R2_ACCOUNT_ID")
    access_key_id = os.getenv("R2_ACCESS_KEY_ID")
    secret_access_key = os.getenv("R2_SECRET_ACCESS_KEY")
    bucket_name = os.getenv("R2_BUCKET_NAME")
    public_url = os.getenv("R2_PUBLIC_URL")

    missing = [k for k, v in {
        "R2_ACCOUNT_ID": account_id,
        "R2_ACCESS_KEY_ID": access_key_id,
        "R2_SECRET_ACCESS_KEY": secret_access_key,
        "R2_BUCKET_NAME": bucket_name,
    }.items() if not v]

    if missing:
        print(f"[ERROR] R2の設定が不足しています: {', '.join(missing)}")
        return False

    if not os.path.exists(local_path):
        print(f"[ERROR] ファイルが存在しません: {local_path}")
        return False

    try:
        s3 = boto3.client(
            "s3",
            endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            region_name="auto",
        )

        content_type = "application/json" if local_path.endswith(".json") else "binary/octet-stream"

        s3.upload_file(
            local_path,
            bucket_name,
            r2_key,
            ExtraArgs={
                "ContentType": content_type,
                "CacheControl": "no-cache, max-age=0",
            }
        )
        print(f"[OK] R2 upload completed: {public_url}/{r2_key}")
        return True
    except Exception as e:
        print(f"[ERROR] R2 アップロードエラー ({r2_key}): {e}")
        return False


if __name__ == "__main__":
    success = upload_dashboard_data()
    sys.exit(0 if success else 1)

