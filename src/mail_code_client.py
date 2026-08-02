# -*- coding: utf-8 -*-
"""
メール2段階認証コードの取得クライアント。

Power Automate が Office365 に届いた認証コードメールを OneDrive 上の固定ファイル
(dbs_auth_code.txt) へ書き出し、本モジュールがパスワード付き共有リンク経由で
その内容を読み取り、認証コードを抽出します。

仕様の正本: docs/email-2fa-power-automate-spec.md

設計方針:
- Power Automate は「運搬」のみを担当し、コードの抽出は本モジュールが正規表現で行う
- 解析処理（parse_code_file / extract_code）は純粋関数とし、ブラウザなしでテスト可能にする
- 認証コード本体はログに出力しない（桁数と受信時刻のみ記録する）
"""
import html as html_lib
import json
import re
import time
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

from src.config import Config, ROOT_DIR

BODY_BEGIN = "X-BODY-BEGIN"
BODY_END = "X-BODY-END"
CODE_FILE_NAME = "dbs_auth_code.txt"


class AuthCodeError(RuntimeError):
    """認証コードの取得・解析に失敗した場合の例外。"""


class AuthCodeTimeout(AuthCodeError):
    """制限時間内に有効な認証コードを取得できなかった場合の例外。"""


# ---------------------------------------------------------------------------
# 受け渡しファイルの解析
# ---------------------------------------------------------------------------

@dataclass
class FetchResult:
    """共有リンクから取得した内容と、その HTTP メタデータ。"""
    text: str = ""
    last_modified: datetime = None
    etag: str = ""


@dataclass
class MailCodeRecord:
    """OneDrive 上の受け渡しファイル1件分の内容。"""
    headers: dict = field(default_factory=dict)
    body: str = ""

    @property
    def message_id(self) -> str:
        return self.headers.get("X-MESSAGE-ID", "")

    @property
    def subject(self) -> str:
        return self.headers.get("X-SUBJECT", "")

    @property
    def sender(self) -> str:
        return self.headers.get("X-FROM", "")


_HEADER_RE = re.compile(r"^(X-[A-Za-z0-9\-]+)\s*:\s*(.*)$")


def parse_code_file(text: str) -> MailCodeRecord:
    """
    受け渡しファイルのテキストを MailCodeRecord に解析します。

    2つの形式に対応します。
    - 拡張形式: 先頭が `X-...:` のヘッダ行で始まり、本文が X-BODY-BEGIN/END で挟まれている
      （docs/email-2fa-power-automate-spec.md セクション3.3 の形式）
    - 素の形式: Power Automate がメール本文だけを書き出したもの。全体を本文として扱う

    先頭行がヘッダでない場合は一切ヘッダ解釈を行いません。
    メール本文中の `X-...:` らしき行を誤ってヘッダとして食わないためです。
    """
    if not text or not text.strip():
        raise AuthCodeError("受け渡しファイルが空です。")

    text = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")

    first_line = next((line.strip() for line in text.split("\n") if line.strip()), "")
    if not _HEADER_RE.match(first_line):
        # 素のメール本文。ヘッダは無いものとして全体を本文にする
        return MailCodeRecord(headers={}, body=text.strip())

    headers = {}
    body_lines = []
    in_body = False

    for line in text.split("\n"):
        if in_body:
            if line.strip() == BODY_END:
                break
            body_lines.append(line)
            continue

        stripped = line.strip()
        if stripped == BODY_BEGIN:
            in_body = True
            continue

        matched = _HEADER_RE.match(stripped)
        if matched:
            headers[matched.group(1).upper()] = matched.group(2).strip()
        elif stripped:
            # X-BODY-BEGIN が欠落している場合の保険として本文に回す
            body_lines.append(line)

    return MailCodeRecord(headers=headers, body="\n".join(body_lines).strip())


