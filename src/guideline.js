// 정부 지침 최신성 확인·버전 비교. 출처: ALIO '공공기관 법령/지침' 게시판(재정경제부 게시, 공식).
// 게시판의 모든 지침(혁신·임원 보수·안전관리·경영·예산운용·통합공시·계약·회계·감사 등)을 '계열'로 묶어 다룬다.
// 같은 지침이 표기만 달리 올라오거나(공기업·준정부기관 / 공기업 준정부기관) 해마다 새 이름(2026년도 …예산운용지침)으로 올라오므로.
// 「공공기관의 혁신에 관한 지침」은 한국공공기관연구원 자료실보다 여기 버전이 더 많다(13 vs 9).
import fs from "node:fs/promises";
import path from "node:path";
import { AlioError, getJson, getFile } from "./alio-client.js";
import { DEFAULT_CACHE_DIR, CACHE_VERSION, extractDocument, splitArticles } from "./rule-text.js";

export const GUIDELINE_TITLE = "공공기관의 혁신에 관한 지침";
export const guidelineSettings = { listCacheMs: 6 * 60 * 60 * 1000, headerTimeoutMs: 5000 };

// "(2026.7.31. 개정)", "(2025.12.23, 12.30. 개정)", "('20.9.24 개정)" → 가장 늦은 개정일 "YYYY-MM-DD"
export function revisionDate(title) {
  const inner = (title.match(/\(([^)]*개정[^)]*)\)/) || [])[1];
  if (!inner) return null;
  let year = null;
  const dates = [];
  for (const part of inner.split(",")) {
    const m = part.match(/(?:(\d{4})|[`'’‘](\d{2}))?\s*\.?\s*(\d{1,2})\s*\.\s*(\d{1,2})/);
    if (!m) continue;
    if (m[1]) year = Number(m[1]);
    else if (m[2]) year = 2000 + Number(m[2]);
    if (!year) continue;
    dates.push(`${year}-${String(m[3]).padStart(2, "0")}-${String(m[4]).padStart(2, "0")}`);
  }
  return dates.sort().pop() || null;
}

const toIso = (d) => {
  const m = String(d || "").match(/(\d{4})\D*(\d{1,2})\D*(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null;
};

// 제목 꾸밈 떼기: 날짜·개정·시행이 든 괄호(어디에 있든), '개정안…', '_부칙수정'·'수정' 꼬리, 앞 연도
const stripDecor = (title) =>
  String(title || "")
    .replace(/\s*[\(（][^)）]*(\d|개정|시행|제정|수정)[^)）]*[\)）]/g, "")
    .replace(/\s*개정안.*$/, "")
    .replace(/[_\s]*(부칙\s*)?수정\s*$/, "")
    .replace(/^\s*\d{4}\s*년도?\s*/, "")
    .trim();

// 같은 지침이면 같은 키(표기 차이 무시)
export function seriesKey(title) {
  return stripDecor(title)
    .replace(/공기업[\s·.ㆍ]*준정부기관/g, "공기업준정부기관")
    .replace(/[\s·.ㆍ]/g, "");
}

const toVersion = (r) => ({
  boardNo: String(r.boardNo),
  title: r.rtitle.trim(),
  series: seriesKey(r.rtitle),
  revDate: revisionDate(r.rtitle) || toIso(r.idate),
  postedDate: toIso(r.idate),
  publisher: r.pname && r.pname !== "None" ? r.pname : "",
  draft: /개정안/.test(r.rtitle),
});
// 최신 개정본이 맨 앞. 게시 순서와 개정 순서가 다를 수 있어('20.9.24 개정본이 2020.12.29 개정본보다 늦게 게시) 개정일로 정렬한다.
const byRevision = (a, b) => (a.revDate === b.revDate ? Number(b.boardNo) - Number(a.boardNo) : b.revDate < a.revDate ? -1 : 1);

export function parseVersionList(rows, title = GUIDELINE_TITLE) {
  const key = seriesKey(title);
  return rows
    .filter((r) => seriesKey(r.rtitle || "") === key)
    .map(toVersion)
    .filter((v) => v.revDate)
    .sort(byRevision);
}

// 게시판 전체 → 계열 목록(최근 개정 순). name 은 최신 게시물 제목에서 괄호를 뗀 것
export function groupSeries(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!r.rtitle) continue;
    const v = toVersion(r);
    if (!v.revDate) continue;
    if (!m.has(v.series)) m.set(v.series, []);
    m.get(v.series).push(v);
  }
  return [...m.entries()]
    .map(([key, versions]) => {
      versions.sort(byRevision);
      const name = stripDecor(versions[0].title);
      return { key, name, versions };
    })
    .sort((a, b) => byRevision(a.versions[0], b.versions[0]));
}

// 지침명 일부로 계열 찾기(공백·가운뎃점 무시). 정확히 같은 계열이 있으면 그것 하나
export function findSeries(series, query) {
  const q = seriesKey(query);
  if (!q) return [];
  const exact = series.filter((s) => s.key === q);
  if (exact.length) return exact;
  return series.filter((s) => s.key.includes(q));
}

const memo = { at: 0, rows: null };
export function clearGuidelineMemo() {
  memo.at = 0;
  memo.rows = null;
}

// 게시판 전체 게시물(약 80건, 8쪽). 6시간 동안 메모리에 둔다.
async function listBoard({ force = false } = {}) {
  if (!force && memo.rows && Date.now() - memo.at < guidelineSettings.listCacheMs) return memo.rows;
  const rows = [];
  for (let page = 1, total = 1; page <= total && page <= 30; page++) {
    const q = new URLSearchParams({ type: "title", word: "", pageNo: String(page) });
    const j = await getJson(`/etc/findEtcLawList.json?${q}`);
    const d = j?.data;
    if (!Array.isArray(d?.result) || !d?.page)
      throw new AlioError("SCHEMA", "ALIO 법령/지침 목록 응답 구조가 예상과 다름 — 사이트 개편 의심");
    total = Number(d.page.totalPage) || 1;
    rows.push(...d.result);
  }
  memo.rows = rows;
  memo.at = Date.now();
  return rows;
}

export async function listGuidelineSeries({ force = false } = {}) {
  return groupSeries(await listBoard({ force }));
}

// 지침 하나의 개정본 목록(최신이 맨 앞). title 은 지침명 전체나 일부
export async function listGuidelineVersions({ force = false, title = GUIDELINE_TITLE } = {}) {
  const found = findSeries(await listGuidelineSeries({ force }), title);
  if (!found.length) throw new AlioError("SCHEMA", `ALIO 법령/지침에서 「${title}」을 찾지 못함`);
  return found[0].versions;
}

// 기준일에 시행 중이던 개정본 = 개정일이 기준일 이전인 것 중 가장 늦은 것
export function versionAt(versions, date) {
  const d = toIso(date);
  return versions.find((v) => v.revDate <= d) || null;
}

export async function loadGuidelineVersion(v, { cacheDir = DEFAULT_CACHE_DIR } = {}) {
  const cachePath = path.join(cacheDir, `guideline_${v.boardNo}.json`);
  try {
    const c = JSON.parse(await fs.readFile(cachePath, "utf8"));
    if (c.cacheVersion === CACHE_VERSION) return c;
  } catch {}
  const d = (await getJson(`/etc/findEtcLawDtl.json?boardNo=${v.boardNo}`))?.data;
  const file = (d?.fileList || []).find((f) => /\.(hwpx?|pdf|docx|zip)$/i.test(f.fileNm || ""));
  if (!file) throw new AlioError("NO_FILE", `${v.title} 게시물에 읽을 수 있는 첨부가 없음`);
  const buf = await getFile(`/download/download.json?fileNo=${file.fileNo}`);
  const r = await extractDocument(buf, file.fileNm);
  const doc = { cacheVersion: CACHE_VERSION, version: v, fileName: file.fileNm, units: splitArticles(r.markdown) };
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(doc));
  return doc;
}

// 정부조직 개편에 따른 명칭 변경(2025.10.1 기획재정부 → 재정경제부). 이것만 다른 조문은 '명칭만 변경'으로 따로 센다.
export const NAME_CHANGES = [["기획재정부", "재정경제부"]];
const applyNames = (t) => NAME_CHANGES.reduce((s, [a, b]) => s.split(a).join(b), t);

const unitKey = (u) => (u.kind === "머리" ? null : u.kind === "별표" ? u.no.replace(/\s+/g, "") : u.no);
const normLine = (l) => l.replace(/\s+/g, " ").trim();
const normText = (t) => t.replace(/\s+/g, "");

// 조문 단위 비교. 바뀐 조문은 사라진 줄(-)과 새로 생긴 줄(+)을 보여준다.
export function diffUnits(oldUnits, newUnits) {
  const index = (units) => {
    const m = new Map();
    for (const u of units) {
      let k = unitKey(u);
      if (!k) continue;
      for (let n = 2; m.has(k); n++) k = `${unitKey(u)}#${n}`;
      m.set(k, u);
    }
    return m;
  };
  const om = index(oldUnits);
  const nm = index(newUnits);
  const added = [];
  const changed = [];
  for (const [k, u] of nm) {
    const o = om.get(k);
    if (!o) added.push(u);
    else if (normText(o.text) !== normText(u.text)) {
      const ol = o.text.split("\n").map(normLine).filter(Boolean);
      const nl = u.text.split("\n").map(normLine).filter(Boolean);
      const oset = new Set(ol.map(normText));
      const nset = new Set(nl.map(normText));
      changed.push({
        unit: u,
        renameOnly: normText(applyNames(o.text)) === normText(u.text),
        prevTitle: o.title !== u.title ? o.title : undefined,
        removed: ol.filter((l) => !nset.has(normText(l))),
        added: nl.filter((l) => !oset.has(normText(l))),
      });
    }
  }
  const removed = [...om].filter(([k]) => !nm.has(k)).map(([, u]) => u);
  return { added, removed, changed, same: nm.size - added.length - changed.length };
}

const statePath = (cacheDir) => path.join(cacheDir, "guideline_state.json");
async function readState(cacheDir) {
  try {
    const s = JSON.parse(await fs.readFile(statePath(cacheDir), "utf8"));
    // 예전 형식(혁신 지침 하나만 기록) → 계열별 기록
    if (s.boardNo && !s.series) return { series: { [seriesKey(GUIDELINE_TITLE)]: s } };
    return s.series ? s : { series: {} };
  } catch {
    return { series: {} };
  }
}
export async function readSeen(cacheDir = DEFAULT_CACHE_DIR, key = seriesKey(GUIDELINE_TITLE)) {
  return (await readState(cacheDir)).series[key] || null;
}
export async function markSeen(v, cacheDir = DEFAULT_CACHE_DIR) {
  const state = await readState(cacheDir);
  state.series[v.series || seriesKey(v.title)] = { boardNo: v.boardNo, revDate: v.revDate, title: v.title, seenAt: new Date().toISOString() };
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(statePath(cacheDir), JSON.stringify(state));
}

// 결과 머리에 표시할 지침(감시 지침). ALIO_WATCH_GUIDELINES="임원 보수지침,예산운용지침" 처럼 여러 개. 기본은 혁신 지침.
export function watchedGuidelines() {
  const v = (process.env.ALIO_WATCH_GUIDELINES || "").trim();
  const list = v && !v.includes("${") ? v.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean) : [];
  return list.length ? list : [GUIDELINE_TITLE];
}

