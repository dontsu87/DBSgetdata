# -*- coding: utf-8 -*-
"""
src/mail_code_client.py のユニットテスト。

ブラウザや OneDrive には一切アクセスせず、解析処理と待機ロジックのみを検証します。
"""
import json
from datetime import datetime, timedelta, timezone

import pytest

from src.mail_code_client import (
    AuthCodeError,
    AuthCodeTimeout,
    FetchResult,
    MailCodeRecord,
    extract_code,
    looks_like_sharepoint_page,
    normalize_text,
    parse_code_file,
    parse_http_date,
    resolve_received_at,
    wait_for_auth_code,
)

UTC = timezone.utc

# 実際に Power Automate が OneDrive へ格納したメール本文の構造（2026-08-02 実測）。
# コードの数字だけはダミー値に差し替えてある。
# 「証」が数値文字参照 &#35388; で書かれている点までそのまま再現している。
REAL_MAIL_BODY = (
    '<html><head>\r\n'
    '<meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body>'
    'docomo bike share 管理ポータルの認&#35388;コードをお知らせします。<br><br>'
    '認&#35388;コード：<b>654321</b><br><br>'
    'docomo bike share 管理ポータルの認&#35388;コード入力画面に、上記の認&#35388;コードを'
    '入力してください。<br><br>'
    '認&#35388;コードを第三者へ共有しないでください。<br>'
    '本メールに心当たりがない場合は、認&#35388;コードを使用せず、本メールを破棄してください。<br>'
    'ご不明な点がある場合は、システム管理者へお問い合わせください。<br><br>'
    '※本メールは送信専用です。返信いただいても回答できません。 </body></html>'
)


def build_file(received_at="2026-08-01T00:15:23Z", body="認証コードは 483920 です。",
               message_id="AAMkAD-001", written_at="2026-08-01T00:15:40Z"):
    """拡張形式（仕様書セクション3.3）の受け渡しファイルを組み立てます。"""
    return (
        f"X-RECEIVED-AT: {received_at}\n"
        f"X-SUBJECT: 【ドコモ・バイクシェア】認証コードのお知らせ\n"
        f"X-FROM: no-reply@example.jp\n"
        f"X-MESSAGE-ID: {message_id}\n"
        f"X-WRITTEN-AT: {written_at}\n"
        f"X-BODY-BEGIN\n"
        f"{body}\n"
        f"X-BODY-END\n"
    )


# ---------------------------------------------------------------------------
# parse_code_file（拡張形式）
# ---------------------------------------------------------------------------

def test_parse_code_file_reads_headers_and_body():
    record = parse_code_file(build_file())
    assert record.sender == "no-reply@example.jp"
    assert record.message_id == "AAMkAD-001"
    assert "認証コード" in record.subject
    assert record.body == "認証コードは 483920 です。"


def test_parse_code_file_tolerates_crlf_and_bom():
    text = "﻿" + build_file().replace("\n", "\r\n")
    record = parse_code_file(text)
    assert record.message_id == "AAMkAD-001"
    assert "483920" in record.body


def test_parse_code_file_rejects_empty():
    with pytest.raises(AuthCodeError):
        parse_code_file("   \n  ")


# ---------------------------------------------------------------------------
# parse_code_file（メール本文のみの素の形式）
# ---------------------------------------------------------------------------

def test_parse_raw_mail_body_keeps_everything_as_body():
    """先頭がヘッダでなければ、全体を本文として扱うこと。"""
    record = parse_code_file(REAL_MAIL_BODY)
    assert record.headers == {}
    assert "654321" in record.body
    assert record.message_id == ""


def test_parse_raw_body_does_not_eat_header_like_lines():
    """メール本文中の 'X-...:' らしき行をヘッダとして誤って取り込まないこと。"""
    body = "ご案内\nX-Ray-Service: 定期点検のお知らせ\n認証コードは 483920 です。"
    record = parse_code_file(body)
    assert record.headers == {}
    assert "X-Ray-Service" in record.body
    assert extract_code(record.body) == "483920"


def test_parse_code_file_without_body_markers_still_yields_body():
    text = "X-RECEIVED-AT: 2026-08-01T00:15:23Z\n認証コードは 483920 です。\n"
    record = parse_code_file(text)
    assert "483920" in record.body


# ---------------------------------------------------------------------------
# 受信時刻の判定
# ---------------------------------------------------------------------------

def test_resolve_received_at_uses_utc_offset():
    record = parse_code_file(build_file(received_at="2026-08-01T00:15:23Z"))
    assert resolve_received_at(record) == datetime(2026, 8, 1, 0, 15, 23, tzinfo=UTC)


