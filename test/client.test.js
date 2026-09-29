// 오프라인 테스트: test/fixtures 의 실제 ALIO 응답으로 fetch 를 대체한다.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  settings,
  listOrgs,
  searchRules,
  searchOrgs,
  parseRuleFiles,
  getRuleFiles,
  pickLatestFile,
  downloadRuleFile,
  AlioError,
  clearCaches,
  mapLimit,
} from "../src/alio-client.js";
import { normalizeSnapshot, diffSnapshots } from "../src/diff.js";
import { runWithSignal } from "../src/context.js";

const fx = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const orgsJson = await fs.readFile(path.join(fx, "orgs.json"), "utf8");
const pages = JSON.parse(await fs.readFile(path.join(fx, "search_C0105_all.json"), "utf8"));
const detailHtml = await fs.readFile(path.join(fx, "detail_C0105_21892.html"), "utf8");

const json = (o, status = 200) =>
  new Response(typeof o === "string" ? o : JSON.stringify(o), {
    status,
    headers: { "content-type": "application/json" },
  });
const emptySearch = { data: { result: [], page: { totalPage: 0, totalCount: 0 } } };

// 실제 사이트처럼 응답하는 기본 라우터
function fixtureFetch(url, init = {}) {
  const u = String(url);
  const body = init.body ? JSON.parse(init.body) : {};
  if (u.endsWith("/item/itemOrganListSusi.json")) return json(orgsJson);
  if (u.endsWith("/item/itemReportListSusi.json"))
    return json(body.apbaId === "C0105" ? pages[body.pageNo] : emptySearch);
  if (u.includes("/item/itemBoard21110.do"))
    return new Response(detailHtml, { headers: { "content-type": "text/html" } });
  if (u.includes("/download/rulefiledown.json"))
    return new Response(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), {
      headers: { "content-type": "application/haansofthwp" },
    });
  return new Response("not found", { status: 404 });
}

const realFetch = globalThis.fetch;
let calls;
const useFetch = (fn) => {
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    return fn(url, init);
  };
};

