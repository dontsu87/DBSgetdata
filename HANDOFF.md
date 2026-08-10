# DBSgetdata 引き継ぎ書（2026-08-02）

ドコモ・バイクシェアのシステム刷新（2026-07-31 21:00 切替）への対応作業の引き継ぎ。
本書はこのプロジェクトの技術判断・実測結果の正本とする。

> **最重要**: 対象は**本番稼働中**のシステムである。状態を変更する操作は一切行わないこと。
> 詳細は「7. 安全ルール」を必ず読むこと。

---

## 1. 現在地

| 領域 | 状態 |
|------|------|
| メール2段階認証の自動取得 | **完成・実機で成功** |
| 新システムのログイン自動化 | **実装・テスト完了**（保存セッション優先、切断時のみMFA） |
| セッション外部保持 | **実装・別ブラウザ復元成功**（`output/dbs_session.json`） |
| 車両情報の取得 | **HTTP GET優先のハイブリッド実装・実機検証完了**（通常はブラウザなし、5エリア / 1,211台） |
| 本番稼働 | **2026-08-02 12:29に再開済み**。5分タスク連続2回成功、R2アップロード成功 |

再開後の本番取得は `output/車両情報_20260802_122925.csv` と `output/車両情報_20260802_123424.csv` で連続成功した。

---

## 2. 新システムの確定事実（すべて 2026-08-02 に実機で実測）

### 2.1 認証基盤

**AWS Cognito の Hosted UI による OAuth2 認可コードフロー**。旧システムとは別物。

```
https://mg-auth.docomo-cycle.jp/login
  ?client_id=5i6uvuur9dgtofcdq47kbhkp89
  &redirect_uri=https://mg.docomo-cycle.jp/
  &response_type=code&lang=ja
```

| | 旧システム | 新システム |
|---|---|---|
| ログインID | 独自ID | **メールアドレス** |
| セッション | HTML hidden の `SessionID` | Cookie（永続あり） |
| 画面 | サーバ生成HTML | React SPA |
| アカウント | 事業者用 / 作業員用 の2系統 | **単一の管理ポータルに統合** |
| エリア | エリアごとにログインし直し | **全エリアを一括表示可能** |

アカウント統合により、`main.py` の `--admin` 分岐と `is_worker` の概念は**不要**になる。

### 2.2 ログイン画面の要素（実測）

`form` は `POST`、action は現在URLと同じ。

| 要素 | セレクタ |
|------|----------|
| ID欄 | `input[name='username']`（`type=email`, placeholder `name@host.com`） |
| パスワード欄 | `input[name='password']` |
| 送信ボタン | ラベル `サインイン` |
| hidden | `csrf`, `cognitoAsfData` |

`id` 属性は `formField:R6dtf55:` のような **React の useId 由来で毎回変わる**。
**id でセレクタを組んではいけない。`name` を使うこと。**

### 2.3 2段階認証（MFA）画面の要素（実測）

ID/PW 送信後、必ずここへ遷移する（今回の調査では毎回発生した）。

```
https://mg-auth.docomo-cycle.jp/mfa/email/verify?...
```

| 要素 | セレクタ |
|------|----------|
| コード入力欄 | `input[name='code']`（`type=text`, placeholder `コードを入力`） |
| 送信ボタン | ラベル **`サインイン`**（「認証」「確認」ではない） |
| hidden | `csrf`, `cognitoAsfData` |

画面タイトルは **`MFA 検証コード`**、本文は「E メール MFA」「E メール で k\*\*\*@n\*\*\*. に送信されたコードを入力します。」。

> **落とし穴**: 画面に「認証コード」という語は**出てこない**（「検証コード」）。
> 文言で画面判定するとすり抜ける。**URL に `/mfa/` が含まれるかで判定すること。**

### 2.4 Cookie（CDP で採取した全6件）

| 名前 | ドメイン | 永続 | 役割 |
|------|----------|------|------|
| `cognito` | `.mg-auth.docomo-cycle.jp` | **あり** | Cognito の SSO セッション本体 |
| `post-auth` | `mg-auth.docomo-cycle.jp` | あり | |
| `XSRF-TOKEN` | `mg-auth.docomo-cycle.jp` | セッション限り | |
| `lang` | `mg-auth.docomo-cycle.jp` | セッション限り | |
| `dbspf_session` | `mg.docomo-cycle.jp` | **あり** | アプリ側のセッション |
| `redirect_uri` | `mg.docomo-cycle.jp` | セッション限り | |