def test_resolve_received_at_handles_non_utc_offset():
    record = parse_code_file(build_file(received_at="2026-08-01T09:15:23+09:00"))
    assert resolve_received_at(record) == datetime(2026, 8, 1, 0, 15, 23, tzinfo=UTC)


def test_resolve_received_at_falls_back_to_written_at_when_naive():
    """タイムゾーンの無い受信時刻は推測せず、utcNow() 由来の X-WRITTEN-AT を使う。"""
    record = parse_code_file(
        build_file(received_at="2026-08-01 09:15:23", written_at="2026-08-01T00:15:40Z")
    )
    assert resolve_received_at(record) == datetime(2026, 8, 1, 0, 15, 40, tzinfo=UTC)


def test_resolve_received_at_falls_back_to_http_last_modified():
    """メール本文だけのファイルでは、共有ファイルの last-modified を受信時刻とみなす。"""
    record = parse_code_file(REAL_MAIL_BODY)
    fetched = FetchResult(
        text=REAL_MAIL_BODY,
        last_modified=datetime(2026, 8, 2, 0, 33, 39, tzinfo=UTC),
        etag='"{709AEC46-9DB7-4959-8A9A-BAE3D1B628C4},4"',
    )
    assert resolve_received_at(record, fetched) == datetime(2026, 8, 2, 0, 33, 39, tzinfo=UTC)


def test_resolve_received_at_prefers_in_file_header_over_last_modified():
    record = parse_code_file(build_file(received_at="2026-08-01T00:15:23Z"))
    fetched = FetchResult(last_modified=datetime(2026, 8, 2, 0, 33, 39, tzinfo=UTC))
    assert resolve_received_at(record, fetched) == datetime(2026, 8, 1, 0, 15, 23, tzinfo=UTC)


def test_resolve_received_at_raises_when_no_usable_timestamp():
    """時刻が一切得られない場合は、古いコードを使う危険があるためエラーにする。"""
    record = MailCodeRecord(headers={}, body="認証コードは 483920 です。")
    with pytest.raises(AuthCodeError):
        resolve_received_at(record, FetchResult(text="x"))


def test_parse_http_date():
    assert parse_http_date("Sun, 02 Aug 2026 00:33:39 GMT") == datetime(
        2026, 8, 2, 0, 33, 39, tzinfo=UTC
    )
    assert parse_http_date("") is None
    assert parse_http_date("not a date") is None


# ---------------------------------------------------------------------------
# extract_code
# ---------------------------------------------------------------------------

def test_extract_code_from_real_mail_body():
    """実物のメール本文からコードを取り出せること（本命の回帰テスト）。"""
    record = parse_code_file(REAL_MAIL_BODY)
    assert extract_code(record.body) == "654321"


def test_normalize_resolves_numeric_character_reference():
    """本文中の &#35388; が『証』に復元され、キーワード照合が効くこと。"""
    assert "認証コード" in normalize_text(REAL_MAIL_BODY)


@pytest.mark.parametrize("body,expected", [
    ("認証コードは 483920 です。", "483920"),
    ("認証コード： 483920", "483920"),
    ("確認コード\n\n483920\n\n有効期限は10分です。", "483920"),
    ("ワンタイムパスワード 4839", "4839"),
    ("Your verification code is 483920.", "483920"),
    ("セキュリティコード: 12345678", "12345678"),
])
def test_extract_code_from_common_layouts(body, expected):
    assert extract_code(body) == expected


def test_extract_code_normalizes_fullwidth_digits():
    assert extract_code("認証コードは ４８３９２０ です。") == "483920"


def test_extract_code_strips_html_body():
    body = "<html><body><p>認証コード</p><h1 style='font-size:24px'>483920</h1></body></html>"
    assert extract_code(body) == "483920"


def test_extract_code_ignores_dates_and_quantities():
    body = "2026年8月1日 10時30分に送信しました。認証コードは 483920 です。"
    assert extract_code(body) == "483920"


def test_extract_code_prefers_keyword_neighbour_over_other_numbers():
    body = "お問い合わせ番号 99887766 についてのご連絡です。認証コードは 483920 です。"
    assert extract_code(body) == "483920"


def test_extract_code_accepts_single_candidate_without_keyword():
    assert extract_code("ログインを完了するには 483920 を入力してください。") == "483920"


def test_extract_code_raises_when_ambiguous():
    """キーワードが無く候補が複数ある場合は、誤送信を避けるためエラーにする。"""
    with pytest.raises(AuthCodeError):
        extract_code("お問い合わせ番号 99887766 と 12345 をご確認ください。")


def test_extract_code_raises_when_no_candidate():
    with pytest.raises(AuthCodeError):
        extract_code("本メールはテスト配信です。")


def test_extract_code_uses_custom_pattern():
    assert extract_code("code=[483920]", pattern=r"code=\[(\d+)\]") == "483920"


