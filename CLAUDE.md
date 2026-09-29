# alio-mcp 개발 안내

공공기관 **내규**(ALIO 내부규정)를 검색·비교하고, 「공공기관의 혁신에 관한 지침」 최신성을 확인하며, 개정안을 한글(HWPX) 문서로 쓰는 MCP 서버다. 기능은 내규 업무에 한정한다 — 내규와 무관한 범용 도구(문서 변환·법령 검색 등)는 그 분야 MCP 에 맡긴다.

## 구조

| 파일 | 역할 |
|---|---|
| `src/main.js` | 실행 진입점 — 모듈을 불러오기 전에 stdout 보호 후 서버 시작 |
| `src/server.js` | 도구·프롬프트 등록(`createServer`), 공통 래퍼(취소·오류 안내·응답 상한·기준 지침 표시), 직접 실행 시에만 stdio 시작 |
| `src/alio-client.js` | ALIO 비공식 JSON API(기관·검색·상세·첨부), 재시도·시간 제한·취소, 동시 조회(`mapLimit`) |
| `src/rule-text.js` | 첨부 → 본문 추출(kordoc) → 조문·부칙·별표 분할, 디스크 캐시(`CACHE_VERSION`) |
| `src/guideline.js` | 혁신 지침 개정본 목록·조문 비교·확인 기록 |
| `src/catalog.js` | 전체 규정 목록(355곳·약 3만 6천 건) — 기관별로 나눠 받고 이어받기, 7일마다 갱신 |
| `src/thesaurus.js` · `src/related.js` | 내규 분야 사전(강한·약한·제외 낱말) · 비슷한 규정 찾기(제목 후보 → 조문 구성 비교) |
| `src/hwpx.js` | 마크다운 → 보고서 양식 HWPX + 서식 기준 |
| `src/context.js` · `src/fsutil.js` · `src/paths.js` | 요청 취소 맥락 · 안전한 파일 쓰기 · 저장/캐시 위치 |

## 명령

```bash
npm test            # 오프라인 테스트(네트워크 없이, 수 초)
npm run test:live   # ALIO 사이트 구조 점검
npm run bench       # 실제 내규 106건 조문 분할 회귀 벤치(약 1분, 원문은 bench/.cache 에 보관)
npm run bench:related  # 비슷한 규정 찾기 품질(경영혁신 정답지·유연근무, 처음엔 목록 받느라 수 분)
npm run check       # 출시 전 검사(버전·CHANGELOG·패키지 파일·manifest)
npm run bundle      # dist/alio-mcp-<버전>.mcpb
npm run smoke       # 번들을 풀어 빈 홈 폴더에서 실행(--live 로 ALIO 실호출까지)
node test/e2e-smoke.mjs   # 소스 그대로 모든 도구 실호출
```

## 바꿀 때 지킬 것

- **분할 규칙(rule-text.js)이나 kordoc 을 바꾸면 `npm run bench` 를 돌린다.** 달라진 규정은 원문을 보고 개선인지 확인한 뒤에만 `node bench/run.mjs --accept` 로 기준을 바꾼다. 결과가 바뀌면 `CACHE_VERSION` 을 올린다. (kordoc 4.16 에서 PDF 목차 형식이 바뀌어 조문 79개가 17개로 줄던 퇴행을 이 벤치가 잡았다.)
- **분야 사전(thesaurus.js)이나 찾기 점수를 바꾸면 `npm run bench:related` 를 돌린다.** 낱말은 실제 공시 규정 제목 빈도를 보고 고르고, 오분류는 제외 낱말이나 약한 낱말로 돌린다(예: '혁신위원회'는 환자경험혁신위원회에도 쓰여 약한 낱말).
- **도구를 더하거나 이름을 바꾸면** manifest.json `tools` 와 README 도구 표도 같이 고친다(테스트가 셋을 대조한다).
- **버전은 package.json 한 곳.** `npm version patch|minor` 가 manifest·CHANGELOG 를 맞추고 커밋·태그를 만든다. `git push --follow-tags` 하면 Release 워크플로가 검사 후 번들을 게시한다. 바뀐 점은 먼저 CHANGELOG `[Unreleased]` 에 적는다.
- **결과를 추측하게 두지 않는다.** 실패·시간 초과·조회 실패 기관은 숨기지 말고 결과에 적고, "결과를 추측하지 마세요" 안내를 유지한다.
- **ALIO 에 예의:** 동시 4곳·요청 간 60ms·요청당 15초 제한·도구당 40초 예산. 클라이언트 취소는 `src/context.js` 로 네트워크까지 전해진다.
- **원문 재배포 금지:** 규정 원문·추출 텍스트·스냅샷은 커밋하지 않는다. 벤치 기준(`bench/corpus.json`)에는 식별자·파일번호·조문 번호/제목만 둔다.
- **stdout 은 MCP 통신 전용.** 로그는 `console.error`. 직접 실행 시 console 출력은 stderr 로 돌린다.
- **파일 쓰기는 `src/fsutil.js` 로.** 저장 자리의 링크를 따라가지 않는다.
- **HWPX 줄 나눔 값은 이름과 반대:** 한글 어절 = `breakNonLatinWord="BREAK_WORD"`, 글자 = `KEEP_WORD`(한글 저장본 기준).
- 선택 의존성(OCR 등 수백 MB)은 쓰지 않는다. PDF 추출용 `pdfjs-dist` 는 직접 의존성으로 고정해 둔다.