def _parse_datetime(value: str):
    """ISO8601 を中心にいくつかの書式で日時をパースします。失敗時は None。"""
    if not value:
        return None
    text = value.strip()
    if not text:
        return None
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        pass
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S", "%Y-%m-%dT%H:%M"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def parse_http_date(value: str):
    """HTTP-date（例: Sun, 02 Aug 2026 00:33:39 GMT）を UTC の datetime にします。"""
    if not value:
        return None
    try:
        parsed = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def resolve_received_at(record: MailCodeRecord, fetched: FetchResult = None) -> datetime:
    """
    認証コードメールが届いた時刻を UTC の aware datetime として返します。

    優先順位:
      1. X-RECEIVED-AT（タイムゾーン付きの場合のみ）
      2. X-WRITTEN-AT（Power Automate の utcNow() 由来。常に UTC）
      3. 共有ファイルの HTTP last-modified
         （Power Automate がファイルを書き換えた時刻。メール受信の数秒後）

    タイムゾーン不明の時刻を推測で解釈することはしません。
    古いコードを新しいと誤判定して認証失敗を招くのを防ぐためです。
    どれも得られない場合は、古いコードを使う危険があるためエラーにします。
    """
    received = _parse_datetime(record.headers.get("X-RECEIVED-AT", ""))
    if received is not None and received.tzinfo is not None:
        return received.astimezone(timezone.utc)

    written = _parse_datetime(record.headers.get("X-WRITTEN-AT", ""))
    if written is not None:
        if written.tzinfo is None:
            written = written.replace(tzinfo=timezone.utc)
        return written.astimezone(timezone.utc)

    if fetched is not None and fetched.last_modified is not None:
        return fetched.last_modified.astimezone(timezone.utc)

    raise AuthCodeError(
        "認証コードの受信時刻を特定できません。ファイル内に X-RECEIVED-AT / X-WRITTEN-AT が無く、"
        " 共有ファイルの last-modified も取得できませんでした。"
        " 古い認証コードを使ってしまう危険があるため中断します。"
    )


# ---------------------------------------------------------------------------
# 本文からの認証コード抽出
# ---------------------------------------------------------------------------

CODE_KEYWORDS = (
    "認証コード",
    "確認コード",
    "認証番号",
    "確認番号",
    "ワンタイム",
    "セキュリティコード",
    "verification code",
    "security code",
    "one-time",
    "one time",
    "passcode",
    "otp",
)

# キーワードからこの文字数以内に現れた数字列を認証コードとみなす
KEYWORD_WINDOW = 80

_SCRIPT_RE = re.compile(r"(?is)<(script|style)[^>]*>.*?</\1>")
_TAG_RE = re.compile(r"<[^>]+>")
_CANDIDATE_RE = re.compile(r"(?<![0-9])([0-9]{4,8})(?![0-9])")

# 日時・数量を認証コードと誤認しないための除外文字
_UNIT_AFTER = "年月日時分秒円個台件％%"
_UNIT_BEFORE = "年月日第"


def strip_html(text: str) -> str:
    """HTMLメールの本文からタグを取り除き、プレーンテキスト化します。"""
    if "<" not in text:
        return text
    converted = _SCRIPT_RE.sub(" ", text)
    converted = re.sub(r"(?i)<br\s*/?>", "\n", converted)
    converted = re.sub(r"(?i)</(p|div|tr|li|h[1-6])\s*>", "\n", converted)
    converted = _TAG_RE.sub(" ", converted)
    return html_lib.unescape(converted)


def normalize_text(text: str) -> str:
    """タグ除去と NFKC 正規化（全角数字→半角など）を行います。"""
    return unicodedata.normalize("NFKC", strip_html(text or ""))


def _candidates(text: str):
    """4〜8桁の認証コード候補を、日時・数量らしきものを除外して列挙します。"""
    found = []
    for matched in _CANDIDATE_RE.finditer(text):
        following = text[matched.end():matched.end() + 1]
        preceding = text[matched.start() - 1:matched.start()] if matched.start() else ""
        if following and following in _UNIT_AFTER:
            continue
        if preceding and preceding in _UNIT_BEFORE:
            continue
        found.append(matched)
    return found