- hidden の `SessionID` 相当は**存在しない**（旧システムの制約は解消）
- localStorage: `Amazon.AWS.Cognito.ContextData.LS_UBID`（Cognito の端末フィンガープリント）

### 2.5 ログイン後の画面

`https://mg.docomo-cycle.jp/` の「トップ画面」。左メニュー（上から）:

```
トップ / ユーザ情報 / エリア情報 / ポート情報 / 車両状態 / 車両情報 /
車種情報 / 問題申告 / 配信機能 / 法人契約情報 / 料金精算 / 集配 / ログアウト
```

ヘッダ赤ブロックに `最終ログイン` / `[エリア] エリア未選択` / `[アカウントID]` が表示される。
**この `[エリア]` がエリア選択の入口**と思われる（利用者談: ここで全エリアを選ぶと全エリア分が表示される）。

証拠: `debug/newsite/20260802_102642/10_session_restored.png`

---

## 3. アーキテクチャ決定

### 決定1: セッション外部保持を採用する（常駐化は不要）

**実証済み。** ログイン後の Cookie を保存 → ブラウザを完全終了 → 別プロセスで復元 →
`https://mg.docomo-cycle.jp/` に直接アクセスして、**MFAを再発生させずにトップ画面に到達**した。

したがって:
- 現行のタスクスケジューラによる5分ごと都度起動を**そのまま維持できる**
- 常駐化・デーモン化は**不要**（当初の第2候補は破棄）
- 認証コードメールは、セッションが切れたときだけ飛ぶ

再現手順は「8. コマンド集」の `session` を参照。

### 決定2: 1ログインで全エリアを取得する

新サイトは全エリア一括表示に対応。現行 `main.py` の「エリアごとにログアウト→再ログイン」
（6エリア × 5分周期 = 1日約1,700回ログイン）は**廃止する**。
この設計のままではMFAが1日1,700回発生し、運用不能になる。

### 決定3: Cookie の採取・復元は CDP を使う

`driver.get_cookies()` は**現在のオリジンの Cookie しか返さない**。
認証基盤（`mg-auth`）とアプリ（`mg`）でオリジンが分かれているため、これでは `cognito` を取りこぼす。

```python
cookies = driver.execute_cdp_cmd("Network.getAllCookies", {})["cookies"]  # 全件取得
driver.execute_cdp_cmd("Network.setCookie", cookie_dict)                  # 投入
```

実装参考: `scratch/investigate_new_site.py` の `save_session()` / `restore_session()`。

---

## 4. 完成済みの成果物

### 4.1 メール2段階認証コードの自動取得（実機で成功）

```
Success: 認証コードを取得しました（6桁 / 受信 2026-08-02T01:26:24+00:00 / 経過 1秒）
```

経路: 認証コードメール → Power Automate → OneDrive の固定ファイル `dbs_auth_code.txt`
→ パスワード付き共有リンク → スクレイパーが読み取り。

- 実装: [`src/mail_code_client.py`](src/mail_code_client.py)
- 仕様書: [`docs/email-2fa-power-automate-spec.md`](docs/email-2fa-power-automate-spec.md)
- テスト: [`tests/test_mail_code_client.py`](tests/test_mail_code_client.py)（45件）

**主要API**:
```python
from src.mail_code_client import wait_for_auth_code
code = wait_for_auth_code(since=datetime.now(timezone.utc))  # ログイン送信時刻を渡す
```

**実測値**:
- Power Automate の伝送遅延は **1〜2秒**（当初180秒のタイムアウトを見込んでいたが桁違いに速い）
- メール本文は HTML。本文中の「証」が数値文字参照 `&#35388;` で書かれている
- 受け渡しファイルにタイムスタンプが無いため、**HTTP の `last-modified` を受信時刻**、
  **`etag` をコードの同一性判定**に使っている（詳細は仕様書 4.3）

### 4.2 調査スクリプト（読み取り専用）

[`scratch/investigate_new_site.py`](scratch/investigate_new_site.py)（`scratch/` は git 管理外）

