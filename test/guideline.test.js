// 정부 지침 최신성 확인·버전 비교 (실제 ALIO 목록 응답으로 오프라인 검증)
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { markdownToHwpx } from "kordoc";
import { settings, clearCaches } from "../src/alio-client.js";
import { splitArticles } from "../src/rule-text.js";
import {
  revisionDate,
  parseVersionList,
  listGuidelineVersions,
  versionAt,
  loadGuidelineVersion,
  diffUnits,
  markSeen,
  guidelineHeader,
  clearGuidelineMemo,
  guidelineSettings,
  seriesKey,
  groupSeries,
  findSeries,
  listGuidelineSeries,
  watchedGuidelines,
  readSeen,
} from "../src/guideline.js";

const fx = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const listPages = JSON.parse(await fs.readFile(path.join(fx, "guideline_list.json"), "utf8"));
// 게시판 전체(80건, 8쪽) — 혁신 지침 13건 포함
const boardPages = JSON.parse(await fs.readFile(path.join(fx, "guideline_board.json"), "utf8"));
const boardRows = Object.values(boardPages).flatMap((p) => p.data.result);

const V_OLD = `공공기관의 혁신에 관한 지침

제9조(기관별 경영혁신전략․계획의 수립) ①공공기관은 경영혁신전략․계획을 수립하여야 한다.

제11조(혁신포털의 설치․운영) ①기획재정부장관은 공공기관 혁신포털을 설치․운영한다.

제42조(휴가․휴직 제도) 3. 장기근속자에 대한 안식휴가는 운영할 수 없다.

부 칙 <2022.11.3.>

이 지침은 의결한 날부터 시행한다.`;
const V_NEW = `공공기관의 혁신에 관한 지침

제9조(기관별 경영혁신전략․계획의 수립) ①공공기관은 경영혁신전략․계획을 수립하여야 한다.

제11조(혁신포털의 설치․운영) ①재정경제부장관은 공공기관 혁신포털을 설치․운영한다.

제11조의2(혁신 성과 공유) 공공기관은 혁신 성과를 공유한다.

제42조(휴가․휴직 제도) 3. <삭제> <개정 2025.7.30.>

부 칙 <2022.11.3.>

이 지침은 의결한 날부터 시행한다.

부 칙 <2026.7.31.>

이 지침은 의결한 날부터 시행한다.`;

test("개정일 파싱: 실제 게시 제목 표기들", () => {
  assert.equal(revisionDate("공공기관의 혁신에 관한 지침(2026.7.31. 개정)"), "2026-07-31");
  assert.equal(revisionDate("공공기관의 혁신에 관한 지침(2025.12.23, 12.30. 개정)"), "2025-12-30");
  assert.equal(revisionDate("공공기관의 혁신에 관한 지침('20.9.24 개정)"), "2020-09-24");
  assert.equal(revisionDate("공공기관의 혁신에 관한 지침(2021.7.29. 개정) 수정"), "2021-07-29");
  assert.equal(revisionDate("공공기관의 혁신에 관한 지침"), null);
});

test("실사례: 게시 순서와 개정 순서가 달라도('20.9.24 개정본이 늦게 게시) 개정일순으로 정렬", () => {
  const rows = Object.values(listPages).flatMap((p) => p.data.result);
  const vs = parseVersionList(rows);
  assert.equal(vs.length, 13);
  assert.equal(vs[0].revDate, "2026-07-31");
  const i1224 = vs.findIndex((v) => v.revDate === "2020-12-29");
  const i0924 = vs.findIndex((v) => v.revDate === "2020-09-24");
  assert.ok(i1224 < i0924);
  assert.ok(vs.every((v, i) => i === 0 || vs[i - 1].revDate >= v.revDate));
});

test("다른 지침(지방·기타공공기관)은 섞지 않는다", () => {
  const vs = parseVersionList([
    { boardNo: 1, rtitle: "지방공공기관의 혁신에 관한 지침(2025.1.1. 개정)", idate: "2025.01.02" },
    { boardNo: 2, rtitle: "기타공공기관의 혁신에 관한 지침(2007.12.26. 개정)", idate: "2008.01.02" },
    { boardNo: 3, rtitle: "공공기관의 혁신에 관한 지침(2024.6.5. 개정)", idate: "2024.06.21" },
  ]);
  assert.deepEqual(vs.map((v) => v.boardNo), ["3"]);
});