def extract_code(body: str, pattern: str = "") -> str:
    """
    メール本文から認証コードを抽出します。

    pattern が指定された場合はそれを優先します（グループ1があればその値）。
    未指定の場合は次の順で判定します。
      1. 認証コードを示すキーワードの近傍にある4〜8桁の数字
      2. 本文全体で候補がちょうど1件ならその値

    複数候補があり一意に定まらない場合は AuthCodeError を送出します
    （誤ったコードを送信して認証失敗・アカウントロックを招くのを防ぐため）。
    """
    text = normalize_text(body)

    if pattern:
        matched = re.search(pattern, text)
        if not matched:
            raise AuthCodeError("DBS_MAILCODE_REGEX に一致する箇所が本文にありませんでした。")
        return (matched.group(1) if matched.groups() else matched.group(0)).strip()

    found = _candidates(text)
    if not found:
        raise AuthCodeError("本文から4〜8桁の認証コード候補を検出できませんでした。")

    lowered = text.lower()
    best = None
    for keyword in CODE_KEYWORDS:
        key = keyword.lower()
        cursor = 0
        while True:
            index = lowered.find(key, cursor)
            if index < 0:
                break
            keyword_end = index + len(key)
            for matched in found:
                if keyword_end <= matched.start() <= keyword_end + KEYWORD_WINDOW:
                    if best is None or matched.start() < best.start():
                        best = matched
                    break
            cursor = keyword_end

    if best is not None:
        return best.group(1)

    if len(found) == 1:
        return found[0].group(1)

    raise AuthCodeError(
        f"認証コードの候補が {len(found)} 件あり一意に特定できませんでした。"
        " .env の DBS_MAILCODE_REGEX で抽出パターンを指定してください。"
    )


# ---------------------------------------------------------------------------
# 消費済みコードの記録（同一コードの二重使用防止）
# ---------------------------------------------------------------------------

def _default_state_path() -> Path:
    return Path(Config.OUTPUT_DIR) / "last_auth_code.json"


def _read_state(state_path: Path) -> dict:
    try:
        if state_path.exists():
            with open(state_path, "r", encoding="utf-8") as handle:
                return json.load(handle)
    except Exception as error:
        print(f"Warning: 認証コードの消費履歴を読み込めませんでした: {error}")
    return {}


def _write_state(state_path: Path, record: MailCodeRecord, fetched: FetchResult,
                 received_at: datetime) -> None:
    try:
        state_path.parent.mkdir(parents=True, exist_ok=True)
        with open(state_path, "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "message_id": _identity(record, fetched, received_at),
                    "received_at": received_at.isoformat(),
                    "consumed_at": datetime.now(timezone.utc).isoformat(),
                },
                handle,
                ensure_ascii=False,
                indent=2,
            )
    except Exception as error:
        print(f"Warning: 認証コードの消費履歴を保存できませんでした: {error}")


def _identity(record: MailCodeRecord, fetched: FetchResult, received_at: datetime) -> str:
    """
    このコードを一意に識別する値を返します。

    X-MESSAGE-ID が無い（メール本文だけの受け渡しファイル）場合は、
    更新のたびに変わる共有ファイルの ETag を使い、
    それも無ければ受信時刻で代用します。
    """
    if record.message_id:
        return record.message_id
    if fetched is not None and fetched.etag:
        return fetched.etag
    return received_at.isoformat()


# ---------------------------------------------------------------------------
# OneDrive 共有リンクからの読み取り
# ---------------------------------------------------------------------------

