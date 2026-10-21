import urllib.request
import json
from datetime import datetime, timedelta, timezone
import os
import sys
from pathlib import Path


JST = timezone(timedelta(hours=9))
ANNOUNCEMENT_PATH = Path(__file__).resolve().parents[1] / "announcement.json"


def is_scraping_maintenance_active(config_path=None, now=None):
    """Return True when announcement.json intentionally pauses scraping."""
    path = Path(config_path) if config_path else ANNOUNCEMENT_PATH
    try:
        with path.open("r", encoding="utf-8") as handle:
            config = json.load(handle)

        maintenance = config.get("maintenance", {})
        scraping_disabled = maintenance.get(
            "scraping_disabled",
            maintenance.get("enabled", False),
        )
        if not scraping_disabled:
            return False

        start_time_str = maintenance.get("start_time")
        if not start_time_str:
            return True

        maintenance_start = datetime.fromisoformat(
            start_time_str.replace("Z", "+00:00")
        )
        if maintenance_start.tzinfo is None:
            maintenance_start = maintenance_start.replace(tzinfo=JST)

        current = now or datetime.now(timezone.utc)
        if current.tzinfo is None:
            current = current.replace(tzinfo=JST)
        return current.astimezone(timezone.utc) >= maintenance_start.astimezone(timezone.utc)
    except Exception as error:
        print(
            f"Warning: maintenance status could not be read; monitoring continues: {error}",
            file=sys.stderr,
        )
        return False

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
    if is_scraping_maintenance_active():
        print("Scraping maintenance is active. Slack heartbeat alert is paused.")
        return

    webhook_url = os.environ.get("SLACK_WEBHOOK_URL")
    if not webhook_url:
        print("Error: SLACK_WEBHOOK_URL environment variable is not set.", file=sys.stderr)
        sys.exit(1)

    json_url = "https://pub-1c068f2df9ab42a0b9dcc5d112078269.r2.dev/dashboard_data.json"
    try:
        # Add headers to avoid potential caching and bypass Cloudflare Bot/WAF blocking
        req = urllib.request.Request(
            json_url,
            headers={
                "Cache-Control": "no-cache", 
                "Pragma": "no-cache",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            }
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
        updated_at = updated_at.replace(tzinfo=JST)
    except Exception as e:
        post_to_slack(webhook_url, f"⚠️ 【警告】'updated_at' のパースに失敗しました ({updated_at_str})。\nエラー: {e}")
        sys.exit(1)

    # Current JST
    now_jst = datetime.now(JST)

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