禁止語（削除・登録・更新・保存・変更・貸出・返却 等）を含むラベルの要素は
`assert_safe_to_click()` が例外で停止させる。クリックするのはログイン送信とMFA送信のみ。

### 4.3 設定（`.env`）

新規追加した変数（値は記入済み）:

```
DBS_LOGIN_URL=            # 新ログインページ
DBS_LOGIN_EMAIL=          # 新ポータルのログイン用メールアドレス
DBS_LOGIN_PASSWORD=
DBS_MAILCODE_SHARE_LINK=  # 認証コード受け渡しファイルの共有リンク
DBS_MAILCODE_SHARE_PASSWORD=
```

旧システム用の `DBS_WORKER_ACCOUNT` 等は切り戻し用に**残してある**。
`Config.login_credentials()` / `Config.login_url()` は新値のみを返す。**閉鎖済み旧ポータルにはフォールバックしない。**

`.env.example` を新規作成し、`.gitignore` に `.env.*`（`!.env.example`）を追加済み。

---

## 5. 当初の作業項目（最新の完了状況は「10. 引き継ぎ後の進捗」を参照）

### タスク1: `src/session_store.py` の実装（完了）

`scratch/investigate_new_site.py` の `save_session()` / `restore_session()` を本番品質にする。

- 保存先: `output/dbs_session.json`
- CDP で全 Cookie を採取・復元する（決定3）
- **保存URLに `?code=...` を含めないこと**。ログイン直後のURLに付く認可コードは**使い捨て**で、
  再訪すると必ず認証が失敗する。復元先は `https://mg.docomo-cycle.jp/` を使う
- セキュリティ: このファイルは**実質的に認証情報**（盗まれればログイン済み状態そのもの）。
  git 管理外にし、外部送信・アップロードは禁止

### タスク2: `src/auth.py` の書き換え（完了）

処理フロー:
1. `session_store` で復元 → `https://mg.docomo-cycle.jp/` へアクセス
2. パスワード欄・`input[name='code']` が無く、URLが `mg-auth` でなければ**認証済み**。ログイン処理を丸ごとスキップ
3. 無効なら通常ログイン: `input[name='username']` / `input[name='password']` に入力し `サインイン` をクリック
4. URLに `/mfa/` が含まれたら `wait_for_auth_code(since=送信時刻)` でコードを取得し、
   `input[name='code']` に入力して `サインイン` をクリック
5. `https://mg.docomo-cycle.jp/` に着いたらセッションを保存し直す

> **判定に文字列一致を使わないこと。** 画面の「最終ログイン」が「ログイン」に一致して
> ログイン画面と誤判定する事故を実際に起こした。入力欄の有無とURLで判定すること。

### タスク3: 車両情報取得の調査と実装（GET API方式で完了）

以下は当初のDOM調査計画。実際には、危険な画面操作を避けるため読み取り専用GET API方式へ変更して完了した（詳細は第10節）。

1. `scratch/investigate_new_site.py explore` を実行（セッション復元して読み取り調査）
2. ヘッダの `[エリア] エリア未選択` から**全エリア選択**を行う操作を特定する
   - 利用者談: 「左のタブの上の方にエリア選択があり、そこで全エリア選択すると全エリア表示になる」
   - **自動で特定できない場合は、スクリーンショットを利用者に見せて聞くこと**（利用者の指示）
3. 左メニューの `車両状態` と `車両情報` の両方を開き、DOM構造を採取する
   - 旧システムで取得していた項目: 識別番号 / 車両状態 / ポート名 / 電圧 / AT通知受信日時
   - 利用者談:「項目自体は旧サイトと似ているが、DOM等は一新されていると思われる」
4. `src/scraper.py` を新DOM向けに書き換える
5. `src/dashboard_generator.py` が受け取る列名の互換性を確認する
   （壊すと `index.html` のダッシュボードが動かなくなる）

### タスク4: `main.py` の巡回ロジック書き換え（完了）

- エリアごとのログアウト→再ログインのループを削除
- 1ログイン → 全エリア表示 → 一括取得 に変更
- `--admin` / `is_worker` 分岐の整理（アカウント統合により不要）

### タスク5: 本番復帰（完了）