class OneDriveShareReader:
    """
    パスワード付き OneDrive 共有リンクから受け渡しファイルを読み取ります。

    ブラウザは open() で1度だけ起動・解錠し、以降のポーリングでは
    解錠済みセッションを再利用します（1回あたり数秒に短縮するため）。
    """

    def __init__(self, share_link: str = "", password: str = "", download_dir=None):
        self.share_link = share_link or Config.MAILCODE_SHARE_LINK
        self.password = password if password != "" else Config.MAILCODE_SHARE_PASSWORD
        self.download_dir = Path(download_dir) if download_dir else Path(Config.OUTPUT_DIR) / "_mailcode_tmp"
        self._driver = None
        self._unlocked = False

    # -- ライフサイクル ----------------------------------------------------

    def open(self):
        if self._driver is not None:
            return
        if not self.share_link:
            raise AuthCodeError(
                ".env に DBS_MAILCODE_SHARE_LINK が設定されていません。"
                " docs/email-2fa-power-automate-spec.md の手順を参照してください。"
            )
        from src.browser import build_driver

        self.download_dir.mkdir(parents=True, exist_ok=True)
        self._driver = build_driver(download_dir=self.download_dir)
        self._unlock()

    def close(self):
        if self._driver is not None:
            try:
                self._driver.quit()
            except Exception:
                pass
            self._driver = None
            self._unlocked = False

    def __enter__(self):
        self.open()
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()
        return False

    # -- 内部処理 ----------------------------------------------------------

    def _unlock(self):
        """共有リンクを開き、パスワード保護画面が出た場合は解錠します。"""
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.common.exceptions import TimeoutException
        from src.browser import BrowserUtils

        utils = BrowserUtils(self._driver)
        self._driver.get(self.share_link)

        try:
            password_input = utils.W(8).until(
                EC.presence_of_element_located(
                    (By.CSS_SELECTOR, "input[type='password'], #sharepoint-password-input")
                )
            )
        except TimeoutException:
            # パスワードが要求されない共有リンクの場合はそのまま進む
            self._unlocked = True
            return

        if not self.password:
            raise AuthCodeError(
                "共有リンクがパスワードを要求していますが、DBS_MAILCODE_SHARE_PASSWORD が未設定です。"
            )

        password_input.clear()
        password_input.send_keys(self.password)
        submit = self._driver.find_element(
            By.CSS_SELECTOR,
            "input[type='submit'], button[type='submit'], input[value='確認'],"
            " input[value='Verify'], button.ms-Button--primary",
        )
        utils.click_js(submit)
        time.sleep(5)
        self._unlocked = True

    def _download_url(self) -> str:
        separator = "&" if "?" in self.share_link else "?"
        return f"{self.share_link}{separator}download=1"

    def _read_via_fetch(self):
        """
        解錠済みセッションのまま fetch() でファイル本文を取得します。

        本文と同時に last-modified / etag も回収します。受け渡しファイルが
        メール本文だけの場合、コードの新しさを判定できるのがこの last-modified
        だけになるためです。fetch の text() は常に UTF-8 で復号されるため、
        ブラウザの表示文字コードに左右されません。
        """
        script = """
        const url = arguments[0];
        const done = arguments[arguments.length - 1];
        fetch(url, {credentials: 'include'})
          .then(async r => {
             if (!r.ok) { done({ok: false, error: 'HTTP ' + r.status}); return; }
             const text = await r.text();
             done({
               ok: true,
               text: text,
               lastModified: r.headers.get('last-modified') || '',
               etag: r.headers.get('etag') || ''
             });
          })
          .catch(e => done({ok: false, error: String(e)}));
        """
        try:
            self._driver.set_script_timeout(30)
            result = self._driver.execute_async_script(script, self._download_url())
        except Exception as error:
            return None, f"fetch 実行エラー: {error}"
        if not result or not result.get("ok"):
            return None, f"fetch 失敗: {(result or {}).get('error', 'unknown')}"

        text = result.get("text") or ""
        if not text.strip():
            return None, "fetch で取得した内容が空でした。"
        return (
            FetchResult(
                text=text,
                last_modified=parse_http_date(result.get("lastModified", "")),
                etag=(result.get("etag") or "").strip(),
            ),
            None,
        )

    def _read_via_download(self):
        """
        fetch が使えない場合に、実ファイルをダウンロードして読み取ります。

        この経路では last-modified を取得できないため、ファイル内に
        X-RECEIVED-AT / X-WRITTEN-AT が無いと受信時刻を判定できません。
        """
        for stale in self.download_dir.glob("*"):
            try:
                stale.unlink()
            except Exception:
                pass

        try:
            self._driver.get(self._download_url())
        except Exception:
            # ダウンロードによるナビゲーション中断は正常系でも発生する
            pass

        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            files = [
                path for path in self.download_dir.glob("*")
                if path.is_file() and path.suffix not in (".crdownload", ".tmp")
            ]
            if files:
                newest = max(files, key=lambda path: path.stat().st_mtime)
                try:
                    return FetchResult(text=newest.read_text(encoding="utf-8-sig")), None
                except Exception as error:
                    return None, f"ダウンロードしたファイルを読めません: {error}"
            time.sleep(1)
        return None, "ダウンロードしたファイルが見つかりませんでした。"

    # -- 公開API ----------------------------------------------------------

    def read(self) -> FetchResult:
        """受け渡しファイルの内容と HTTP メタデータを返します。"""
        self.open()

        fetched, fetch_error = self._read_via_fetch()
        if fetched is not None:
            return fetched

        fetched, download_error = self._read_via_download()
        if fetched is not None:
            return fetched

        self.save_debug_snapshot()
        raise AuthCodeError(
            "OneDrive 共有リンクから受け渡しファイルを取得できませんでした。"
            f" (fetch: {fetch_error} / download: {download_error})"
        )

    def save_debug_snapshot(self, prefix: str = "mailcode_error"):
        """失敗時の画面をデバッグ用に保存します（既存の OneDrive 処理と同じ方式）。"""
        if self._driver is None:
            return
        try:
            debug_dir = ROOT_DIR / "debug"
            debug_dir.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            self._driver.save_screenshot(str(debug_dir / f"{prefix}_{stamp}.png"))
            (debug_dir / f"{prefix}_{stamp}.html").write_text(
                self._driver.page_source, encoding="utf-8"
            )
            print(f"Info: 失敗時の画面を debug/{prefix}_{stamp}.png / .html に保存しました。")
        except Exception as error:
            print(f"Warning: デバッグ用スナップショットの保存に失敗しました: {error}")


