// 전체 규정 목록 — 오프라인 테스트: 나눠 받기·이어받기·오래된 기관만 갱신
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { settings, clearCaches } from "../src/alio-client.js";
import { loadCatalog, catalogSettings, coverageNote } from "../src/catalog.js";

const fx = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const orgsJson = await fs.readFile(path.join(fx, "orgs.json"), "utf8");
const pages = JSON.parse(await fs.readFile(path.join(fx, "search_C0105_all.json"), "utf8"));
const json = (o) => new Response(typeof o === "string" ? o : JSON.stringify(o), { headers: { "content-type": "application/json" } });
const empty = { data: { result: [], page: { totalPage: 0, totalCount: 0 } } };

let searched;
let delay = 0;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.endsWith("/item/itemOrganListSusi.json")) return json(orgsJson);
  if (u.endsWith("/item/itemReportListSusi.json")) {
    const body = JSON.parse(init.body);
    if (body.pageNo === 1 || body.pageNo === "1") searched.push(body.apbaId);
    if (delay) await new Promise((r) => setTimeout(r, delay));
    return json(body.apbaId === "C0105" ? pages[body.pageNo] : empty);
  }
  return new Response("not found", { status: 404 });
};

let dir;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "alio-catalog-"));
  searched = [];
  delay = 0;
  settings.delayMs = 0;
  settings.retryBaseMs = 0;
  settings.concurrency = 4;
  clearCaches();
});

test("전 기관 목록을 받아 저장하고, 새로 부르면 저장본을 쓴다", async () => {
  const c = await loadCatalog({ cacheDir: dir });
  assert.equal(c.orgCount, 355);
  assert.equal(c.covered, 355);
  assert.deepEqual(c.failed, []);
  assert.equal(c.rules.length, 91); // 인천국제공항공사 91건, 나머지 기관은 0건
  assert.ok(c.rules.every((r) => r.org && r.title && r.idx && r.categoryName));
  assert.equal(searched.length, 355);

  searched = [];
  clearCaches();
  const again = await loadCatalog({ cacheDir: dir });
  assert.equal(again.rules.length, 91);
  assert.equal(searched.length, 0, "저장본이 있는데 다시 받음");
});

test("시간 예산을 넘기면 받은 만큼 저장하고, 다음 호출에서 나머지만 이어 받는다", async () => {
  delay = 30;
  const first = await loadCatalog({ cacheDir: dir, deadline: Date.now() + 400 });
  assert.ok(first.covered > 0 && first.covered < 355, `받은 기관 ${first.covered}`);
  assert.equal(first.missing.length, 355 - first.covered);
  assert.match(coverageNote(first), /다시 실행하면 이어서 받습니다/);

  const firstBatch = new Set(searched);
  searched = [];
  clearCaches();
  delay = 0;
  const second = await loadCatalog({ cacheDir: dir });
  assert.equal(second.covered, 355);
  assert.deepEqual([...first.failed, ...second.failed], []);
  assert.ok(searched.every((id) => !firstBatch.has(id)), "이미 받은 기관을 다시 받음");
  assert.doesNotMatch(coverageNote(second), /이어서/);
});

test("기관 자료가 오래되면(기본 7일) 그 기관만 다시 받는다", async () => {
  await loadCatalog({ cacheDir: dir });
  const file = path.join(dir, "catalog.json");
  const cat = JSON.parse(await fs.readFile(file, "utf8"));
  cat.orgs.C0105.fetchedAt = Date.now() - catalogSettings.maxAgeMs - 1000;
  await fs.writeFile(file, JSON.stringify(cat));
  searched = [];
  clearCaches();
  await loadCatalog({ cacheDir: dir });
  assert.deepEqual(searched, ["C0105"]);
});

test("조회에 실패한 기관은 목록에서 조용히 빠지지 않고 실패로 알린다", async () => {
  settings.retries = 0;
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/item/itemReportListSusi.json") && JSON.parse(init.body).apbaId === "C0105") return new Response("err", { status: 500 });
    return real(url, init);
  };
  try {
    const c = await loadCatalog({ cacheDir: dir });
    assert.equal(c.failed.length, 1);
    assert.equal(c.failed[0].apbaId, "C0105");
    assert.equal(c.covered, 354);
    assert.match(coverageNote(c), /조회 실패 1곳/);
  } finally {
    globalThis.fetch = real;
    settings.retries = 3;
  }
});