test("기준일에 시행 중이던 개정본: 세칙 시행일 2023.2.15 → 2022.11.3 개정본", () => {
  const vs = parseVersionList(Object.values(listPages).flatMap((p) => p.data.result));
  assert.equal(versionAt(vs, "2023.02.15").revDate, "2022-11-03");
  assert.equal(versionAt(vs, "2026-07-31").revDate, "2026-07-31");
  assert.equal(versionAt(vs, "2010.01.01"), null);
});

test("조문 비교: 추가·삭제·실질 변경과 '부처명만 변경'을 구분", () => {
  const d = diffUnits(splitArticles(V_OLD), splitArticles(V_NEW));
  assert.deepEqual(d.added.map((u) => u.no), ["제11조의2", "부칙(2026.7.31)"]);
  assert.deepEqual(d.removed, []);
  const byNo = Object.fromEntries(d.changed.map((c) => [c.unit.no, c]));
  assert.equal(byNo["제11조"].renameOnly, true);
  assert.equal(byNo["제42조"].renameOnly, false);
  assert.match(byNo["제42조"].removed.join(), /안식휴가는 운영할 수 없다/);
  assert.match(byNo["제42조"].added.join(), /<삭제>/);
  assert.equal(d.same, 2);
});

// ---- ALIO 호출(목록·상세·첨부)을 대체해 최신성 표시 동작 검증 ----
const realFetch = globalThis.fetch;
let cacheDir;
let listFail;
let detailCalls;
const hwpxOld = Buffer.from(await markdownToHwpx(V_OLD));
const hwpxNew = Buffer.from(await markdownToHwpx(V_NEW));
const json = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });

beforeEach(async () => {
  settings.retries = 0;
  settings.retryBaseMs = 0;
  clearCaches();
  clearGuidelineMemo();
  listFail = false;
  detailCalls = 0;
  cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "alio-guide-"));
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === "/etc/findEtcLawList.json") {
      if (listFail) return new Response("down", { status: 503 });
      return json(boardPages[u.searchParams.get("pageNo")]);
    }
    if (u.pathname === "/etc/findEtcLawDtl.json") {
      detailCalls++;
      const b = u.searchParams.get("boardNo");
      return json({ data: { fileList: [{ fileNm: `지침(${b}).hwpx`, fileNo: b }] } });
    }
    if (u.pathname === "/download/download.json")
      return new Response(u.searchParams.get("fileNo") === "3562152" ? hwpxNew : hwpxOld, {
        headers: { "content-type": "application/octet-stream" },
      });
    return new Response("x", { status: 404 });
  };
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  settings.retries = 3;
  await fs.rm(cacheDir, { recursive: true, force: true });
});

test("최신성 표시: 확인 기록이 없으면 경고", async () => {
  const h = await guidelineHeader({ cacheDir });
  assert.match(h, /📌 기준 지침: 공공기관의 혁신에 관한 지침\(2026\.7\.31\. 개정\)/);
  assert.match(h, /아직 확인한 기록이 없습니다/);
});

test("최신성 표시: 지난 확인 이후 새 개정이 올라오면 경고, 최신을 확인했으면 경고 없음", async () => {
  const vs = await listGuidelineVersions();
  await markSeen(vs.find((v) => v.revDate === "2025-12-30"), cacheDir);
  assert.match(await guidelineHeader({ cacheDir }), /지난 확인\(2025-12-30 개정본\) 이후 새 개정이 게시되었습니다/);
  await markSeen(vs[0], cacheDir);
  const h = await guidelineHeader({ cacheDir });
  assert.doesNotMatch(h, /⚠️/);
  assert.match(h, /📌 기준 지침/);
});

test("최신성 표시: 확인에 실패하면 숨기지 않고 알린다", async () => {
  listFail = true;
  assert.match(await guidelineHeader({ cacheDir }), /최신성 확인 실패/);
});

test("최신성 표시: 응답이 늦으면 제한 시간 안에 실패로 알리고 도구를 붙잡지 않는다", async () => {
  const keep = guidelineSettings.headerTimeoutMs;
  guidelineSettings.headerTimeoutMs = 50;
  globalThis.fetch = () => new Promise(() => {});
  try {
    const t = Date.now();
    assert.match(await guidelineHeader({ cacheDir }), /최신성 확인 실패\(0\.05초 안에 응답 없음\)/);
    assert.ok(Date.now() - t < 1000);
  } finally {
    guidelineSettings.headerTimeoutMs = keep;
  }
});