利用者の明示承認を受け、2026-08-02 12:27に `maintenance.enabled` を `false` へ変更した。
5分タスクは12:29・12:34の連続2回成功を確認済み。

---

## 6. 未確定事項

- [ ] MFAコードの有効期限（実測していない。現在は既定値600秒＝10分で運用）
- [ ] MFAが発生する条件（今回の調査では毎回発生した。セッションが有効な間は発生しない）
- [ ] `dbspf_session` / `cognito` の実際の有効期間（**5分周期の運用で何時間・何日もつかは未測定**）
      → セッション切れの頻度＝MFAメールの発生頻度なので、運用開始後に実測すること
- [ ] 「この端末を信頼する」に相当するオプションの有無（ログイン画面には見当たらなかった）

---

## 7. 安全ルール（厳守）

1. **本番稼働中のシステムである。** 状態を変更する操作は絶対に行わない。読み取りのみ。
2. クリックしてよいのは、ログイン送信・MFA送信・画面遷移（メニュー/タブ/リンク）だけ。
   削除・登録・更新・保存・変更・確定・貸出・返却・解除などのボタンは**絶対に押さない**。
3. 調査前に必ず `check_maintenance_mode()` が `True`（＝定期実行が止まっている）ことを確認する。
   止まっていないと、5分ごとのタスクスケジューラと調査ログインが競合する。
4. 認証情報（`.env`、`output/dbs_session*.json`）を読み取って外部に送信しない。ログにも出さない。
   調査スクリプトの `sanitize()` が成果物からID・パスワードをマスクしている。
5. 削除・移動は人間の承認なしに行わない。`.env` の編集も利用者の明示指示があったときだけ。
6. `debug/newsite/` の成果物にはアカウントIDが写り込んだスクリーンショットが含まれる。
   `debug/` は git 管理外だが、外部共有しないこと。

---

## 8. コマンド集

```bash
cd D:\antigravity\DBSgetdata
```

| 目的 | コマンド |
|------|----------|
| テスト実行 | `.venv\Scripts\python.exe -X utf8 -m pytest tests/ -q` |
| 認証コード受け渡しの疎通確認 | `.venv\Scripts\python.exe -X utf8 -m src.mail_code_client` |
| ログイン調査（MFAメールが飛ぶ） | `.venv\Scripts\python.exe -X utf8 scratch/investigate_new_site.py login` |
| セッション復元の検証（MFAは飛ばない） | `.venv\Scripts\python.exe -X utf8 scratch/investigate_new_site.py session` |
| 画面構造の調査 | `.venv\Scripts\python.exe -X utf8 scratch/investigate_new_site.py explore` |

- 成果物は `debug/newsite/<タイムスタンプ>/` に `*.png` / `*.html` / `*.json` で保存される
- `*.json` には画面のフォーム・入力欄・クリック可能要素・表構造・Cookie・Storage の一覧が入る

> `index.html` の `ver.YYYYMMDDHHMMSS` は、`main.py` / `src/config.py` /
> `src/dashboard_generator.py` / `index.html` / `main.js` / `style.css` /
> `車両閾値設定.csv` を変更したら必ず更新すること（`tests/test_version.py` が強制する）。
> `index.html` 自身も監視対象なので、書き込みと同じ分の時刻を入れる。

---

## 9. 未コミットの変更

このセッションの作業はすべて**未コミット**。コミットは利用者の指示を待つこと。

```
 M .gitignore                          # .env.* を無視、.env.example は例外
 M src/config.py                       # 新ログイン/メールコード用の設定を追加
 M src/browser.py                      # build_driver に download_dir 引数を追加（後方互換）
 M index.html                          # ver. 更新
 M docs/sms-auth-implementation-plan.md # 旧計画に「置き換え済み」注記
?? .env.example                        # 新規（README が参照していたのに存在しなかった）
?? docs/email-2fa-power-automate-spec.md
?? src/mail_code_client.py
?? tests/test_mail_code_client.py
?? HANDOFF.md
```

`main.py` / `run_scraper.bat` / `tests/test_maintenance.py` / `public_ports.js` の変更は
**このセッション以前からある未コミット変更**であり、今回の作業とは無関係。

---

## 10. 引き継ぎ後の進捗（2026-08-02 11:00時点）

### 実装完了

