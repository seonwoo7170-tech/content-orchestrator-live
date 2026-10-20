# 지식iN 블로그 유입 어시스턴트

내 블로그 글과 관련된 **네이버 지식iN 질문을 찾아**, Claude로 **질문에 먼저 제대로 답하는 답변 초안**을 만들고,
블로그 글이 정말 도움이 될 때만 본인 글임을 밝힌 링크(UTM 포함)를 붙여 **검토 대기열**에 쌓습니다.

등록은 사람이 직접 합니다. 자동 로그인·자동 답변 등록·다계정 운영은 의도적으로 넣지 않았습니다.
지식iN 운영정책은 자동 등록과 홍보성 답변을 제재 대상(답변 삭제, 이용 제한)으로 두고 있고,
제재를 받으면 계정과 블로그 신뢰도까지 떨어져 유입이 오히려 줄어듭니다. 실제로 채택되는 답변이 오래 유입을 만듭니다.

## 흐름

1. `sync-posts` — 블로그 RSS(네이버 블로그/티스토리/블로거)와 `config.json`의 수동 목록에서 글과 키워드를 모읍니다.
2. `scan` — 공식 **네이버 검색 API(지식iN)** 로 키워드별 최신 질문을 찾고, 가장 잘 맞는 내 글과 연결합니다. 이미 본 질문은 건너뜁니다.
3. `draft` — 점수 높은 질문부터 Claude가 답변 초안을 쓰고 관련도(1~5)를 매깁니다. 관련 없거나 답할 가치가 없는 질문은 `rejected`.
4. `data/review-queue.html` — 질문 링크, 초안(편집 가능), 복사 버튼. 원문을 열어 확인 → 다듬기 → 직접 등록.
5. `mark <id> posted` — 등록 기록. `stats`로 현황 확인, 블로그 분석에서 `utm_source=naver_kin` 유입을 확인합니다.

## 설치

```bash
cd tools/kin-assistant
pip install -r requirements.txt
cp config.example.json config.json   # 블로그 피드, 페르소나, 키워드 수정
export NAVER_CLIENT_ID=...           # https://developers.naver.com → 애플리케이션 등록 → 검색 API
export NAVER_CLIENT_SECRET=...
export ANTHROPIC_API_KEY=...
```

## 사용

```bash
python kin_assistant.py sync-posts
python kin_assistant.py scan
python kin_assistant.py draft --limit 5
open data/review-queue.html          # 검토 후 지식iN에 직접 등록
python kin_assistant.py mark 12 posted
python kin_assistant.py mark 13 skipped
python kin_assistant.py stats
```

매일 `sync-posts → scan → draft`를 cron 등으로 돌려두면 아침마다 검토 대기열만 확인하면 됩니다.

## 설정 (`config.json`)

| 키 | 설명 |
|---|---|
| `feeds` | 블로그 RSS 주소 목록. 네이버 `https://rss.blog.naver.com/<id>.xml`, 블로거 `https://<blog>/feeds/posts/default?alt=rss` |
| `posts` | RSS 대신/추가로 직접 등록할 글과 `keywords` |
| `persona` | 답변자 소개 (전문성, 경험). 사실만 적으세요 |
| `scan.queries` | 검색어. 비우면 글의 태그/키워드 전체 사용 |
| `scan.sort` | `date`(최신) / `sim`(정확도) / `point`(평점) |
| `scan.min_score` | 질문–글 키워드 매칭 최소 점수 |
| `scan.exclude_words` | 이 단어가 포함된 질문 제외 |
| `min_relevance` | 이 관련도 미만 초안은 대기열에서 제외 |
| `utm` | 링크에 붙일 UTM 파라미터 (`{}`이면 붙이지 않음) |

## 운영 팁

- 하루 몇 개만, 전문 분야 질문에만 답하세요. 같은 링크를 반복해서 붙이면 홍보 답변으로 신고되기 쉽습니다.
- 검색 API는 질문 요약만 주므로 **반드시 원문을 열어** 세부 상황에 맞게 초안을 고치세요.
- 링크 없는 좋은 답변도 프로필(블로그 연결)과 채택 이력을 통해 유입을 만듭니다.
