# 指示書: 「利用中」車両の位置情報が古いまま表示される問題の修正

作成日: 2026-08-15。前セッションの調査結果を引き継ぐための自己完結ドキュメント。
このファイル単体で作業を開始できるよう、背景・証拠・修正方針をすべて記載する。

---

## 0. このワークスペースについて(必読)

- `D:\antigravity\DBSgetdata` は **本番稼働中** のシステム。Windowsタスクスケジューラが5分周期で
  `main.py` を実行し、ドコモ・バイクシェアの管理ポータル(`mg.docomo-cycle.jp`、2026年8月刷新のReact SPA)
  から車両情報を取得し続けている。
- 詳しい安全ルールは [`HANDOFF.md`](../HANDOFF.md) の「7. 安全ルール」を必ず読むこと。要点:
  - ポータルへは読み取り専用GET以外を発行しない(本タスクはポータルアクセス方法自体を変えない)
  - `.env` / `output/dbs_session*.json` を読み書き・出力しない
  - 削除・移動は行わない
- 作業ルールは [`AGENTS.md`](../AGENTS.md) を参照。小さく局所的な変更に留め、`output/` や
  `dashboard_data.*` などの生成物は成果物であって直接編集しないこと。
- 変更後は `index.html` の `ver.YYYYMMDDHHMMSS` を更新すること
  (`main.py` / `src/config.py` / `src/dashboard_generator.py` / `index.html` / `main.js` / `style.css` /
  `車両閾値設定.csv` のいずれかを変更したら必須。`tests/test_version.py` が強制する)。

---

## 1. 背景(現場報告)

利用者から: 「管理ポータル側の位置情報ではポート場所が継続表示される感じで、バッテリー管理システム
(このダッシュボード)で未施錠と表示されても現地に自転車がない事象が散見される」。

追加の現場報告: 「利用中でポートから離れている車両は、本来なら一覧データで"ポート外"と表示される
べきところ、利用直前のポート名が表示されている疑いが濃厚」。

## 2. 調査で確定した事実(実データで検証済み)

### 2.1 「未施錠未返却」バッジの判定ロジック(このタスクでは変更しない)

[`src/exporter.py:211-243`](../src/exporter.py) — 車両状態が「利用中」のまま、ポート名が前回と
同じ状態が続いた時間を積算し、既定2時間([`js/state.js:37`](../js/state.js) の
`unlockedThresholdHours`)を超えると地図上に🔑バッジが付く。**個別GPS取得の有無とは無関係**。
このロジック自体は正しく動作しており、変更対象ではない。

### 2.2 個別GPS取得(実測位置)の対象選定ロジック(★ここが問題の核心)

[`src/new_portal_scraper.py:300-306`](../src/new_portal_scraper.py) の `fetch_vehicle_location_details`
内、各行を実測GPS取得の対象にするかどうかの判定:

```python
target = (
    include_port_vehicles
    or vehicle_code in mismatch_vehicle_ids
    or _is_out_of_port_row(row, known_port_names)
)
```

- `include_port_vehicles`: 1時間に1回の全件スイープの時だけ True
  ([`main.py:201-226`](../main.py)、`should_fetch_all_locations` が interval_sec=3600 で判定)
- `mismatch_vehicle_ids`: **前回CSV**で `ポート位置不整合=True` だった車両のIDの集合
  ([`src/vehicle_location_scheduler.py:64-84`](../src/vehicle_location_scheduler.py) の
  `load_mismatch_vehicle_ids`)
- `_is_out_of_port_row`: ポータルAPIの `portName` が空、または既知ポート名一覧に無い場合のみ True
  ([`src/new_portal_scraper.py:241-249`](../src/new_portal_scraper.py))

**問題**: ポータルAPIは、車両が「利用中(USING)」の間、`portName` を**貸出元ポートのまま更新しない**
(実データで確認済み。§2.3参照)。したがって:

1. 車両が貸し出された直後は、`portName` が変化しないため `_is_out_of_port_row` は False
2. その車両は過去に一度も不整合フラグが立っていなければ `mismatch_vehicle_ids` にも入らない
3. → 個別GPS取得の対象に**入らない**
4. 次の1時間周期の全件スイープが来るまで(最大約1時間)、実測GPSは一度も更新されない
5. その間、システムが持っている「GPS」は**貸出開始より前の、駐輪時点の古い測位**でしかない
6. 古いGPSは当然ポート座標とほぼ一致するため `ポート位置不整合` も False のまま
   → フロントエンドの「位置不整合抽出」トグルをONにしても、切り替える先の新しいデータが無いので
   表示は変わらない

### 2.3 実データでの証拠(2026-08-15 14:09時点のCSV `output/車両情報_20260815_140957.csv`)

