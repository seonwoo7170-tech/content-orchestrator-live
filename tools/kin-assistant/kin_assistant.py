#!/usr/bin/env python3
"""네이버 지식iN → 블로그 유입 어시스턴트.

내 블로그 글과 관련된 지식iN 질문을 공식 네이버 검색 API로 찾고,
Claude로 "질문에 먼저 제대로 답하는" 답변 초안을 만들어 검토 대기열에 쌓는다.
답변 등록은 사람이 직접 한다 (자동 로그인/자동 등록은 하지 않음).

Usage:
  python kin_assistant.py sync-posts
  python kin_assistant.py scan
  python kin_assistant.py draft --limit 5
  python kin_assistant.py report
  python kin_assistant.py mark <id> posted|skipped
  python kin_assistant.py stats
"""
import argparse
import html
import json
import os
import re
import sqlite3
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG_PATH = Path(os.environ.get("KIN_CONFIG", HERE / "config.json"))
DB_PATH = Path(os.environ.get("KIN_DB", HERE / "data" / "kin.db"))
REPORT_PATH = HERE / "data" / "review-queue.html"

KIN_API = "https://openapi.naver.com/v1/search/kin.json"
MODEL = "claude-opus-5-5"

SYSTEM_PROMPT = """너는 네이버 지식iN에서 실제로 도움이 되는 답변을 쓰는 전문가다.

원칙:
1. 답변만 읽어도 질문자의 문제가 해결되어야 한다. 링크를 눌러야만 답을 알 수 있게 쓰지 않는다.
2. 질문의 구체적인 상황(조건, 숫자, 증상)을 짚어서 답한다. 일반론 복붙 금지.
3. 블로그 글은 질문과 직접 관련 있고 답변 이상의 추가 정보(사진, 단계별 과정, 비교표 등)가 있을 때만
   마지막에 한 번, "제가 직접 정리한 글"처럼 본인 글임을 밝히고 자연스럽게 소개한다.
   관련성이 약하면 link_included=false로 두고 링크를 넣지 않는다.
4. 과장, 허위 경험담, 광고 문구, 다른 답변 비방 금지. 의료·법률·금융은 전문가 상담 권고를 덧붙인다.
5. 400~900자, 짧은 문단, 필요하면 번호 목록. 존댓말.
6. 질문이 이미 해결됐거나, 광고성/의미 없는 질문이거나, 내가 답할 자격이 없는 주제면 should_answer=false.
"""

DRAFT_SCHEMA = {
    "type": "object",
    "properties": {
        "should_answer": {"type": "boolean"},
        "reason": {"type": "string"},
        "relevance": {"type": "integer", "enum": [1, 2, 3, 4, 5]},
        "answer": {"type": "string"},
        "link_included": {"type": "boolean"},
    },
    "required": ["should_answer", "reason", "relevance", "answer", "link_included"],
    "additionalProperties": False,
}


def log(msg):
    print(msg, file=sys.stderr)


