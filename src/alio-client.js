// ALIO (공공기관 경영정보 공개시스템) 내부규정 클라이언트
// 브라우저 리버스 엔지니어링으로 확정한 비공식 내부 JSON API 사용.
// reportFormRootNo=21110 == "내부규정" 보고서
import fs from "node:fs/promises";
import path from "node:path";

const BASE = "https://www.alio.go.kr";
const REPORT_FORM = "21110"; // 내부규정

// 일부 정부 사이트는 UA/Referer 없는 요청을 거부하므로 기본 주입
const COMMON_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Referer: `${BASE}/item/itemOrganList.do?reportFormRootNo=${REPORT_FORM}`,
  Origin: BASE,
};

export const RULE_CATEGORIES = {
  K1100: "인사·복무·징계",
  K1200: "보수",
  K1300: "직제",
  K1400: "기타",
  K1500: "정관",
};

// 호출 시점에 읽으므로 테스트나 환경변수로 조정 가능
export const settings = {
  delayMs: Number(process.env.ALIO_DELAY_MS) || 60,
  retries: 3,
  retryBaseMs: 500,
  maxPages: 100,
  // 기관 355곳을 순차 조회하면 약 82초 → MCP 클라이언트 기본 대기 60초를 넘는다. 동시 조회 수로 단축.
  concurrency: Number(process.env.ALIO_CONCURRENCY) || 4,
  requestTimeoutMs: 15000,
  orgsCacheMs: 6 * 60 * 60 * 1000,
  searchCacheMs: 10 * 60 * 1000,
  // 상세 페이지(첨부 목록)는 ALIO 서버에서 건당 약 1.5초 걸린다. 수정일이 같으면 저장한 목록을 쓰되 이 기간이 지나면 다시 확인.
  fileListCacheMs: 7 * 24 * 60 * 60 * 1000,
};

// 동시에 limit 개까지 실행. 결과는 입력 순서대로. deadline 이 지나면 새 작업을 시작하지 않고 skipped 로 남긴다.
export async function mapLimit(items, limit, fn, { deadline } = {}) {
  const results = new Array(items.length);
  const skipped = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      if (deadline && Date.now() >= deadline) {
        skipped.push(i);
        continue;
      }
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return { results, skipped: skipped.sort((a, b) => a - b) };
}