- `src/session_store.py`
  - CDP の `Network.getAllCookies` / `Network.setCookie` で全Cookieを保存・復元
  - 保存先は `output/dbs_session.json`（git管理外・認証情報相当）
  - 復元先は必ず `https://mg.docomo-cycle.jp/`。使い捨ての `?code=` は保存・再訪しない
  - 調査用セッションから本番保存先へ移行し、別ブラウザプロセスで復元成功
- `src/auth.py`
  - 保存セッション優先、無効時のみメールアドレス/PW/MFAを実行する新認証フローを追加
  - 認証判定はURLと `input[name='password']` / `input[name='code']` の有無だけで行う
- `src/new_portal_scraper.py`
  - 保存Cookieを `requests.Session` へ復元し、通常巡回はChrome/Seleniumなしの読み取り専用GETで取得
  - 旧ブラウザ内GET実装は診断・過去参考用として残すが、通常実行経路からは呼ばない
  - `GET /api/areas` で5エリアを取得
  - 各エリアについて `GET /api/vehicles?page=...&pageSize=500&affiliationAreaIds=...` を実行
  - 1ログインのまま全エリアを巡回するため、MFAはセッション切れ時だけ発生
  - API状態コードを旧CSV互換の日本語状態名へ変換
- `main.py`
  - デフォルト実行を新ポータル専用の「保存CookieでHTTP GET → 全エリア取得 → 既存CSV/ダッシュボード処理」に変更
  - 保存セッション不在・破損・401/403・認証リダイレクト時だけChrome/Seleniumを1回起動して認証し、ブラウザ終了後にHTTP GETを1回だけ再試行
  - HTTP 5xx、通信障害、JSON/スキーマ異常ではブラウザを起動しない
  - 閉鎖済み旧ポータルへ自動フォールバックしない
  - 旧DOM巡回部分は到達不能な参考区画として注記して保持
- `src/config.py`
  - `DBS_LOGIN_URL` / `DBS_LOGIN_EMAIL` / `DBS_LOGIN_PASSWORD` を必須化
  - 旧 `DBS_TOP_PAGE` / `DBS_WORKER_TOP_PAGE` / 旧IDへのフォールバックを廃止

### 実機の読み取り専用検証結果

- 対象エリア: 5（福井 / 小松 / 金沢 / 上田千曲広域 / 敦賀）
- 取得車両: **1,211件**
- 車両識別番号の重複: 0件
- 車両識別番号の欠損: 0件
- エリア名の欠損: 0件
- ポート名の空欄: 146件（ポート外車両。エリア名はエリア別GETにより保持）
- 取得列: `エリア名 / 識別番号 / 車両状態 / ポート名 / 電圧 / AT通知受信日時`
- 全テスト: **90件成功**

### 重要な追加判断

1. **閉鎖済み旧ポータルはフォールバック対象にしない。**
   旧コードは過去仕様の調査・参照用としてのみ残す（利用者の明示方針）。
2. **UIの「すべて選択」確定は使わない。**
   本番アカウントの表示設定を変更し得るため、安全審査で停止した。代わりにGET APIへ各エリアIDを直接指定する。
3. **全エリア一括APIレスポンスだけではポート外車両のエリアが分からない。**
   エリアごとにGETすることで、1ログインを維持しつつ全車両のエリア名を正確に付与する。

### 残作業

- メンテナンスモードを維持したまま、保存・ダッシュボード生成部分を含む結合テストを行う
- 既存最終CSVとの列型・状態値・ダッシュボード表示の差分確認
- 本番復帰済み。異常時は `maintenance.enabled=true` に戻して停止する
---

## 11. 再稼働可否・ブラウザレス化調査（2026-08-02）

### 再稼働に必要な情報

取得・変換・ダッシュボード生成に必要な情報は揃っている。

- 読み取り専用GETで5エリア・1,211台を取得
- 必須6列（エリア名 / 識別番号 / 車両状態 / ポート名 / 電圧 / AT通知受信日時）を取得
- 車両ID重複0、車両ID欠損0、エリア名欠損0
- 一時領域で既存処理へ接続し、1,211行CSVを生成
- ダッシュボードJSON/JSを生成し、1,211台・247ポートを保持
- 公開ポートJSON/JSも一時領域で生成成功

R2アップロードと実タスクスケジューラ連続運転は、2026-08-02の本番復帰で確認済み。