def looks_like_sharepoint_page(text: str) -> bool:
    """
    取得した内容が受け渡しファイルではなく OneDrive/SharePoint の画面かを判定します。

    共有リンクの解錠に失敗した場合、ファイルの代わりにログイン画面やエラー画面の
    HTML が返るため、エラーメッセージを分かりやすくする用途に使います。
    """
    if not text:
        return False
    head = text[:2000].lower()
    if "<!doctype html" in head and ("sharepoint" in head or "sign in" in head or "サインイン" in head):
        return True
    return "sharepoint-password" in head or "guestaccess.aspx" in head


# ---------------------------------------------------------------------------
# 認証コードの待機
# ---------------------------------------------------------------------------

def wait_for_auth_code(
    since: datetime,
    timeout_sec: int = None,
    poll_sec: int = None,
    reader=None,
    state_path=None,
    pattern: str = None,
    max_age_sec: int = None,
    clock_skew_sec: int = None,
    now_func=None,
) -> str:
    """
    ログインフォーム送信後に届く認証コードを待ち受けて返します。

    since:   ログインフォームを送信した時刻（aware datetime）。
             これより前に受信したメールは古いコードとして無視します。
    reader:  read_text() を持つオブジェクト。省略時は OneDriveShareReader を使用します。

    戻り値: 認証コード文字列
    例外:   AuthCodeTimeout（制限時間内に有効なコードを取得できなかった場合）
    """
    if since.tzinfo is None:
        raise ValueError("since はタイムゾーン付きの datetime で指定してください。")

    timeout_sec = Config.MAILCODE_TIMEOUT_SEC if timeout_sec is None else timeout_sec
    poll_sec = Config.MAILCODE_POLL_SEC if poll_sec is None else poll_sec
    max_age_sec = Config.MAILCODE_MAX_AGE_SEC if max_age_sec is None else max_age_sec
    clock_skew_sec = Config.MAILCODE_CLOCK_SKEW_SEC if clock_skew_sec is None else clock_skew_sec
    pattern = Config.MAILCODE_REGEX if pattern is None else pattern
    now_func = now_func or (lambda: datetime.now(timezone.utc))

    state_path = Path(state_path) if state_path else _default_state_path()
    last_consumed = _read_state(state_path).get("message_id", "")

    owns_reader = reader is None
    reader = reader or OneDriveShareReader()

    earliest = since - timedelta(seconds=clock_skew_sec)
    deadline = time.monotonic() + timeout_sec
    last_reason = "受け渡しファイルをまだ取得できていません。"

    print(f"Info: メール認証コードの到着を待機します（最大 {timeout_sec} 秒）...")
    try:
        while True:
            try:
                fetched = reader.read()
                if looks_like_sharepoint_page(fetched.text):
                    raise AuthCodeError(
                        "受け渡しファイルではなく OneDrive の画面が返りました。"
                        " 共有リンクのパスワードまたは有効期限を確認してください。"
                    )

                record = parse_code_file(fetched.text)
                received_at = resolve_received_at(record, fetched)
                age = (now_func() - received_at).total_seconds()

                if received_at < earliest:
                    last_reason = "ファイルの内容がログイン前に受信した古いメールのままです。"
                elif age > max_age_sec:
                    last_reason = f"受信から {int(age)} 秒経過しており有効期限切れとみなしました。"
                elif last_consumed and _identity(record, fetched, received_at) == last_consumed:
                    last_reason = "前回のログインで使用済みの認証コードです。"
                else:
                    code = extract_code(record.body, pattern)
                    _write_state(state_path, record, fetched, received_at)
                    print(
                        f"Success: 認証コードを取得しました（{len(code)}桁 /"
                        f" 受信 {received_at.isoformat()} / 経過 {int(age)}秒）"
                    )
                    return code
            except AuthCodeError as error:
                last_reason = str(error)

            if time.monotonic() >= deadline:
                raise AuthCodeTimeout(
                    f"{timeout_sec} 秒以内に有効な認証コードを取得できませんでした。理由: {last_reason}"
                )
            time.sleep(poll_sec)
    finally:
        if owns_reader:
            try:
                reader.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# 疎通確認用エントリーポイント