// kind: HTTP(재시도 불가 상태코드) | NETWORK(재시도 후에도 실패) | SCHEMA(응답 구조가 예상과 다름 → 사이트 개편 의심)
export class AlioError extends Error {
  constructor(kind, message, { status } = {}) {
    super(message);
    this.name = "AlioError";
    this.kind = kind;
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRetryable = (status) => status === 429 || status >= 500;

// 응답 본문까지 읽어서 돌려준다. 멈춘 연결은 requestTimeoutMs 에 끊고, 본문 읽기 실패도 재시도한다.
async function request(url, init = {}, as = "text") {
  let last;
  for (let attempt = 0; attempt <= settings.retries; attempt++) {
    if (attempt > 0) await sleep(settings.retryBaseMs * 2 ** (attempt - 1));
    try {
      const res = await fetch(BASE + url, {
        ...init,
        headers: { ...COMMON_HEADERS, ...init.headers },
        signal: AbortSignal.timeout(settings.requestTimeoutMs),
      });
      if (!res.ok) {
        last = new AlioError(isRetryable(res.status) ? "NETWORK" : "HTTP", `${url} → HTTP ${res.status}`, {
          status: res.status,
        });
        if (!isRetryable(res.status)) break;
        continue;
      }
      const body = as === "buffer" ? Buffer.from(await res.arrayBuffer()) : await res.text();
      return { res, body };
    } catch (e) {
      const why = e.name === "TimeoutError" ? `${settings.requestTimeoutMs / 1000}초 동안 응답 없음` : e.message;
      last = new AlioError("NETWORK", `${url} 연결 실패: ${why}`);
    }
  }
  throw last;
}

export async function getJson(url) {
  const { body: raw } = await request(url);
  try {
    return JSON.parse(raw);
  } catch {
    throw new AlioError("SCHEMA", `${url} 응답이 JSON이 아님 (차단 페이지 또는 사이트 개편 의심)`);
  }
}

// ALIO 첨부 파일 받기 (내부규정 외 게시판 첨부용)
export async function getFile(url) {
  const { res, body } = await request(url, {}, "buffer");
  const ct = res.headers.get("content-type") || "";
  if (/text\/html|application\/json/i.test(ct))
    throw new AlioError("SCHEMA", `${url} 가 파일 대신 ${ct} 를 반환 (오류/차단 페이지 의심)`);
  return body;
}

async function postJson(url, body) {
  const { body: raw } = await request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    return JSON.parse(raw);
  } catch {
    throw new AlioError("SCHEMA", `${url} 응답이 JSON이 아님 (차단 페이지 또는 사이트 개편 의심)`);
  }
}

// 서버 프로세스 안에서만 유지되는 캐시. 기관 목록은 거의 바뀌지 않고, 검색은 같은 조건이 반복되기 쉽다.
const cache = { orgs: null, orgsAt: 0, search: new Map() };
export function clearCaches() {
  cache.orgs = null;
  cache.orgsAt = 0;
  cache.search.clear();
}

// ① 전체 기관 목록 (355곳)
export async function listOrgs() {
  if (cache.orgs && Date.now() - cache.orgsAt < settings.orgsCacheMs) return cache.orgs;
  const j = await postJson("/item/itemOrganListSusi.json", {
    apbaType: [],
    jidtDptm: [],
    area: [],
    apbaId: "",
    reportFormRootNo: REPORT_FORM,
  });
  const arr = j?.data?.organList;
  if (!Array.isArray(arr) || arr.length === 0)
    throw new AlioError("SCHEMA", "기관 목록(data.organList)이 비어 있거나 없음 — 사이트 개편 의심");
  cache.orgs = arr.map((o) => ({
    apbaId: o.apbaId,
    name: o.apbaNa,
    type: o.typeNa,
    dept: o.jidtNa,
    apbaType: o.apbaType,
  }));
  cache.orgsAt = Date.now();
  return cache.orgs;
}

// ② 특정 기관의 규정 검색 — ALIO는 한 페이지에 10건만 주므로 totalPage까지 모두 순회
export async function searchRules(org, { keyword = "", category = "" } = {}) {
  const ck = `${org.apbaId}|${keyword}|${category}`;
  const hit = cache.search.get(ck);
  if (hit && Date.now() - hit.at < settings.searchCacheMs) return hit.rules;
  const rules = await fetchRules(org, { keyword, category });
  cache.search.set(ck, { at: Date.now(), rules });
  return rules;
}

async function fetchRules(org, { keyword, category }) {
  const rows = [];
  let totalPage = 1;
  let totalCount;
  for (let page = 1; page <= totalPage; page++) {
    if (page > 1) await sleep(settings.delayMs);
    const j = await postJson("/item/itemReportListSusi.json", {
      pageNo: page,
      apbaId: org.apbaId,
      apbaType: org.apbaType,
      reportFormRootNo: REPORT_FORM,
      search_word: keyword,
      search_flag: "title",
      bid_type: category,
      enfc_istt: "",
    });
    const result = j?.data?.result;
    const meta = j?.data?.page;
    if (!Array.isArray(result) || !meta)
      throw new AlioError("SCHEMA", `${org.name} 검색 응답에 data.result/data.page 없음 — 사이트 개편 의심`);
    if (page === 1) {
      totalPage = Math.min(Number(meta.totalPage) || 1, settings.maxPages);
      totalCount = Number(meta.totalCount);
    }
    rows.push(...result);
  }
  if (Number.isFinite(totalCount) && rows.length < totalCount && totalPage < settings.maxPages)
    throw new AlioError("SCHEMA", `${org.name} 검색 결과 ${totalCount}건 중 ${rows.length}건만 수신`);

  return rows.map((r) => ({
    org: org.name,
    apbaId: org.apbaId,
    type: org.type,
    dept: org.dept,
    apbaType: org.apbaType,
    title: (r.title || "").trim(),
    category: r.bidType,
    categoryName: RULE_CATEGORIES[r.bidType] || r.bidType,
    enfDate: r.stDate, // 시행(제·개정)일
    modDate: r.idate, // 최종 수정일
    idx: r.idx,
    submissionNo: r.submissionNo,
    tableName: r.tableName, // COMM_RULE
    idxName: r.idxName, // RULE_NO
  }));
}

// 규정명 비교용: 날짜·개정 표기 괄호와 앞머리 분류번호만 뗀다. "(계약직)" 같은 내용 괄호는 남긴다.
export function baseTitle(title) {
  return (title || "")
    .replace(/[(（[]\s*(?:제정|개정|시행|전부개정|일부개정)?\s*[`'’]?[\d.\s년월일~-]{4,}\s*(?:제정|개정|시행)?\s*[)）\]]/g, "")
    .replace(/^\s*(?:[가-힣]{1,2}-)?[\d]+(?:[-.]\d+)*\.?\s+/, "")
    .replace(/\s+/g, "");
}

// 같은 기관에 같은 이름의 규정이 여러 건이면(옛 버전을 별도 등록한 경우) 시행일이 가장 늦은 것만 최신으로 본다.
export function markSuperseded(rules) {
  const latest = new Map();
  for (const r of rules) {
    const k = `${r.apbaId}|${baseTitle(r.title)}`;
    const cur = latest.get(k);
    if (!cur || r.enfDate > cur.enfDate || (r.enfDate === cur.enfDate && Number(r.idx) > Number(cur.idx))) latest.set(k, r);
  }
  return rules.map((r) => {
    const top = latest.get(`${r.apbaId}|${baseTitle(r.title)}`);
    return top === r ? { ...r, superseded: false } : { ...r, superseded: true, latestIdx: top.idx, latestEnfDate: top.enfDate };
  });
}

// 여러 기관을 동시에 settings.concurrency 곳씩 조회. 실패한 기관은 failed, 시간 예산(deadline) 안에
// 조회하지 못한 기관은 timedOut 으로 돌려준다 — 어느 쪽도 조용히 빠뜨리지 않는다.
export async function searchOrgs(orgs, { keyword = "", category = "", onProgress, deadline } = {}) {
  const failed = [];
  let done = 0;
  let found = 0;
  const { results, skipped } = await mapLimit(
    orgs,
    settings.concurrency,
    async (org) => {
      let rules = [];
      try {
        rules = await searchRules(org, { keyword, category });
      } catch (e) {
        failed.push({ org: org.name, apbaId: org.apbaId, kind: e.kind || "UNKNOWN", error: e.message });
      }
      done++;
      found += rules.length;
      onProgress?.(done, orgs.length, found);
      await sleep(settings.delayMs);
      return rules;
    },
    { deadline }
  );
  const hits = results.filter(Boolean).flat();
  const timedOut = skipped.map((i) => ({ org: orgs[i].name, apbaId: orgs[i].apbaId, kind: "TIMEOUT", error: "시간 제한으로 조회하지 못함" }));
  const order = new Map(orgs.map((o, i) => [o.apbaId, i]));
  failed.sort((a, b) => order.get(a.apbaId) - order.get(b.apbaId));
  return { searched: orgs.length - timedOut.length, hits: markSuperseded(hits), failed, timedOut };
}

export async function sweepKeyword(keyword, opts = {}) {
  return searchOrgs(await listOrgs(), { ...opts, keyword });
}

const decodeEntities = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

// 상세 페이지 HTML에서 첨부파일 추출. 번호와 파일명이 같은 태그 안에 있을 때만 짝짓는다.
export function parseRuleFiles(html) {
  const files = [];
  const seen = new Set();
  const add = (fileNo, name) => {
    if (seen.has(fileNo)) return;
    seen.add(fileNo);
    files.push({ fileNo, fileName: decodeEntities(name.trim()) });
  };
  for (const m of html.matchAll(/<a\b[^>]*href="[^"]*rulefiledown\.json\?fileNo=(\d+)"[^>]*>([^<]*)<\/a>/gi))
    add(m[1], m[2]);
  for (const m of html.matchAll(/previewAjax\(\s*'(\d+)'\s*,\s*'([^']*)'/g)) add(m[1], m[2]);

  if (files.length === 0 && /fileNo=\d+|downRuleFile\(/.test(html))
    throw new AlioError("SCHEMA", "상세 페이지에 첨부파일 흔적은 있으나 파일 목록을 해석하지 못함 — 사이트 개편 의심");
  return files;
}

// ③ 규정 상세 페이지의 첨부파일 목록 (제·개정 이력 포함)
export async function getRuleFiles(rule) {
  const qs = new URLSearchParams({
    disclosureNo: "null",
    apbaId: rule.apbaId,
    nowcode: REPORT_FORM,
    reportFormNo: REPORT_FORM,
    table_name: rule.tableName || "COMM_RULE",
    idx_name: rule.idxName || "RULE_NO",
    idx: rule.idx,
    reportGbn: "N",
    bid_type: rule.category || "",
  });
  const { body: html } = await request(`/item/itemBoard${REPORT_FORM}.do?${qs}`);
  return parseRuleFiles(html);
}

// ④ 규정 파일 받기
export async function fetchRuleFile(fileNo) {
  const { res, body } = await request(`/download/rulefiledown.json?fileNo=${fileNo}`, {}, "buffer");
  const ct = res.headers.get("content-type") || "";
  if (/text\/html|application\/json/i.test(ct))
    throw new AlioError("SCHEMA", `fileNo=${fileNo} 가 파일 대신 ${ct} 를 반환 (오류/차단 페이지 의심)`);
  return { buf: body, contentType: ct };
}

export async function downloadRuleFile(fileNo, destPath) {
  const { buf, contentType: ct } = await fetchRuleFile(fileNo);
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, buf);
  return { path: destPath, bytes: buf.length, contentType: ct };
}

// 현행본 = 가장 나중에 등록된 파일(fileNo 최댓값).
// 파일명의 연도는 "22년 10월 개정"처럼 표기가 제각각이라 기준으로 쓰지 않는다.
export function pickLatestFile(files) {
  if (!files.length) return null;
  return files.reduce((a, b) => (Number(b.fileNo) > Number(a.fileNo) ? b : a));
}

export async function fetchRuleDocument(rule, outDir) {
  const files = await getRuleFiles(rule);
  if (!files.length) return { rule, files: [], saved: null };
  const pick = pickLatestFile(files);
  const base = rule.org && rule.title ? `${rule.org}_${rule.title}` : `${rule.apbaId}_${rule.idx}`;
  const safe = base.replace(/[^\w가-힣.-]+/g, "_").slice(0, 80);
  const ext = (pick.fileName.match(/\.\w+$/) || [".bin"])[0];
  const saved = await downloadRuleFile(pick.fileNo, path.join(outDir, safe + ext));
  return { rule, files, saved: { ...saved, fileName: pick.fileName, fileNo: pick.fileNo } };
}

export { REPORT_FORM };
