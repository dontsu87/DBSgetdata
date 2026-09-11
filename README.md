# ドコモ・バイクシェア 車両情報スクレイピングツール

このプログラムは、ドコモ・バイクシェアの管理システム（次世代CS）から管轄エリアの車両情報（識別番号、車両状態、ポート名、電圧、AT通知受信日時）を自動的に取得し、1つのCSVファイルに集約してOneDriveへ保存するスクリプトです。

> [!WARNING]
> 本システムは実稼働中のシステムへのアクセスを伴います。
> 不要な設定変更やクリックを発生させない安全な設計に配慮していますが、接続環境やログイン情報の管理には十分にご注意ください。

## 前提条件
- 固定IP認証（VPNなど）が有効な状態であること。
- Python 3.12 以上が導入されていること。

## セットアップ手順

1. **必要なライブラリのインストール**
   ```bash
   pip install -r requirements.txt
   ```

2. **設定ファイルの準備**
   本フォルダ直下に `.env` ファイルを新規作成（または `.env.example` をコピーしてリネーム）し、必要なログイン情報とOneDriveの出力先パスを設定します。
   ```bash
   copy .env.example .env
   ```

   `.env` 内の設定項目：
   - `DBS_ACCOUNT`: ログインID
   - `DBS_PASSWORD`: ログインパスワード
   - `ONEDRIVE_OUTPUT_DIR`: 出力先フォルダ（例: `C:\Users\Username\OneDrive\バイクシェア\車両情報`）

### ポート外車両の位置詳細取得

通常の車両一覧取得後、最新GBFSに対応するポート座標がない車両だけを対象に、位置詳細APIを追加取得します。取得結果は車両CSVと履歴Parquetに、`位置詳細取得フラグ`、`位置詳細取得状態`、`車両位置緯度`、`車両位置経度`などとして保存されます。

負荷が高い場合は、一覧取得を止めずに追加取得だけを停止できます。

```text
DBS_VEHICLE_LOCATION_FETCH_ENABLED=false
```

台数上限と呼び出し間隔は `DBS_VEHICLE_LOCATION_FETCH_MAX_PER_RUN`（既定200台）、`DBS_VEHICLE_LOCATION_FETCH_DELAY_MS`（既定100ms）で調整できます。

## ディレクトリ構成
- `src/`: アプリケーションのコアコード
- `tests/`: 単体テストコード
- `docs/`: 開発関連ドキュメント
- `main.py`: 実行用エントリーポイント
- AIエージェント向けの作業ルールは [`AGENTS.md`](./AGENTS.md) にまとめています。

## ポート状態の予約管理

管理ポータル標準の2件の更新予約を、ポートごとの週次レシピから照合・補充できます。
予約時刻になった瞬間のPC稼働には依存せず、利用者はポート詳細画面で次の予約を確認できます。

設定例は `config/port_booking_recipes.json.example` です。`recipes` に曜日、時刻、予約する状態を定義し、
`ports` で各ポートへレシピを割り当てます。同じレシピの共有と、ポートごとの異なるレシピの両方に対応します。

状態には実際の値または `inherit` を指定できます。

- `service_state`: 管理ポータルの運用状態、または `inherit`
- `publish_flag`: `true` / `false` / `inherit`
- `parking_quantity_limitation_flag`: `true` / `false` / `inherit`
- `parking_quantity_limit`: 1～32767、または `inherit`

まず書き込みなしで差分を確認します。

```powershell
.\.venv\Scripts\python.exe -m src.port_booking_scheduler --config .\config\port_booking_recipes.json
```

不足する予約を空き枠へ登録する場合だけ `--apply` を付けます。

```powershell
.\.venv\Scripts\python.exe -m src.port_booking_scheduler --config .\config\port_booking_recipes.json --apply
```

予約済みの `inherit` 項目と現在値が異なる場合や、レシピ外の予約がある場合は、既存予約を更新・削除せず停止します。
`SLACK_WEBHOOK_URL` が設定されていれば理由を通知し、同じ内容は30分間抑止します。毎回の結果は既定で
`output/port_booking_scheduler_state.json` に保存されます。

同時に、内部IDを含まないURL表示用の `output/port_booking_status.json` を生成します。
`--publish-status`を付けた場合だけ、このJSONをR2の`port_booking_status.json`へ公開します。
表示ページはGitHub Pages配下の`/booking-status/`で、ポート名、予約日時、運用状態、公開設定、
駐輪台数制限、最終確認時刻を表示します。

```powershell
.\.venv\Scripts\python.exe -m src.port_booking_scheduler --config .\config\port_booking_recipes.json --apply --publish-status
```

本機能は既存の保存済み管理ポータルセッションを使用します。初期版は新規予約の補充だけを行い、
競合した予約の自動更新・削除は行いません。定期実行へ登録する前に、対象ポートを `enabled: false` のまま
読み取りモードで確認してください。

## ライセンス・注意事項
通常のスクレイピングはデータ参照だけを行います。ポート予約管理は独立コマンドで、`--apply`を明示した場合だけ管理ポータルへ新規予約を登録します。

## 開発時の安全策（開発中ロックについて）
本番環境でタスクスケジューラ等の自動実行と競合することを防ぐため、スクレイピングやエクスポート周りのソースコードを編集する際は、一時的に実行ガード（開発中ロック）を設定します。

### 設定方法
`main.py` の `run_scraping` 関数の先頭に `return` を記述して実行をスキップさせます。
```python
def run_scraping(is_worker=False):
    return  # 開発中ロック（タスクスケジューラ競合防止用）
```

### 注意事項
- 開発中は自動スクレイピングによる最新データの更新が一時的に停止します。
- **修正が完了し、動作確認とテストが正常に通った後は、必ずこの `return` を削除して本番稼働に戻してください。**

