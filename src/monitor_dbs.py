import urllib.request
import json
from datetime import datetime, timedelta, timezone
import os
import sys

def post_to_slack(webhook_url, text):
    payload = {"text": text}
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        webhook_url, 
        data=data, 
        headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req) as res:
            res.read()
    except Exception as e:
        print(f"Failed to send Slack alert: {e}", file=sys.stderr)

def main():
    webhook_url = os.environ.get("SLACK_WEBHOOK_URL")
    if not webhook_url:
        print("Error: SLACK_WEBHOOK_URL environment variable is not set.", file=sys.stderr)
        sys.exit(1)

    json_url = "https://pub-1c068f2df9ab42a0b9dcc5d112078269.r2.dev/dashboard_data.json"
    try:
        # Add headers to avoid potential caching
        req = urllib.request.Request(
            json_url,
            headers={"Cache-Control": "no-cache", "Pragma": "no-cache"}
        )
        with urllib.request.urlopen(req, timeout=15) as response:
            data = json.loads(response.read().decode("utf-8"))
    except Exception as e:
        post_to_slack(webhook_url, f"⚠️ 【警告】死活監視スクリプトがダッシュボードデータ（JSON）の取得に失敗しました。\nエラー: {e}")
        sys.exit(1)

    updated_at_str = data.get("updated_at")
    if not updated_at_str:
        post_to_slack(webhook_url, "⚠️ 【警告】ダッシュボードデータ内に 'updated_at' フィールドが見つかりません。")
        sys.exit(1)

    # updated_at is JST (Japan Standard Time)
    try:
        updated_at = datetime.strptime(updated_at_str, "%Y-%m-%d %H:%M:%S")
        updated_at = updated_at.replace(tzinfo=timezone(timedelta(hours=9)))
    except Exception as e:
        post_to_slack(webhook_url, f"⚠️ 【警告】'updated_at' のパースに失敗しました ({updated_at_str})。\nエラー: {e}")
        sys.exit(1)

    # Current JST
    now_jst = datetime.now(timezone(timedelta(hours=9)))

    diff = now_jst - updated_at
    diff_minutes = diff.total_seconds() / 60

    print(f"Data updated at: {updated_at}")
    print(f"Current JST: {now_jst}")
    print(f"Difference: {diff_minutes:.1f} minutes")

    # If not updated for more than 30 minutes, send an alert
    if diff_minutes > 30:
        alert_text = (
            f"⚠️ *【警告】ドコモ・バイクシェア取得バッチが停止している可能性があります。*\n"
            f"データ最終更新: `{updated_at_str}` (約 {int(diff_minutes)} 分前)\n"
            f"ローカルPCの稼働状況やタスクスケジューラを確認してください。"
        )
        post_to_slack(webhook_url, alert_text)
        print("Slack alert sent.")
    else:
        print("Status OK. No alert needed.")

if __name__ == "__main__":
    main()