// 모든 도구 결과 맨 위에 붙는 기준 지침 표시. 실패해도 도구는 계속 동작하되, 확인 실패를 숨기지 않는다.
export async function guidelineHeader({ cacheDir = DEFAULT_CACHE_DIR, titles = watchedGuidelines() } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  let series;
  try {
    series = await Promise.race([
      listGuidelineSeries(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${guidelineSettings.headerTimeoutMs / 1000}초 안에 응답 없음`)), guidelineSettings.headerTimeoutMs)),
    ]);
  } catch (e) {
    return `⚠️ 기준 지침(${titles.join(", ")}) 최신성 확인 실패(${e.message}). 기준이 최신인지 확인되지 않았으니 alio_guideline 으로 다시 확인하세요.\n\n`;
  }
  const lines = [];
  for (const t of titles) {
    const s = findSeries(series, t)[0];
    if (!s) {
      lines.push(`⚠️ 감시 지침 「${t}」을 ALIO 법령/지침 게시판에서 찾지 못했습니다(alio_guideline list 로 이름 확인).`);
      continue;
    }
    const latest = s.versions[0];
    const seen = await readSeen(cacheDir, s.key);
    lines.push(`📌 기준 지침: ${latest.title} (ALIO 게시 ${latest.postedDate}, 최신성 확인 ${today})`);
    if (!seen) lines.push(`⚠️ 이 지침을 아직 확인한 기록이 없습니다. 검토 전에 alio_guideline 으로 현행 내용과 변경점을 확인하세요.`);
    else if (seen.boardNo !== latest.boardNo)
      lines.push(`⚠️ 지난 확인(${seen.revDate} 개정본) 이후 새 개정이 게시되었습니다. 검토 전에 alio_guideline 으로 달라진 점을 먼저 확인·설명하세요.`);
  }
  return lines.join("\n") + "\n\n";
}