現在「利用中」61台のうち、貸出開始から時間が経過している車両は**軒並みGPS測位日時が貸出開始より前**
だった(給油帯データより古い):

| 識別番号 | 表示ポート名 | 貸出開始 | GPS測位日時(貸出**前**) | 経過 |
|---|---|---|---|---|
| KNZ0277 / KNZ0113 / KNZ0345 | 04.近江町市場(同一ポートに3台集中) | 13:45:17 | 12:48〜13:03 | 約25分 |
| IZM023 | I02.出雲大社前駅 | 13:40:05 | 12:50:46 | 約30分 |
| UED060 | U-13.赤坂上駅 | 13:55:08 | 12:00:19(**2時間近く前**) | 約15分 |

いずれも `ポート位置不整合=False`。個別GPSが一度も更新されていないので当然の結果であり、
現場報告と完全に一致する。

### 2.4 対照: 個別GPS取得が機能している場合の挙動(参考・正常系)

車両 `KNZ0206`(金沢)は 2026-08-15 06:58:17 から「利用中」が継続。この車両はほぼ毎サイクル
`位置詳細取得状態=取得成功` で実測GPSが更新され続けており、`ポート位置不整合=True` を正しく検出、
実際に貸出元ポートから離れた地点にいることが確認できた(測位日時が毎回前進、自然なGPSジッター、
他車両との座標重複なし=データ不整合バグではなく本物の測位)。**なぜこの車両だけ毎回取得できて
いたかは未調査**(おそらく直近の1時間スイープでたまたま不整合フラグが立ち、以降
`mismatch_vehicle_ids` の自己継続ループに乗ったため)。この対照事例が、個別GPS取得さえ回れば
正しく機能することの根拠になる。

### 2.5 データ構造の補足(実装時に有用)

- ダッシュボード用JSON(`dashboard_data.json`)の各bikeオブジェクトには、既に
  `vehicle_lat` / `vehicle_lon`(実測GPS) / `gps_datetime`(測位日時) / `unlocked_started_at`
  (連続利用開始日時) / `status` / `port_position_mismatch` が含まれている
  ([`src/dashboard_generator.py:514-544`](../src/dashboard_generator.py))。
  → フロントエンド側の判定(GPSが貸出開始より新しいか)に必要な材料は既に揃っている。
- フロントエンドの表示切り替えロジックは [`js/map.js`](../js/map.js) 内に複数箇所ある
  (`preparePositionMismatchData`(313行目〜、`isPositionMismatchMode` でゲート)、
  個別バイクマーカー生成(1646-1648行目付近、`bike.lat || port.lat` を使用)など)。
  **前セッションではどの描画パスがどの条件で `bike.lat`(実測GPS) vs `port.lat`(ポート座標)を
  使うか、完全には特定できていない。** フロントエンド修正に着手する前に、実際の描画コードを
  一から丁寧に追い、現状の挙動を再現・確認すること(§4.2参照)。

---

## 3. 修正方針

### 3.1 バックエンド修正(確信度: 高、これが根本対策)

**目的**: 「利用中」の車両は、既存の対象条件に加えて**毎回**個別GPS取得の対象にする。

対象ファイル: [`src/new_portal_scraper.py`](../src/new_portal_scraper.py) の
`fetch_vehicle_location_details` 関数(252行目〜)、300-306行目付近。

```python
# 変更前
target = (
    include_port_vehicles
    or vehicle_code in mismatch_vehicle_ids
    or _is_out_of_port_row(row, known_port_names)
)

# 変更後(イメージ。実際のキー名は row の構造に合わせて確認すること)
vehicle_state = str(row.get('vehicleState') or '').strip()
target = (
    include_port_vehicles
    or vehicle_code in mismatch_vehicle_ids
    or _is_out_of_port_row(row, known_port_names)
    or vehicle_state == 'USING'  # 「利用中」。VEHICLE_STATE_LABELS[19行目]の生値(英語コード)を使う
)
```

**注意点**:
- `row` の中身が英語コード(`vehicleState: "USING"`)か日本語ラベル変換後かを、実際にこの関数へ
  渡される時点のデータ構造を確認してから実装すること(呼び出し元 `459-536行目` 付近を参照)。
  日本語ラベル変換後であれば `"利用中"` と比較する。
- **運用コスト**: 2026-08-15 14:09時点で全エリア合計「利用中」61台。上限
  `DBS_VEHICLE_LOCATION_FETCH_MAX_PER_RUN`(既定500件/回、[`src/config.py:82`](../src/config.py))
  に対して十分小さい。ただし複数拠点でイベント等により同時利用が急増するケースを考慮し、
  実装後は台数がどの程度上限に近づくか実測で確認すること。
