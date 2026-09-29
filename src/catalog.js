// 전체 규정 목록(카탈로그): ALIO 에 공시된 공공기관 내규의 제목·분류·시행일(355곳, 약 3만 6천 건).
// 비슷한 규정 찾기와 범위 본문 검색의 출발점이다. 전부 받는 데 약 3분 걸려(동시 4곳) 도구 한 번의 시간 예산을 넘는다.
// 그래서 기관마다 받은 시각을 적어 두고 오래된 기관만 다시 받으며, 다 받지 못하면 받은 만큼 저장하고 다음 호출에서 잇는다.
import fs from "node:fs/promises";
import path from "node:path";
import { listOrgs, searchRules, markSuperseded, mapLimit, settings } from "./alio-client.js";
import { CACHE_DIR } from "./paths.js";

export const catalogSettings = { maxAgeMs: 7 * 24 * 60 * 60 * 1000 };
const FILE_VERSION = 1;
const filePath = (cacheDir) => path.join(cacheDir, "catalog.json");

// { version, orgs: { [apbaId]: { name, fetchedAt, rules: [...] } } }
async function read(cacheDir) {
  try {
    const c = JSON.parse(await fs.readFile(filePath(cacheDir), "utf8"));
    if (c.version === FILE_VERSION && c.orgs) return c;
  } catch {}
  return { version: FILE_VERSION, orgs: {} };
}

async function write(cacheDir, cat) {
  await fs.mkdir(cacheDir, { recursive: true });
  const tmp = `${filePath(cacheDir)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cat));
  await fs.rename(tmp, filePath(cacheDir));
}

const slim = (r) => ({
  apbaId: r.apbaId,
  org: r.org,
  type: r.type,
  dept: r.dept,
  idx: String(r.idx),
  title: r.title,
  category: r.category,
  categoryName: r.categoryName,
  enfDate: r.enfDate,
  modDate: r.modDate,
  tableName: r.tableName,
  idxName: r.idxName,
});

// 같은 서버 안에서 목록 받기가 겹치지 않게(백그라운드 갱신과 도구 호출) 하나로 묶는다
let running = null;

// 오래되었거나 없는 기관을 deadline 까지 받아 채운다.
// orgFilter: 이 기관들만(기관 유형·부처로 좁혀 찾을 때 그 기관 목록만 받는다)
export async function loadCatalog({ deadline, onProgress, concurrency = settings.concurrency, cacheDir = CACHE_DIR, orgFilter } = {}) {
  if (running) await running.catch(() => {});
  const job = fill({ deadline, onProgress, concurrency, cacheDir, orgFilter });
  running = job;
  try {
    return await job;
  } finally {
    if (running === job) running = null;
  }
}

async function fill({ deadline, onProgress, concurrency, cacheDir, orgFilter }) {
  const cat = await read(cacheDir);
  const orgs = (await listOrgs()).filter((o) => !orgFilter || orgFilter(o));
  const now = Date.now();
  const stale = orgs.filter((o) => !cat.orgs[o.apbaId] || now - cat.orgs[o.apbaId].fetchedAt > catalogSettings.maxAgeMs);
  // 한 번도 받지 않은 기관을 먼저
  stale.sort((a, b) => (cat.orgs[a.apbaId]?.fetchedAt || 0) - (cat.orgs[b.apbaId]?.fetchedAt || 0));
  const failed = [];
  let done = 0;
  let dirty = 0;
  // 저장은 한 줄로 세운다(동시에 쓰면 임시 파일이 엇갈림). 중간 저장이 실패해도 마지막 저장이 전체를 다시 쓴다.
  let saving = Promise.resolve();
  const flush = () =>
    (saving = saving.then(async () => {
      if (!dirty) return;
      dirty = 0;
      await write(cacheDir, cat);
    }));
  let skipped;
  try {
    ({ skipped } = await mapLimit(
      stale,
      concurrency,
      async (o) => {
        let rules;
        try {
          rules = await searchRules(o, { keyword: "" });
        } catch (e) {
          if (e.kind === "CANCELLED") throw e;
          failed.push({ org: o.name, apbaId: o.apbaId, kind: e.kind || "UNKNOWN", error: e.message });
        }
        if (rules) {
          cat.orgs[o.apbaId] = { name: o.name, fetchedAt: Date.now(), rules: rules.map(slim) };
          if (++dirty >= 20) flush().catch(() => {});
        }
        onProgress?.(++done, stale.length);
      },
      { deadline }
    ));
  } finally {
    dirty = dirty || 1;
    await flush();
  }

  const known = new Set(orgs.map((o) => o.apbaId));
  const entries = Object.entries(cat.orgs).filter(([id]) => known.has(id));
  const rules = markSuperseded(entries.flatMap(([, e]) => e.rules.map((r) => ({ ...r }))));
  const missing = orgs.filter((o) => !cat.orgs[o.apbaId]);
  const oldest = entries.length ? Math.min(...entries.map(([, e]) => e.fetchedAt)) : null;
  return {
    rules,
    orgCount: orgs.length,
    covered: orgs.length - missing.length,
    missing: missing.map((o) => o.name),
    stalePending: skipped.length,
    failed,
    oldest: oldest ? new Date(oldest).toISOString().slice(0, 10) : null,
  };
}

// 결과 머리에 붙일 안내: 목록이 전 기관을 덮는지, 이어 받을 것이 있는지
export function coverageNote(c) {
  const head = `전체 규정 목록: ${c.covered}/${c.orgCount}곳 · 규정 ${c.rules.length.toLocaleString()}건${c.oldest ? ` (가장 오래된 기관 자료 ${c.oldest})` : ""}`;
  const more = c.missing.length
    ? `\n⏱️ 아직 목록을 받지 못한 기관 ${c.missing.length}곳 — 같은 요청을 다시 실행하면 이어서 받습니다. 그 전까지 결과는 받은 기관만 기준입니다. 결과를 추측하지 마세요.`
    : "";
  const fail = c.failed.length
    ? `\n⚠️ 목록 조회 실패 ${c.failed.length}곳(결과에서 빠짐): ${c.failed.slice(0, 8).map((f) => f.org).join(", ")}${c.failed.length > 8 ? " 등" : ""}`
    : "";
  return head + more + fail;
}

// 서버가 켜질 때: 오래된 기관 목록을 뒤에서 천천히(동시 2곳) 갱신한다. 실패해도 도구 동작에는 영향 없음.
export function refreshInBackground({ cacheDir = CACHE_DIR } = {}) {
  return loadCatalog({ deadline: Date.now() + 15 * 60 * 1000, concurrency: 2, cacheDir }).then(
    (c) => console.error(`[alio-mcp] 규정 목록 갱신: ${c.covered}/${c.orgCount}곳, ${c.rules.length}건`),
    (e) => console.error(`[alio-mcp] 규정 목록 갱신 실패: ${e.message}`)
  );
}