def test_extract_code_custom_pattern_without_group():
    assert extract_code("ID:XY483920", pattern=r"XY\d+") == "XY483920"


def test_extract_code_custom_pattern_no_match_raises():
    with pytest.raises(AuthCodeError):
        extract_code("認証コードは 483920 です。", pattern=r"code=\[(\d+)\]")


def test_normalize_text_unescapes_entities():
    assert "483920" in normalize_text("<span>&#35469;&#35388;</span> 483920")


# ---------------------------------------------------------------------------
# 共有リンクの解錠失敗の検知
# ---------------------------------------------------------------------------

def test_looks_like_sharepoint_page():
    login = "<!DOCTYPE html><html><body>Sign in to SharePoint</body></html>"
    assert looks_like_sharepoint_page(login) is True
    assert looks_like_sharepoint_page(REAL_MAIL_BODY) is False
    assert looks_like_sharepoint_page(build_file()) is False
    assert looks_like_sharepoint_page("") is False


# ---------------------------------------------------------------------------
# wait_for_auth_code
# ---------------------------------------------------------------------------

class FakeReader:
    """read() の戻り値を順に返す差し替え用リーダー。"""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = 0
        self.closed = False

    def read(self):
        self.calls += 1
        value = self.responses[min(self.calls - 1, len(self.responses) - 1)]
        if isinstance(value, Exception):
            raise value
        if isinstance(value, FetchResult):
            return value
        return FetchResult(text=value)

    def close(self):
        self.closed = True


def frozen_now(value):
    return lambda: value


def run_wait(reader, state_path, since, now, timeout_sec=5):
    return wait_for_auth_code(
        since=since,
        timeout_sec=timeout_sec,
        poll_sec=0,
        reader=reader,
        state_path=state_path,
        pattern="",
        max_age_sec=600,
        clock_skew_sec=60,
        now_func=frozen_now(now),
    )


def test_wait_for_auth_code_returns_fresh_code(tmp_path):
    code = run_wait(
        FakeReader([build_file(received_at="2026-08-01T00:15:23Z")]),
        tmp_path / "state.json",
        since=datetime(2026, 8, 1, 0, 15, 0, tzinfo=UTC),
        now=datetime(2026, 8, 1, 0, 15, 40, tzinfo=UTC),
    )
    assert code == "483920"


def test_wait_for_auth_code_works_with_raw_body_and_last_modified(tmp_path):
    """実運用の構成（メール本文のみ + last-modified）で成立すること。"""
    fetched = FetchResult(
        text=REAL_MAIL_BODY,
        last_modified=datetime(2026, 8, 2, 0, 33, 39, tzinfo=UTC),
        etag='"{709AEC46},4"',
    )
    code = run_wait(
        FakeReader([fetched]),
        tmp_path / "state.json",
        since=datetime(2026, 8, 2, 0, 33, 10, tzinfo=UTC),
        now=datetime(2026, 8, 2, 0, 33, 50, tzinfo=UTC),
    )
    assert code == "654321"


def test_wait_for_auth_code_ignores_stale_raw_body_then_accepts_updated_one(tmp_path):
    """ログイン前に置かれていた本文を掴まず、ファイルが更新されてから取得すること。"""
    stale = FetchResult(
        text=REAL_MAIL_BODY.replace("654321", "111111"),
        last_modified=datetime(2026, 8, 2, 0, 20, 0, tzinfo=UTC),
        etag='"{709AEC46},3"',
    )
    fresh = FetchResult(
        text=REAL_MAIL_BODY.replace("654321", "222222"),
        last_modified=datetime(2026, 8, 2, 0, 33, 39, tzinfo=UTC),
        etag='"{709AEC46},4"',
    )
    reader = FakeReader([stale, stale, fresh])
    code = run_wait(
        reader,
        tmp_path / "state.json",
        since=datetime(2026, 8, 2, 0, 33, 10, tzinfo=UTC),
        now=datetime(2026, 8, 2, 0, 33, 50, tzinfo=UTC),
    )
    assert code == "222222"
    assert reader.calls == 3


def test_wait_for_auth_code_rejects_expired_code(tmp_path):
    with pytest.raises(AuthCodeTimeout) as excinfo:
        run_wait(
            FakeReader([build_file(received_at="2026-08-01T00:15:23Z")]),
            tmp_path / "state.json",
            since=datetime(2026, 8, 1, 0, 15, 0, tzinfo=UTC),
            now=datetime(2026, 8, 1, 2, 15, 40, tzinfo=UTC),
            timeout_sec=0,
        )
    assert "有効期限切れ" in str(excinfo.value)


