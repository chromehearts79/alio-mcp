// 「공공기관의 혁신에 관한 지침」 최신성 확인·버전 비교
// 출처: ALIO '공공기관 법령/지침' 게시판(재정경제부 게시, 공식). 한국공공기관연구원 자료실보다 버전이 더 많다(13 vs 9).
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

export function parseVersionList(rows) {
  return rows
    .filter((r) => (r.rtitle || "").trim().startsWith(GUIDELINE_TITLE))
    .map((r) => ({
      boardNo: String(r.boardNo),
      title: r.rtitle.trim(),
      revDate: revisionDate(r.rtitle),
      postedDate: toIso(r.idate),
      publisher: r.pname && r.pname !== "None" ? r.pname : "",
    }))
    .filter((v) => v.revDate)
    .sort((a, b) => (a.revDate === b.revDate ? Number(b.boardNo) - Number(a.boardNo) : b.revDate < a.revDate ? -1 : 1));
}

const memo = { at: 0, versions: null };
export function clearGuidelineMemo() {
  memo.at = 0;
  memo.versions = null;
}

// 최신 개정본이 맨 앞. 게시 순서와 개정 순서가 다를 수 있어('20.9.24 개정본이 2020.12.29 개정본보다 늦게 게시) 개정일로 정렬한다.
export async function listGuidelineVersions({ force = false } = {}) {
  if (!force && memo.versions && Date.now() - memo.at < guidelineSettings.listCacheMs) return memo.versions;
  const rows = [];
  for (let page = 1, total = 1; page <= total && page <= 20; page++) {
    const q = new URLSearchParams({ type: "title", word: GUIDELINE_TITLE, pageNo: String(page) });
    const j = await getJson(`/etc/findEtcLawList.json?${q}`);
    const d = j?.data;
    if (!Array.isArray(d?.result) || !d?.page)
      throw new AlioError("SCHEMA", "ALIO 법령/지침 목록 응답 구조가 예상과 다름 — 사이트 개편 의심");
    total = Number(d.page.totalPage) || 1;
    rows.push(...d.result);
  }
  const versions = parseVersionList(rows);
  if (!versions.length) throw new AlioError("SCHEMA", `ALIO 법령/지침에서 「${GUIDELINE_TITLE}」을 찾지 못함`);
  memo.versions = versions;
  memo.at = Date.now();
  return versions;
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
export async function readSeen(cacheDir = DEFAULT_CACHE_DIR) {
  try {
    return JSON.parse(await fs.readFile(statePath(cacheDir), "utf8"));
  } catch {
    return null;
  }
}
export async function markSeen(v, cacheDir = DEFAULT_CACHE_DIR) {
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(statePath(cacheDir), JSON.stringify({ boardNo: v.boardNo, revDate: v.revDate, title: v.title, seenAt: new Date().toISOString() }));
}

// 모든 도구 결과 맨 위에 붙는 기준 지침 표시. 실패해도 도구는 계속 동작하되, 확인 실패를 숨기지 않는다.
export async function guidelineHeader({ cacheDir = DEFAULT_CACHE_DIR } = {}) {
  try {
    const versions = await Promise.race([
      listGuidelineVersions(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${guidelineSettings.headerTimeoutMs / 1000}초 안에 응답 없음`)), guidelineSettings.headerTimeoutMs)),
    ]);
    const latest = versions[0];
    const seen = await readSeen(cacheDir);
    const base = `📌 기준 지침: ${latest.title} (ALIO 게시 ${latest.postedDate}, 최신성 확인 ${new Date().toISOString().slice(0, 10)})`;
    if (!seen)
      return `${base}\n⚠️ 이 지침을 아직 확인한 기록이 없습니다. 검토 전에 alio_guideline 으로 현행 내용과 변경점을 확인하세요.\n\n`;
    if (seen.boardNo !== latest.boardNo)
      return `${base}\n⚠️ 지난 확인(${seen.revDate} 개정본) 이후 새 개정이 게시되었습니다. 검토 전에 alio_guideline 으로 달라진 점을 먼저 확인·설명하세요.\n\n`;
    return `${base}\n\n`;
  } catch (e) {
    return `⚠️ 「${GUIDELINE_TITLE}」 최신성 확인 실패(${e.message}). 기준이 최신인지 확인되지 않았으니 alio_guideline 으로 다시 확인하세요.\n\n`;
  }
}