### ブラウザなし車両取得

**成立を実証済み。** `output/dbs_session.json` のCookieを `requests.Session` に投入し、Chrome / Selenium / Playwrightを起動せず次を取得できた。

- `GET /api/areas`: HTTP 200、5エリア
- `GET /api/vehicles`: 全1,211台
- 合計7 GETリクエスト
- 車両ID重複0、車両ID・エリア名欠損0
- Python起動を含む実測約5秒

したがって5分ごとの通常取得にブラウザ起動は不要。

### ブラウザなし再認証

完全ブラウザレス再認証は未成立。

1. requestsでログインGET: 成功
2. ID/PWのフォームPOST: 成功し、MFA画面へ到達
3. メールコード自動取得: 成功（実測10秒）
4. MFAフォームPOST: HTTP 400、APIは401

成功したブラウザMFA画面では hidden `cognitoAsfData` が912文字ある一方、単純なHTTP GET時は空だった。Cognito Hosted UIのブラウザ側Advanced Securityデータ生成が不足した可能性が高い。

`POST /api/auth/refresh-session` のHTTP単独検証は、認証セッションを変更する操作のため安全ゲートで実行しなかった。

### 推奨構成

当面はハイブリッド方式が最も確実。

1. 通常の5分取得は `requests` のみ（ブラウザ起動なし）
2. 保存Cookieが有効なら、そのまま全エリアを約5秒で取得
3. HTTP 401時だけChrome/Seleniumを起動してID/PW + MFA
4. 新Cookieを `output/dbs_session.json` に保存してブラウザ終了
5. 以後は再びrequestsのみ

この方式なら、ブラウザ起動は5分ごとではなくセッション切れ時だけになる。完全ブラウザレス化は `cognitoAsfData` 生成またはHTTPセッション更新の追加調査後に判断する。
---

## 12. HTTP優先ハイブリッド方式の実装完了（2026-08-02 12:12時点）

### 実装

- `src/new_portal_scraper.py`
  - `output/dbs_session.json` の `all_cookies` を `requests.Session` に復元
  - Cookieのdomain / path / secure / expiresを保持し、値はログ・例外へ出さない
  - `/api/areas` とエリア別 `/api/vehicles` をGETのみで取得
  - 接続10秒・読取30秒の有限タイムアウト、最大1,000ページ
  - 認証失敗を `PortalSessionError`、認証以外を `PortalApiError` に分離
- `main.py`
  - 最初は必ずHTTP取得を試行するため、正常時は `build_driver()` を呼ばない
  - 認証セッション失敗時だけChromeを1回起動し、既存のID/PW + メールMFAでCookieを更新
  - Chromeを終了してからHTTP取得を最初から1回だけ再試行（無限再認証なし）
  - 閉鎖済み旧ポータルは引き続き到達不能な参考コードであり、フォールバックしない
- `requirements.txt`
  - 通常実行環境の直接依存として `requests` を追加

### 検証

- 新規・更新した境界条件テスト: 18件成功
- 全回帰テスト: **103件成功**
- 実機1回目（保存セッション期限切れ）:
  - HTTP認証失敗を検知
  - Chromeを認証時だけ1回起動
  - メールMFAコードを6秒で取得
  - Cookie保存後にChromeを終了
  - `requests` で5エリア・1,211台を取得、ID重複0件
- 実機2回目（更新済みCookie再利用）:
  - Chrome/Seleniumを起動せず、`requests` GETのみ
  - 5エリア・1,211台、ID重複0件
  - 実測 **2.97秒**

### 残る運用ゲート

- メンテナンスモードは2026-08-02 12:27に解除済み
- CSV・ダッシュボード生成の結合は一時領域で検証済みだが、今回の実機確認では外部/生成物書き込みを無効化した
- R2のdashboard/public_ports両アップロードと、実タスクスケジューラの連続2回成功を確認済み
- 5分周期の継続監視を行い、異常時は `maintenance.enabled=true` で再停止する
---

## 13. 本番復帰（2026-08-02 12:29）

### 反映内容

- `announcement.json`
  - `maintenance.enabled=false` にして定期取得を再開
  - 利用者向けバナーを「ドコモバイクシェア更新に暫定対応しました」に変更
  - バナー表示期間は2026-08-02 12:27〜2026-08-31 23:59:59（JST）