beforeEach(() => {
  calls = [];
  settings.delayMs = 0;
  settings.retryBaseMs = 0;
  settings.retries = 3;
  settings.requestTimeoutMs = 15000;
  settings.concurrency = 4;
  clearCaches();
  useFetch(fixtureFetch);
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const incheon = async () => (await listOrgs()).find((o) => o.apbaId === "C0105");

test("기관 목록 355곳을 읽는다", async () => {
  const orgs = await listOrgs();
  assert.equal(orgs.length, 355);
  assert.ok(orgs.every((o) => o.apbaId && o.name && o.apbaType));
});

test("페이지네이션: 인천국제공항공사 91건을 10페이지 모두 읽는다 (예전 코드는 10건만)", async () => {
  const rules = await searchRules(await incheon());
  assert.equal(rules.length, pages[1].data.page.totalCount);
  assert.equal(rules.length, 91);
  assert.equal(new Set(rules.map((r) => r.idx)).size, 91);
});

test("수신 건수가 totalCount 보다 적으면 조용히 넘어가지 않고 오류", async () => {
  useFetch((url, init) => {
    const b = JSON.parse(init.body);
    if (String(url).endsWith("itemReportListSusi.json") && b.pageNo === 3)
      return json({ data: { result: [], page: pages[3].data.page } });
    return fixtureFetch(url, init);
  });
  await assert.rejects(searchRules({ apbaId: "C0105", apbaType: "A2001", name: "인천" }), (e) => e.kind === "SCHEMA");
});

test("일시 오류(503)는 재시도해서 성공한다", async () => {
  let n = 0;
  useFetch((url, init) => (++n <= 2 ? new Response("busy", { status: 503 }) : fixtureFetch(url, init)));
  const orgs = await listOrgs();
  assert.equal(orgs.length, 355);
  assert.equal(n, 3);
});

test("재시도 불가 오류(404)는 즉시 실패한다", async () => {
  let n = 0;
  useFetch(() => (n++, new Response("nope", { status: 404 })));
  await assert.rejects(listOrgs(), (e) => e instanceof AlioError && e.kind === "HTTP" && e.status === 404);
  assert.equal(n, 1);
});

test("재시도를 다 써도 실패하면 NETWORK 오류", async () => {
  useFetch(() => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(listOrgs(), (e) => e.kind === "NETWORK");
  assert.equal(calls.length, settings.retries + 1);
});

test("JSON 대신 HTML 이 오면 SCHEMA 오류 (차단·개편 감지)", async () => {
  useFetch(() => new Response("<html>점검중</html>", { headers: { "content-type": "text/html" } }));
  await assert.rejects(listOrgs(), (e) => e.kind === "SCHEMA");
});

test("여러 기관 검색: 실패한 기관을 삼키지 않고 failed 로 보고", async () => {
  const orgs = await listOrgs();
  const targets = [orgs.find((o) => o.apbaId === "C0105"), orgs.find((o) => o.apbaId === "C0247")];
  useFetch((url, init) => {
    if (String(url).endsWith("itemReportListSusi.json") && JSON.parse(init.body).apbaId === "C0247")
      return new Response("err", { status: 500 });
    return fixtureFetch(url, init);
  });
  const r = await searchOrgs(targets, { keyword: "" });
  assert.equal(r.hits.length, 91);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].apbaId, "C0247");
  assert.equal(r.failed[0].kind, "NETWORK");
});

test("첨부파일: 번호와 파일명이 정확히 짝지어진다", async () => {
  const files = await getRuleFiles({ apbaId: "C0105", idx: "21892", category: "K1100" });
  assert.equal(files.length, 7);
  const byNo = Object.fromEntries(files.map((f) => [f.fileNo, f.fileName]));
  assert.equal(byNo["159064"], "인사규정(22년 10월 개정).hwp");
  assert.equal(byNo["218027"], "인사규정(2025년도 6월 개정).hwp");
  assert.equal(byNo["166414"], "인사규정(2023년 1월 개정).hwpx");
});

test("첨부파일 흔적은 있는데 해석이 안 되면 SCHEMA 오류 (추측으로 짝짓지 않음)", () => {
  assert.throws(() => parseRuleFiles(`<span onclick="downRuleFile(123)">x.pdf</span>`), (e) => e.kind === "SCHEMA");
});

test("첨부파일이 아예 없으면 빈 목록", () => {
  assert.deepEqual(parseRuleFiles("<html><body>첨부 없음</body></html>"), []);
});

test("파일명의 HTML 엔티티를 복원한다", () => {
  const f = parseRuleFiles(`<a href="/download/rulefiledown.json?fileNo=1">R&amp;D규정.pdf</a>`);
  assert.equal(f[0].fileName, "R&D규정.pdf");
});

test("현행본: 실제 첨부 7개 중 2025년 6월 개정본", () => {
  assert.equal(pickLatestFile(parseRuleFiles(detailHtml)).fileNo, "218027");
});

test("현행본: 두 자리 연도(26년)로 올라온 최신 파일도 놓치지 않는다 (예전 코드는 2025년본 선택)", () => {
  const files = [
    ...parseRuleFiles(detailHtml),
    { fileNo: "230001", fileName: "인사규정(26년 3월 개정).hwp" },
  ];
  assert.equal(pickLatestFile(files).fileNo, "230001");
});

test("다운로드: 파일 대신 HTML 이 오면 저장하지 않고 오류", async () => {
  useFetch(() => new Response("<html>오류</html>", { headers: { "content-type": "text/html;charset=utf-8" } }));
  const dest = path.join(os.tmpdir(), `alio-test-${process.pid}.hwp`);
  await assert.rejects(downloadRuleFile("1", dest), (e) => e.kind === "SCHEMA");
  await assert.rejects(fs.access(dest));
});

test("다운로드: 정상 파일은 저장된다", async () => {
  const dest = path.join(os.tmpdir(), `alio-test-ok-${process.pid}.hwp`);
  const r = await downloadRuleFile("218027", dest);
  assert.equal(r.bytes, 4);
  await fs.rm(dest);
});

const rule = (apbaId, title, enfDate, idx = title) => ({ apbaId, org: apbaId, title, enfDate, idx });

test("스냅샷 비교: 명칭만 바뀐 규정은 폐지+신설이 아니라 개정으로 본다 (idx 기준)", () => {
  const prev = normalizeSnapshot({ hits: [rule("A", "AX혁신 위원회 운영지침", "2026.01.22", "53785")], failed: [] });
  const curr = normalizeSnapshot({ hits: [rule("A", "AX혁신위원회 운영지침", "2026.07.16", "53785")], failed: [] });
  const d = diffSnapshots(prev, curr);
  assert.equal(d.added.length, 0);
  assert.equal(d.removed.length, 0);
  assert.equal(d.revised[0].prevTitle, "AX혁신 위원회 운영지침");
});

test("구버전 스냅샷: 10건 꽉 찬 기관만 잘렸을 수 있다고 표시", () => {
  const ten = Array.from({ length: 10 }, (_, i) => rule("A", `규정${i}`, "1"));
  const s = normalizeSnapshot([...ten, rule("B", "나규정", "1")]);
  assert.deepEqual(s.truncatedOrgs, ["A"]);
});

test("스냅샷 비교: 신설·개정·폐지를 구분한다", () => {
  const prev = normalizeSnapshot({ hits: [rule("A", "가규정", "2025.01.01"), rule("A", "나규정", "2025.01.01")], failed: [] });
  const curr = normalizeSnapshot({ hits: [rule("A", "가규정", "2026.03.01"), rule("A", "다규정", "2026.03.01")], failed: [] });
  const d = diffSnapshots(prev, curr);
  assert.deepEqual(d.added.map((r) => r.title), ["다규정"]);
  assert.deepEqual(d.removed.map((r) => r.title), ["나규정"]);
  assert.deepEqual(d.revised.map((r) => [r.title, r.prevEnfDate]), [["가규정", "2025.01.01"]]);
});

test("스냅샷 비교: 이번에 조회 실패한 기관의 규정을 '폐지'로 오판하지 않는다", () => {
  const prev = normalizeSnapshot({ hits: [rule("A", "가규정", "1"), rule("B", "나규정", "1")], failed: [] });
  const curr = normalizeSnapshot({ hits: [rule("A", "가규정", "1")], failed: [{ apbaId: "B" }] });
  const d = diffSnapshots(prev, curr);
  assert.equal(d.removed.length, 0);
  assert.deepEqual(d.unsureOrgs, ["B"]);
});

test("스냅샷 비교: 직전에 조회 실패했던 기관의 규정을 '신설'로 오판하지 않는다", () => {
  const prev = normalizeSnapshot({ hits: [], failed: [{ apbaId: "B" }] });
  const curr = normalizeSnapshot({ hits: [rule("B", "나규정", "1")], failed: [] });
  assert.equal(diffSnapshots(prev, curr).added.length, 0);
});

test("구버전(배열) 스냅샷도 읽는다", () => {
  const s = normalizeSnapshot([rule("A", "가규정", "1")]);
  assert.equal(s.version, 1);
  assert.equal(s.hits.length, 1);
  assert.deepEqual(s.failed, []);
});

// ---- 시간 초과 대책: 병렬 조회·시간 예산·캐시·요청별 시간 제한 ----
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("동시 조회: 한 번에 limit 개까지만 돌고, 결과는 입력 순서대로", async () => {
  let running = 0;
  let peak = 0;
  const { results, skipped } = await mapLimit([30, 5, 20, 1, 10, 2], 3, async (ms, i) => {
    peak = Math.max(peak, ++running);
    await wait(ms);
    running--;
    return i;
  });
  assert.equal(peak, 3);
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(skipped, []);
});

test("실사례: 355곳 전 기관 조회가 순차(약 82초)가 아니라 동시 조회로 끝난다", async () => {
  useFetch(async (url, init) => {
    await wait(20);
    return fixtureFetch(url, init);
  });
  const orgs = await listOrgs();
  const t = Date.now();
  const r = await searchOrgs(orgs, { keyword: "" });
  const elapsed = Date.now() - t;
  assert.equal(r.searched, 355);
  assert.equal(r.timedOut.length, 0);
  assert.equal(r.hits.length, 91 + 0);
  assert.ok(elapsed < (355 * 20) / 2, `${elapsed}ms — 순차 처리보다 충분히 빠르지 않음`);
});

test("시간 예산: 제한 시간이 지나면 남은 기관을 timedOut 으로 명시하고 부분 결과를 돌려준다", async () => {
  settings.concurrency = 2;
  useFetch(async (url, init) => {
    await wait(30);
    return fixtureFetch(url, init);
  });
  const orgs = (await listOrgs()).slice(0, 20);
  const r = await searchOrgs(orgs, { keyword: "", deadline: Date.now() + 100 });
  assert.ok(r.timedOut.length > 0, "시간 초과 기관이 없음");
  assert.ok(r.searched > 0, "조회한 기관이 없음");
  assert.equal(r.searched + r.timedOut.length, 20);
  assert.ok(r.timedOut.every((x) => x.kind === "TIMEOUT" && x.org));
});

test("캐시: 기관 목록과 같은 조건의 검색은 다시 요청하지 않는다", async () => {
  await listOrgs();
  await listOrgs();
  assert.equal(calls.filter((u) => u.endsWith("itemOrganListSusi.json")).length, 1);
  const org = (await listOrgs()).find((o) => o.apbaId === "C0105");
  await searchRules(org, { keyword: "" });
  const n = calls.length;
  await searchRules(org, { keyword: "" });
  assert.equal(calls.length, n);
  await searchRules(org, { keyword: "인사" });
  assert.ok(calls.length > n, "다른 검색어인데 캐시를 썼음");
});

// 응답 없이 멈춘 연결. AbortSignal.timeout 의 타이머는 실행 루프를 붙잡지 않아(Node 20·22), 실제 연결처럼
// 끊길 때까지 루프를 붙잡아 두지 않으면 테스트 러너가 "끝날 일이 없다"며 테스트를 취소한다.
const hangingFetch = (url, init) =>
  new Promise((_, reject) => {
    const hold = setInterval(() => {}, 1000);
    init.signal.addEventListener("abort", () => {
      clearInterval(hold);
      reject(init.signal.reason);
    });
  });

test("요청별 시간 제한: 응답 없이 멈춘 요청을 끊고 NETWORK 오류로 알린다", async () => {
  settings.requestTimeoutMs = 50;
  settings.retries = 1;
  useFetch(hangingFetch);
  await assert.rejects(listOrgs(), (e) => e.kind === "NETWORK" && /응답 없음/.test(e.message));
  assert.equal(calls.length, 2);
});

test("응답 본문을 읽다 끊겨도 재시도한다", async () => {
  let n = 0;
  useFetch((url, init) => {
    if (++n === 1)
      return new Response(new ReadableStream({ start(c) { c.error(new TypeError("terminated")); } }), { status: 200 });
    return fixtureFetch(url, init);
  });
  assert.equal((await listOrgs()).length, 355);
  assert.equal(n, 2);
});

test("취소된 요청: mapLimit 은 새 작업을 시작하지 않고 CANCELLED 로 끝낸다", async () => {
  let ran = 0;
  await assert.rejects(
    runWithSignal(AbortSignal.abort(), () => mapLimit([1, 2, 3], 2, async () => ran++)),
    (e) => e instanceof AlioError && e.kind === "CANCELLED"
  );
  assert.equal(ran, 0);
});

test("취소된 요청: 네트워크를 부르지 않고 CANCELLED 로 끝낸다", async () => {
  await assert.rejects(runWithSignal(AbortSignal.abort(), () => listOrgs()), (e) => e.kind === "CANCELLED");
  assert.equal(calls.length, 0);
});

test("응답을 기다리는 중 취소되면 연결 실패(NETWORK)가 아니라 CANCELLED", async () => {
  settings.retries = 0; // 마지막 시도에서 취소된 경우
  const ac = new AbortController();
  useFetch(hangingFetch);
  const p = runWithSignal(ac.signal, () => listOrgs());
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, (e) => e.kind === "CANCELLED");
  assert.equal(calls.length, 1);
});