test("지침 본문: 첨부를 받아 조문으로 나누고, 한 번 받은 개정본은 다시 받지 않는다", async () => {
  const vs = await listGuidelineVersions();
  const a = await loadGuidelineVersion(vs[0], { cacheDir });
  assert.ok(a.units.some((u) => u.no === "제11조의2"));
  await loadGuidelineVersion(vs[0], { cacheDir });
  assert.equal(detailCalls, 1);
  const b = await loadGuidelineVersion(versionAt(vs, "2023.02.15"), { cacheDir });
  const d = diffUnits(b.units, a.units);
  assert.deepEqual(d.added.map((u) => u.no), ["제11조의2", "부칙(2026.7.31)"]);
});

// ---- 분야별 지침: 게시판 전체를 계열로 묶기 ----
test("계열 묶기: 표기가 달라도 같은 지침, 해마다 새 이름으로 올라오는 지침은 하나로", () => {
  assert.equal(seriesKey("공기업·준정부기관의 경영에 관한 지침(2023.4.27. 개정)"), seriesKey("공기업 준정부기관의 경영에 관한 지침"));
  assert.equal(seriesKey("2026년도 공기업·준정부기관 예산운용지침"), seriesKey("2025년도 공기업 준정부기관 예산운용지침 개정안"));
  assert.notEqual(seriesKey("지방공공기관의 혁신에 관한 지침"), seriesKey("공공기관의 혁신에 관한 지침"));
  const series = groupSeries(boardRows);
  const innov = findSeries(series, "혁신에 관한 지침");
  assert.equal(innov.length, 1);
  assert.equal(innov[0].versions.length, 13);
  assert.equal(innov[0].versions[0].revDate, "2026-07-31");
  const mgmt = findSeries(series, "경영에 관한 지침")[0];
  assert.ok(mgmt.versions.length >= 15, `경영 지침 ${mgmt.versions.length}건`);
  const budget = findSeries(series, "예산운용지침")[0];
  assert.match(budget.versions[0].title, /2026년도/);
  assert.equal(findSeries(series, "임원 보수").length, 1);
  assert.ok(series.length < 37, "표기 차이·연도별 지침이 묶이지 않음");
});

test("계열 목록: 게시판 전체를 받아 최근 개정 순으로", async () => {
  const series = await listGuidelineSeries();
  assert.ok(series.length >= 20);
  assert.ok(series.every((s, i) => i === 0 || series[i - 1].versions[0].revDate >= s.versions[0].revDate));
  const vs = await listGuidelineVersions({ title: "임원 보수지침" });
  assert.match(vs[0].title, /임원 보수지침/);
});

test("감시 지침: 설정으로 여러 개, 각각 최신성 표시와 확인 기록", async () => {
  const keep = process.env.ALIO_WATCH_GUIDELINES;
  try {
    process.env.ALIO_WATCH_GUIDELINES = "${user_config.watch_guidelines}";
    assert.deepEqual(watchedGuidelines(), ["공공기관의 혁신에 관한 지침"], "치환되지 않은 설정은 기본값");
    process.env.ALIO_WATCH_GUIDELINES = "임원 보수지침, 안전관리에 관한 지침";
    assert.deepEqual(watchedGuidelines(), ["임원 보수지침", "안전관리에 관한 지침"]);
    const h = await guidelineHeader({ cacheDir });
    assert.match(h, /📌 기준 지침: 공기업·준정부기관 임원 보수지침/);
    assert.match(h, /📌 기준 지침: 공공기관의 안전관리에 관한 지침/);
    const pay = await listGuidelineVersions({ title: "임원 보수지침" });
    await markSeen(pay[0], cacheDir);
    assert.equal((await readSeen(cacheDir, pay[0].series)).boardNo, pay[0].boardNo);
    assert.equal(await readSeen(cacheDir), null, "다른 지침(혁신) 확인 기록과 섞임");
  } finally {
    if (keep === undefined) delete process.env.ALIO_WATCH_GUIDELINES;
    else process.env.ALIO_WATCH_GUIDELINES = keep;
  }
});

test("확인 기록: 예전 형식(혁신 지침 하나)도 읽는다", async () => {
  await fs.writeFile(path.join(cacheDir, "guideline_state.json"), JSON.stringify({ boardNo: "3562152", revDate: "2026-07-31", title: "x", seenAt: "2026-09-29" }));
  assert.equal((await readSeen(cacheDir)).boardNo, "3562152");
  assert.doesNotMatch(await guidelineHeader({ cacheDir, titles: ["공공기관의 혁신에 관한 지침"] }), /⚠️/);
});