def load_config():
    if not CONFIG_PATH.exists():
        sys.exit(f"설정 파일이 없습니다: {CONFIG_PATH}\n  cp config.example.json config.json 후 수정하세요.")
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS posts (
          url TEXT PRIMARY KEY, title TEXT, summary TEXT, keywords TEXT
        );
        CREATE TABLE IF NOT EXISTS questions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          link TEXT UNIQUE, title TEXT, description TEXT,
          query TEXT, post_url TEXT, score REAL,
          status TEXT DEFAULT 'new',  -- new | drafted | posted | skipped | rejected
          draft TEXT, reason TEXT, relevance INTEGER,
          created_at TEXT, updated_at TEXT
        );
        """
    )
    return conn


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def strip_tags(s):
    return html.unescape(re.sub(r"<[^>]+>", "", s or "")).strip()


def http_get(url, headers=None):
    req = urllib.request.Request(url, headers={"User-Agent": "kin-assistant/1.0", **(headers or {})})
    with urllib.request.urlopen(req, timeout=20) as res:
        return res.read()


# ---------- 블로그 글 수집 ----------

def parse_feed(xml_bytes):
    """RSS 2.0(네이버 블로그, 티스토리, 블로거 alt=rss)과 Atom을 모두 처리."""
    root = ET.fromstring(xml_bytes)
    atom = "{http://www.w3.org/2005/Atom}"
    posts = []
    for item in root.iter("item"):
        posts.append({
            "title": strip_tags(item.findtext("title")),
            "url": (item.findtext("link") or "").strip(),
            "summary": strip_tags(item.findtext("description"))[:500],
            "tags": [c.text.strip() for c in item.findall("category") if c.text],
        })
    for entry in root.iter(f"{atom}entry"):
        link = next((l.get("href") for l in entry.findall(f"{atom}link") if l.get("rel") in (None, "alternate")), "")
        posts.append({
            "title": strip_tags(entry.findtext(f"{atom}title")),
            "url": link,
            "summary": strip_tags(entry.findtext(f"{atom}summary") or entry.findtext(f"{atom}content"))[:500],
            "tags": [c.get("term") for c in entry.findall(f"{atom}category") if c.get("term")],
        })
    return [p for p in posts if p["url"]]


def cmd_sync_posts(cfg, conn):
    posts = []
    for feed in cfg.get("feeds", []):
        log(f"피드 수집: {feed}")
        posts += parse_feed(http_get(feed))
    for p in cfg.get("posts", []):  # 수동 등록 글 (키워드 직접 지정)
        posts.append({"title": p["title"], "url": p["url"], "summary": p.get("summary", ""), "tags": p.get("keywords", [])})
    for p in posts:
        conn.execute(
            "INSERT INTO posts(url,title,summary,keywords) VALUES(?,?,?,?) "
            "ON CONFLICT(url) DO UPDATE SET title=excluded.title, summary=excluded.summary, keywords=excluded.keywords",
            (p["url"], p["title"], p["summary"], json.dumps(p["tags"], ensure_ascii=False)),
        )
    conn.commit()
    log(f"블로그 글 {len(posts)}개 동기화 완료")
    print(json.dumps({"posts": len(posts)}))


# ---------- 질문 탐색 ----------

def tokens(text):
    return {t for t in re.findall(r"[0-9A-Za-z가-힣]{2,}", text.lower())}


def post_keywords(post):
    kws = set(json.loads(post["keywords"] or "[]"))
    kws |= tokens(post["title"])
    return {k.lower() for k in kws if len(k) >= 2}


def match_score(question_text, post):
    q = question_text.lower()
    hits = [k for k in post_keywords(post) if k in q]
    return sum(len(k) for k in hits) / 10 + len(hits)


def search_kin(cfg, query, display, sort):
    params = urllib.parse.urlencode({"query": query, "display": display, "start": 1, "sort": sort})
    body = http_get(f"{KIN_API}?{params}", {
        "X-Naver-Client-Id": os.environ["NAVER_CLIENT_ID"],
        "X-Naver-Client-Secret": os.environ["NAVER_CLIENT_SECRET"],
    })
    return json.loads(body).get("items", [])


def cmd_scan(cfg, conn):
    for key in ("NAVER_CLIENT_ID", "NAVER_CLIENT_SECRET"):
        if not os.environ.get(key):
            sys.exit(f"환경변수 {key}가 필요합니다 (developers.naver.com 에서 검색 API 앱 등록).")
    posts = conn.execute("SELECT * FROM posts").fetchall()
    if not posts:
        sys.exit("등록된 블로그 글이 없습니다. 먼저 sync-posts 를 실행하세요.")
    scan = cfg.get("scan", {})
    queries = scan.get("queries") or sorted({t for p in posts for t in json.loads(p["keywords"] or "[]")})
    exclude = [w.lower() for w in scan.get("exclude_words", [])]
    min_score = scan.get("min_score", 2)
    added = 0
    for q in queries:
        try:
            items = search_kin(cfg, q, scan.get("per_query", 30), scan.get("sort", "date"))
        except Exception as e:  # noqa: BLE001 - 한 키워드 실패로 전체 중단하지 않음
            log(f"  [{q}] 검색 실패: {e}")
            continue
        for it in items:
            title, desc = strip_tags(it["title"]), strip_tags(it["description"])
            text = f"{title} {desc}"
            if any(w in text.lower() for w in exclude):
                continue
            best = max(posts, key=lambda p: match_score(text, p))
            score = match_score(text, best)
            if score < min_score:
                continue
            cur = conn.execute(
                "INSERT OR IGNORE INTO questions(link,title,description,query,post_url,score,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (it["link"], title, desc, q, best["url"], score, now(), now()),
            )
            added += cur.rowcount
        log(f"  [{q}] {len(items)}건 확인")
    conn.commit()
    log(f"새 후보 질문 {added}개 추가")
    print(json.dumps({"added": added}))


# ---------- 답변 초안 ----------

def utm(url, cfg):
    u = cfg.get("utm", {"utm_source": "naver_kin", "utm_medium": "referral", "utm_campaign": "kin_answer"})
    if not u:
        return url
    parts = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qsl(parts.query) + list(u.items())
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query)))


def draft_one(client, cfg, q, post):
    import anthropic

    link = utm(post["url"], cfg)
    persona = cfg.get("persona", "")
    user = (
        f"[답변자 소개]\n{persona}\n\n"
        f"[지식iN 질문]\n제목: {q['title']}\n내용(검색 요약, 일부만 보일 수 있음): {q['description']}\n\n"
        f"[관련 있을 수 있는 내 블로그 글]\n제목: {post['title']}\n요약: {post['summary']}\n링크: {link}\n\n"
        "위 원칙에 따라 답변 초안을 JSON으로 작성해줘. 링크를 넣는다면 위 링크를 그대로 사용해."
    )
    try:
        res = client.beta.messages.create(
            model=MODEL,
            max_tokens=16000,
            system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": user}],
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": DRAFT_SCHEMA}},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
    except anthropic.RateLimitError:
        raise
    except anthropic.APIStatusError as e:
        log(f"  API 오류 ({e.status_code}): {e.message}")
        return None
    except anthropic.APIConnectionError:
        log("  네트워크 오류")
        return None
    if res.stop_reason == "refusal":
        log("  모델이 이 질문에 대한 답변 작성을 거절했습니다 - 건너뜀")
        return {"should_answer": False, "reason": "refusal", "relevance": 1, "answer": "", "link_included": False}
    text = next(b.text for b in res.content if b.type == "text")
    return json.loads(text)


def cmd_draft(cfg, args, conn):
    import anthropic

    client = anthropic.Anthropic()
    rows = conn.execute(
        "SELECT * FROM questions WHERE status='new' ORDER BY score DESC LIMIT ?", (args.limit,)
    ).fetchall()
    min_rel = cfg.get("min_relevance", 3)
    done = 0
    for q in rows:
        post = conn.execute("SELECT * FROM posts WHERE url=?", (q["post_url"],)).fetchone()
        log(f"초안 작성: #{q['id']} {q['title'][:40]}")
        try:
            d = draft_one(client, cfg, q, post)
        except anthropic.RateLimitError:
            log("  요청 한도 초과 - 나머지는 다음 실행에서 처리합니다")
            break
        if d is None:
            continue
        ok = d["should_answer"] and d["relevance"] >= min_rel
        conn.execute(
            "UPDATE questions SET status=?, draft=?, reason=?, relevance=?, updated_at=? WHERE id=?",
            ("drafted" if ok else "rejected", d["answer"], d["reason"], d["relevance"], now(), q["id"]),
        )
        conn.commit()
        done += ok
    log(f"검토 대기 초안 {done}개 생성")
    print(json.dumps({"drafted": done}))
    write_report(conn)


# ---------- 검토 대기열 / 기록 ----------

def write_report(conn):
    rows = conn.execute("SELECT * FROM questions WHERE status='drafted' ORDER BY relevance DESC, score DESC").fetchall()
    cards = []
    for r in rows:
        draft = html.escape(r["draft"] or "")
        cards.append(f"""