- 既存の `mismatch_vehicle_ids` を使った自己継続ループ(前回不整合だった車両を次回も対象にする仕組み)
  はそのまま残してよい(利用中でなくなった後、返却直後の位置不整合検出に引き続き使われるため)。

### 3.2 フロントエンド修正(確信度: 中、§2.5の再検証が前提)

**目的**: 「利用中」の車両について、`ポート位置不整合` フラグや「位置不整合抽出」トグルの状態に
関わらず、**GPSの測位日時(`gps_datetime`)が貸出開始日時(`unlocked_started_at`)より新しければ**
実測GPS位置(`vehicle_lat`/`vehicle_lon`)を優先して表示する。

**着手前に必須**: `js/map.js` の描画パスを実機(ブラウザDevTools)で1つずつ確認し、現状どのケースで
`bike.lat`(既に実測GPSが入っている場合がある)と `port.lat`(ポート座標)のどちらが実際に画面へ
反映されているかを先に確定させること。前セッションの調査では以下の矛盾する手がかりがあり、
未解決:
- `dashboard_generator.py:543-544` は、bikeごとの `lat`/`lon` フィールド自体を「実測GPSがあれば
  常にそれを優先」するロジックに見える(位置不整合フラグやトグルと無関係)
- しかし `preparePositionMismatchData`(`map.js:312-313`)は `isPositionMismatchMode` が
  False なら何もせず元データをそのまま返す
- 個別バイクマーカー生成(`map.js:1647`)は `bike.lat || port.lat` を使っており、`bike.lat` が
  入っていればそれを使う経路も存在する

→ つまり、**現状でも既に一部の描画パスでは実測GPSが使われている可能性がある**。もしそうなら、
フロントエンド側の追加修正は不要で、§3.1のバックエンド修正だけで問題が解消する可能性がある。
実機確認を先にすること。

もしフロントエンド側にも本当に手を入れる必要があると判明した場合の実装イメージ:

```js
// 表示用の座標を決める箇所で
const gpsIsFresh = bike.gps_datetime && bike.unlocked_started_at &&
    new Date(bike.gps_datetime) > new Date(bike.unlocked_started_at.replace(' ', 'T'));
const useRealGps = bike.status === '利用中' && gpsIsFresh &&
    bike.vehicle_lat !== null && bike.vehicle_lon !== null;
```

日時文字列のタイムゾーン扱いに注意: `gps_datetime` は `+09:00` 付きISO8601、
`unlocked_started_at` はタイムゾーン無しの `YYYY-MM-DD HH:MM:SS`(JSTのローカル時刻)。
単純比較すると9時間ずれるバグを踏みやすい(前セッションで実際に一度踏んだ)。両方をJSTの
ローカル時刻として揃えてから比較すること。

---

## 4. 検証手順

### 4.1 バックエンド

1. `.venv\Scripts\python.exe -X utf8 -m pytest tests/test_new_portal_scraper.py tests/test_main_new_portal.py -q`
   が通ること。
2. 新しいテストケースを追加: 「`vehicleState=USING` かつポート名が既知ポートかつ
   `mismatch_vehicle_ids` に含まれない行が、target判定でTrueになる」ことを検証。
3. 可能であれば1サイクル分、実データ(読み取り専用)で動作確認: 現在「利用中」だがGPSが古い車両
   (§2.3の表の識別番号、例: `KNZ0113` / `IZM023` / `UED060`)が、修正後の次回実行で
   `位置詳細取得状態=取得成功` に変わり、`車両位置測位日時` が貸出開始日時より新しくなることを確認する。
   ※ これは本番の5分タスクの結果を観察するだけで良く、ポータルへの追加リクエストを人為的に
   発生させる必要はない。

### 4.2 フロントエンド(手を入れた場合)

1. `.venv\Scripts\python.exe -X utf8 -m pytest tests/test_dashboard.py -q`
2. ブラウザで `index.html` を開き、上記で実測GPSが新しくなった車両を検索し、
   - 「位置不整合抽出」トグルOFFのまま、その車両の表示位置が実測GPS(貸出元ポートから離れた場所)に
     なっているか
   - 併せて「未施錠未返却」バッジの表示(閾値超過時)が従来通り正しいままか
   を確認する。

---

## 5. 完了報告に含めるべき内容

- 変更ファイルとdiff
- pytest結果(コマンドと結果)
- §4.1/4.2の実機確認結果(実際に確認した識別番号・時刻・観察値)
- `index.html` の `ver.` 更新有無
- 未解決事項(特に§3.2の「フロントエンド修正が本当に必要か」の判定結果)
- このセッションで判断が必要になった事項(あれば)

このタスクは本番の5分間隔スクレイパーに影響するコード変更を含むため、**コミット・本番反映は
利用者の明示指示を待つこと**(`HANDOFF.md` の運用方針を踏襲)。