# ---------------------------------------------------------------------------

def probe(argv=None):  # pragma: no cover - 手動疎通確認用
    """
    共有リンクからの取得が成功するかを確認します。認証コードは伏字で表示します。

    使い方: python -m src.mail_code_client
    """
    print("=== メール認証コード受け渡しの疎通確認 ===")
    if not Config.MAILCODE_SHARE_LINK:
        print("Error: .env に DBS_MAILCODE_SHARE_LINK が設定されていません。")
        return 1

    reader = OneDriveShareReader()
    try:
        fetched = reader.read()
        print(f"Success: 受け渡しファイルを取得しました（{len(fetched.text)} 文字）。")

        if looks_like_sharepoint_page(fetched.text):
            print("Error: ファイルではなく OneDrive の画面が返っています。共有リンクとパスワードを確認してください。")
            reader.save_debug_snapshot()
            return 1

        record = parse_code_file(fetched.text)
        received_at = resolve_received_at(record, fetched)
        age = (datetime.now(timezone.utc) - received_at).total_seconds()

        source = "ファイル内ヘッダ" if record.headers else "共有ファイルの last-modified"
        print(f"- 形式     : {'拡張形式（X-ヘッダあり）' if record.headers else 'メール本文のみ'}")
        print(f"- 差出人   : {record.sender or '(ファイルに情報なし)'}")
        print(f"- 件名     : {record.subject or '(ファイルに情報なし)'}")
        print(f"- 受信時刻 : {received_at.isoformat()} （{int(age)} 秒前 / 判定元: {source}）")
        print(f"- 識別子   : {_identity(record, fetched, received_at)[:60]}")

        code = extract_code(record.body, Config.MAILCODE_REGEX)
        masked = code[0] + "*" * (len(code) - 2) + code[-1] if len(code) > 2 else "*" * len(code)
        print(f"Success: 認証コードを抽出できました: {masked} （{len(code)}桁）")
        return 0
    except AuthCodeError as error:
        print(f"Error: {error}")
        return 1
    finally:
        reader.close()


if __name__ == "__main__":  # pragma: no cover
    import sys

    sys.exit(probe(sys.argv[1:]))