<article>
  <h2>#{r['id']} <a href="{html.escape(r['link'])}" target="_blank" rel="noopener">{html.escape(r['title'])}</a></h2>
  <p class="meta">관련도 {r['relevance']}/5 · 검색어 “{html.escape(r['query'])}” · 연결 글: {html.escape(r['post_url'])}</p>
  <p class="q">{html.escape(r['description'])}</p>
  <textarea id="d{r['id']}" rows="12">{draft}</textarea>
  <div class="row">
    <button onclick="navigator.clipboard.writeText(document.getElementById('d{r['id']}').value);this.textContent='복사됨'">답변 복사</button>
    <code>python kin_assistant.py mark {r['id']} posted</code>
  </div>
</article>""")
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(f"""<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>지식iN 검토 대기열</title>
<style>
:root{{--bg:#fafafa;--fg:#1a1a1a;--card:#fff;--muted:#666;--line:#ddd}}
@media (prefers-color-scheme:dark){{:root{{--bg:#141414;--fg:#eee;--card:#1e1e1e;--muted:#999;--line:#333}}}}
body{{background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,sans-serif;max-width:860px;margin:0 auto;padding:16px}}
article{{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:16px 0}}
h2{{font-size:17px;margin:0 0 4px}} a{{color:inherit}} .meta{{color:var(--muted);font-size:13px;margin:0}}
.q{{white-space:pre-wrap}} textarea{{width:100%;box-sizing:border-box;font:inherit;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:8px}}
.row{{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:8px}} code{{font-size:12px;color:var(--muted)}}
</style></head><body>
<h1>지식iN 검토 대기열 ({len(rows)}건)</h1>
<p>질문 원문을 열어 전체 내용을 확인하고, 초안을 다듬은 뒤 직접 등록하세요. 등록 후 <code>mark &lt;id&gt; posted</code>.</p>
{''.join(cards) or '<p>대기 중인 초안이 없습니다.</p>'}
</body></html>""", encoding="utf-8")
    log(f"검토 대기열: {REPORT_PATH}")


def cmd_mark(args, conn):
    if args.status not in ("posted", "skipped", "new"):
        sys.exit("status 는 posted | skipped | new 중 하나")
    cur = conn.execute("UPDATE questions SET status=?, updated_at=? WHERE id=?", (args.status, now(), args.id))
    conn.commit()
    if not cur.rowcount:
        sys.exit(f"#{args.id} 질문이 없습니다")
    write_report(conn)
    print(json.dumps({"id": args.id, "status": args.status}))


def cmd_stats(conn):
    by_status = dict(conn.execute("SELECT status, COUNT(*) FROM questions GROUP BY status").fetchall())
    today = datetime.now(timezone.utc).date().isoformat()
    posted_today = conn.execute(
        "SELECT COUNT(*) FROM questions WHERE status='posted' AND substr(updated_at,1,10)=?", (today,)
    ).fetchone()[0]
    by_post = conn.execute(
        "SELECT post_url, COUNT(*) n FROM questions WHERE status='posted' GROUP BY post_url ORDER BY n DESC"
    ).fetchall()
    print(json.dumps({
        "by_status": by_status,
        "posted_today": posted_today,
        "posted_by_blog_post": {r["post_url"]: r["n"] for r in by_post},
    }, ensure_ascii=False, indent=2))


def main():
    ap = argparse.ArgumentParser(description="네이버 지식iN → 블로그 유입 어시스턴트")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("sync-posts", help="블로그 RSS/수동 목록에서 글 수집")
    sub.add_parser("scan", help="지식iN에서 관련 질문 탐색")
    d = sub.add_parser("draft", help="답변 초안 생성")
    d.add_argument("--limit", type=int, default=5)
    sub.add_parser("report", help="검토 대기열 HTML 재생성")
    m = sub.add_parser("mark", help="질문 상태 변경")
    m.add_argument("id", type=int)
    m.add_argument("status")
    sub.add_parser("stats", help="진행 현황")
    args = ap.parse_args()

    conn = db()
    if args.cmd == "mark":
        return cmd_mark(args, conn)
    if args.cmd == "stats":
        return cmd_stats(conn)
    if args.cmd == "report":
        return write_report(conn)
    cfg = load_config()
    if args.cmd == "sync-posts":
        cmd_sync_posts(cfg, conn)
    elif args.cmd == "scan":
        cmd_scan(cfg, conn)
    elif args.cmd == "draft":
        cmd_draft(cfg, args, conn)


if __name__ == "__main__":
    main()