- Windowsタスク `DBS_Scraper_5Min`
  - タスク自体はもともと有効（Ready）で、メンテナンス判定により処理をスキップしていた
  - 停止解除後、12:29と12:34の5分周期連続2回を正常完了
  - 次回実行時刻も設定され、定期運転へ復帰
- `run_scraper.vbs` / `src/upload_to_r2.py`
  - `main.py` 失敗時とR2アップロード失敗時をタスク終了コードへ伝播
  - dashboard_data.json / public_ports.json の両方が成功した場合だけ0終了

### 本番確認値

- 12:29実行: CSV 1,211行、5エリア、車両ID重複0、ID欠損0、エリア欠損0
- ダッシュボード: 1,211台、247ポート
- R2: dashboard_data.json / public_ports.json の両アップロード成功
- 12:34実行: 新CSV生成、TaskResult `0x00000000`
- 次回実行: 12:39予定（5分周期）

### Git反映

- 第1コミット: 新ポータル・HTTP優先ハイブリッド・MFA・テスト一式
- 第2コミット: 本番アラート、最新公開ポートデータ、タスク/R2失敗伝播、本番復帰記録
- `.env`、保存セッション、`output/`、`debug/` はGit対象外のまま

---

## 14. 停止監視のメンテナンス連動（2026-08-04）

GitHub Actions の `Monitor DBS Scraper` は、Slack通知判定の前に
`announcement.json` のスクレイピング停止状態を確認する。

- `maintenance.scraping_disabled=true` かつ開始時刻到来後は、停止が意図的なためSlack通知を休止する
- `scraping_disabled=false` の画面縮退表示だけなら、スクレイピング停止監視を継続する
- `scraping_disabled` が無い旧設定は、後方互換として `maintenance.enabled` を使用する
- 設定ファイルの欠損・破損・日時異常時は監視を継続し、意図しない通知停止を避ける
- メンテナンス解除時は同じ設定変更だけでSlack停止監視も自動的に再開する

---

## 15. 車両位置詳細の1時間周期取得（2026-08-10）

- 通常の5分更新は従来どおり、ポート外車両の位置詳細だけを取得する。既存の DBS_VEHICLE_LOCATION_FETCH_MAX_PER_RUN 上限も維持する。
- output/vehicle_location_hourly_state.json の成功時刻を基準に、1時間経過した5分更新だけ、ポート所属車両を含む全車両の位置詳細を取得する。この実行では位置詳細取得上限を解除する。
- 5分更新で取得対象外となる車両の位置詳細は output/vehicle_location_cache.json から引き継ぎ、次の全車両取得まで表示・判定を維持する。両ファイルは出力領域のgit対象外である。
- 実測位置は既存のポート表示座標（lat / lon）とは別の 車両位置緯度 / 車両位置経度 列として保持する。
- 実測位置とポート座標の距離が100mを超えた場合だけ、車両状態を上書きしない別列 ポート位置不整合 を True とする。既存の車両状態・電圧警告とは独立して扱う。
- 画面の「位置不整合抽出」トグルがOFFなら従来のポート紐づけ表示、ONなら該当車両を実測GPSのポート外車両として再配置する。ポート外一覧では該当行を赤系で強調し、地図上の点も大きい赤色で表示する。
---

## 16. 全車両取得後の10分クールダウン（2026-08-10）

- 全車両位置取得が正常完了した時点から600秒間、次の5分タスクの車両スクレイピングを抑止する。
- 抑止は output/vehicle_location_hourly_state.json の cooldown_until_epoch で管理し、Task Schedulerの周期自体は5分のまま維持する。
- クールダウン中はメイン処理が終了し、日次GBFS判定も行わない。次の実行スロットで車両取得と日次判定を再開する。
- GBFS取得は別Windowsタスクではなく、車両取得完了後に同一プロセスで last_gbfs_run.txt の日付を確認して最大1日1回実行する。したがって車両取得とGBFS取得が同時並行する実装ではない。
- 日次GBFS取得・日次Parquetマージが長引いた場合は、Task Schedulerの MultipleInstancesPolicy=IgnoreNew により実行中の次スロットを起動せず、完了後の次回スロットで再開する。