def test_wait_for_auth_code_rejects_already_consumed_message(tmp_path):
    state_path = tmp_path / "state.json"
    state_path.write_text(json.dumps({"message_id": "AAMkAD-001"}), encoding="utf-8")

    with pytest.raises(AuthCodeTimeout) as excinfo:
        run_wait(
            FakeReader([build_file(message_id="AAMkAD-001")]),
            state_path,
            since=datetime(2026, 8, 1, 0, 15, 0, tzinfo=UTC),
            now=datetime(2026, 8, 1, 0, 15, 40, tzinfo=UTC),
            timeout_sec=0,
        )
    assert "使用済み" in str(excinfo.value)


def test_wait_for_auth_code_rejects_already_consumed_etag(tmp_path):
    """メール本文だけの構成では ETag が二重消費の判定に使われること。"""
    state_path = tmp_path / "state.json"
    state_path.write_text(json.dumps({"message_id": '"{709AEC46},4"'}), encoding="utf-8")
    fetched = FetchResult(
        text=REAL_MAIL_BODY,
        last_modified=datetime(2026, 8, 2, 0, 33, 39, tzinfo=UTC),
        etag='"{709AEC46},4"',
    )
    with pytest.raises(AuthCodeTimeout) as excinfo:
        run_wait(
            FakeReader([fetched]),
            state_path,
            since=datetime(2026, 8, 2, 0, 33, 10, tzinfo=UTC),
            now=datetime(2026, 8, 2, 0, 33, 50, tzinfo=UTC),
            timeout_sec=0,
        )
    assert "使用済み" in str(excinfo.value)


def test_wait_for_auth_code_records_consumed_identity(tmp_path):
    state_path = tmp_path / "state.json"
    fetched = FetchResult(
        text=REAL_MAIL_BODY,
        last_modified=datetime(2026, 8, 2, 0, 33, 39, tzinfo=UTC),
        etag='"{709AEC46},4"',
    )
    run_wait(
        FakeReader([fetched]),
        state_path,
        since=datetime(2026, 8, 2, 0, 33, 10, tzinfo=UTC),
        now=datetime(2026, 8, 2, 0, 33, 50, tzinfo=UTC),
    )
    assert json.loads(state_path.read_text(encoding="utf-8"))["message_id"] == '"{709AEC46},4"'


def test_wait_for_auth_code_allows_clock_skew(tmp_path):
    """受信時刻がログイン送信より僅かに前でも、許容幅の範囲なら受理すること。"""
    code = run_wait(
        FakeReader([build_file(received_at="2026-08-01T00:15:23Z")]),
        tmp_path / "state.json",
        since=datetime(2026, 8, 1, 0, 15, 30, tzinfo=UTC),
        now=datetime(2026, 8, 1, 0, 15, 40, tzinfo=UTC),
    )
    assert code == "483920"


def test_wait_for_auth_code_reports_sharepoint_page(tmp_path):
    """解錠に失敗して画面が返ったとき、原因の分かるメッセージにすること。"""
    page = FetchResult(text="<!DOCTYPE html><html><body>Sign in to SharePoint</body></html>")
    with pytest.raises(AuthCodeTimeout) as excinfo:
        run_wait(
            FakeReader([page]),
            tmp_path / "state.json",
            since=datetime(2026, 8, 1, 0, 15, 0, tzinfo=UTC),
            now=datetime(2026, 8, 1, 0, 15, 40, tzinfo=UTC),
            timeout_sec=0,
        )
    assert "共有リンクのパスワード" in str(excinfo.value)


def test_wait_for_auth_code_times_out_when_reader_keeps_failing(tmp_path):
    with pytest.raises(AuthCodeTimeout) as excinfo:
        run_wait(
            FakeReader([AuthCodeError("共有リンクに到達できません")]),
            tmp_path / "state.json",
            since=datetime(2026, 8, 1, 0, 15, 0, tzinfo=UTC),
            now=datetime(2026, 8, 1, 0, 15, 40, tzinfo=UTC),
            timeout_sec=0,
        )
    assert "共有リンクに到達できません" in str(excinfo.value)


def test_wait_for_auth_code_requires_aware_since(tmp_path):
    with pytest.raises(ValueError):
        wait_for_auth_code(
            since=datetime(2026, 8, 1, 0, 15, 0),
            reader=FakeReader([build_file()]),
            state_path=tmp_path / "state.json",
        )


def test_wait_for_auth_code_closes_only_readers_it_owns(tmp_path):
    """呼び出し側が渡したリーダーは勝手に閉じないこと（ポーリング再利用のため）。"""
    reader = FakeReader([build_file()])
    run_wait(
        reader,
        tmp_path / "state.json",
        since=datetime(2026, 8, 1, 0, 15, 0, tzinfo=UTC),
        now=datetime(2026, 8, 1, 0, 15, 40, tzinfo=UTC),
    )
    assert reader.closed is False
