// 규정 본문 읽기: 현행 첨부파일 → kordoc 으로 텍스트 추출 → 조문 단위 분할 → 캐시
import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "kordoc";
import JSZip from "jszip";
import { AlioError, getRuleFiles, pickLatestFile, fetchRuleFile, settings } from "./alio-client.js";

import { CACHE_DIR } from "./paths.js";

export const DEFAULT_CACHE_DIR = CACHE_DIR;
export const CACHE_VERSION = 9; // 분할 규칙이 바뀌면 올려서 기존 캐시를 무효화

// "제16조의 2(채용비위…)", "### 제2조(적용범위)", "제20조 삭제 <…>" — 괄호 제목이나 '삭제'가 붙어야 조문 시작으로 본다.
// 본문 속 인용("제59조의 규정에 의하여")은 괄호가 없어 걸리지 않는다.
const ARTICLE_RE = /^제\s*(\d+)\s*조(?:\s*의\s*(\d+))?\s*(?:[(（]([^)）]*)[)）]|(?=[<〈[]?\s*삭제))/;
// PDF에서 앞 문장에 이어 붙은 조문: "…책정한다. 제 11 조 (적용예외) …"
// 괄호에 조사가 바로 붙으면("제11조(감경)에 따라") 인용. 띄어 쓴 "제2조(적용범위) 이 규정은"은 조문
const INLINE_RE = /제\s*(\d+)\s*조(?:\s*의\s*(\d+))?\s*[(（][^)）]{1,40}[)）](?!(?:에|를|을|의|은|는|이|가|와|과|로))(?!\s*(?:및|등)(?![가-힣]))/g;
// "제1장 총칙", "제6장유연근무"(붙여 씀). 문장("…에 따른다.")은 제외한다.
const PART_RE = /^제\s*\d+\s*(편|장|절)(?:\s*의\s*\d+)?(?=[\s가-힣A-Za-z]|$)(?!.*다\.?$)/;
// "부 칙", "부칙 <2025. 6. 26.>", "부 칙(2009.9.24)", "부 칙('06.7.31)"
const ADDENDA_RE = /^부\s*칙(?:\s|[<(（\[]|$)/;
// "[별표 3]", "[별지 제1호서식]", "<별지 제1호 서식>", "【별표 1】", "〈별지10호 서식〉", "(별표 1)"
// 괄호에 조사가 바로 붙은 인용("(별표 1)에 따른")과 "(별표 1) 참조"는 제외. 띄어 쓴 "(별표 7) 과제 중단"은 별표
const ANNEX_RE = /^[[<【〈《(（]\s*(별\s*표|별\s*지)[^\]>】〉》)）]*[\]>】〉》)）](?!(?:에|를|을|의|은|는|이|가|와|과|로))(?!\s*(?:및|등|참조)(?![가-힣]))/;
// PDF 앞머리 목차 줄: "제3조 근무시간 ········· 3", "부 칙 ·······"
// 목차 줄: 점선("제3조 근무시간 ·····") 또는 탭+쪽번호("제3조 근무시간 \t 5 제4조 …", kordoc 4.16 PDF 추출)
const TOC_RE = /[·.…ㆍ・]{5,}|(?:\.\s){5,}|\t\s*\d{1,4}(?:\s|$)/;
// 조문이 없는 안내서형 지침의 구간 제목: "Ⅲ. 유연근무제", "| Ⅰ |  | 개 요 |", "# 제목"
const SECTION_RE = /^(?:\|\s*)?[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+(?:[.．\s|]|$)/;

// 개정 조문의 밑줄·굵게 표시("<u>제2조(정의)…</u>")는 벗긴다. 표(<table>) 태그는 남긴다.
const clean = (line) =>
  line
    .replace(/<\/?(?:u|b|i|s|em|strong|span|font|mark|ins|del)\b[^>]*>/gi, "")
    .replace(/^#{1,6}\s*/, "")
    .replace(/\*\*/g, "")
    .trim();
const articleKey = (a, b) => `${Number(a)}-${Number(b || 0)}`;
const keyOrder = (k) => k.split("-").map(Number);
const after = (k, last) => {
  if (!last) return true;
  const [a, b] = keyOrder(k);
  const [c, d] = keyOrder(last);
  return a > c || (a === c && b > d);
};

const isNext = (k, last) => {
  if (!last) return false;
  const [a, b] = keyOrder(k);
  const [c, d] = keyOrder(last);
  return (a === c + 1 && b === 0) || (a === c && b === d + 1);
};

// 문장이 끝난 직후에 '바로 다음 번호' 조문이 오는 경우에만 줄을 나눈다. 인용("제11조(적용예외)에 따라")과 구분하기 위함.
function splitInline(line, lastKey) {
  const own = line.match(ARTICLE_RE);
  let last = own && after(articleKey(own[1], own[2]), lastKey) ? articleKey(own[1], own[2]) : lastKey;
  const parts = [];
  let from = 0;
  for (const m of line.matchAll(INLINE_RE)) {
    if (m.index === 0) continue;
    const k = articleKey(m[1], m[2]);
    if (!/[.다>]$/.test(line.slice(0, m.index).trimEnd()) || !isNext(k, last)) continue;
    parts.push(line.slice(from, m.index).trim());
    from = m.index;
    last = k;
  }
  parts.push(line.slice(from).trim());
  return parts.filter(Boolean);
}

function addendaDate(text) {
  const m = [
    [text.match(/(\d{4})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})/), (y) => y],
    [text.match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/), (y) => y],
    [text.match(/[`'’‘](\d{2})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})/), (y) => (Number(y) > 50 ? `19${y}` : `20${y}`)],
  ]
    .filter(([x]) => x)
    .sort((a, b) => a[0].index - b[0].index)[0];
  return m ? `${m[1](m[0][1])}.${Number(m[0][2])}.${Number(m[0][3])}` : null;
}

// 조문 구조가 없는 문서: 로마숫자·마크다운 제목에서 끊고, 너무 길면 약 1,500자 단위로 끊는다.
function splitSections(markdown) {
  const out = [];
  let cur = null;
  const start = (title) => {
    if (cur?.lines.length) out.push(cur);
    cur = { title, lines: [] };
  };
  start("");
  for (const raw of markdown.split(/\r?\n/)) {
    const line = clean(raw);
    if (!line || TOC_RE.test(line)) continue;
    const isHead = SECTION_RE.test(line) || (/^#{1,3}\s/.test(raw.trim()) && line.length < 60);
    const size = cur.lines.reduce((n, l) => n + l.length, 0);
    if ((isHead && size > 0) || size > 1500) start(isHead ? line.replace(/[|\s]+/g, " ").trim() : cur.title);
    cur.lines.push(line);
  }
  if (cur?.lines.length) out.push(cur);
  return out.map((s, i) => ({ kind: "구간", no: `구간${i + 1}`, title: s.title, part: "", text: s.lines.join("\n") }));
}

export function splitArticles(markdown) {
  const units = [];
  let cur = null;
  let chapter = "";
  let section = "";
  let zone = "body";
  let lastKey = null;
  const start = (u) => {
    if (cur) units.push(cur);
    cur = { ...u, lines: [] };
  };
  start({ kind: "머리", no: "머리", title: "", part: "" });

  const lines = [];
  for (const raw of markdown.split(/\r?\n/)) {
    const line = clean(raw);
    if (line && !TOC_RE.test(line)) lines.push(line);
  }
  const queue = [...lines];

  while (queue.length) {
    let line = queue.shift();
    if (zone === "body") {
      const [first, ...rest] = splitInline(line, lastKey);
      line = first;
      queue.unshift(...rest);
    }

    const annex = line.match(ANNEX_RE);
    if (annex) {
      zone = "annex";
      start({ kind: "별표", no: annex[0].replace(/\s+/g, " "), title: line.slice(annex[0].length).trim(), part: "" });
    } else if (ADDENDA_RE.test(line)) {
      zone = "addenda";
      start({ kind: "부칙", no: "부칙", title: "", part: "" });
    } else if (zone === "body") {
      const p = line.match(PART_RE);
      const a = line.match(ARTICLE_RE);
      if (p && !a && line.length < 60) {
        if (p[1] === "절") section = line;
        else [chapter, section] = [line, ""];
        continue;
      }
      // 번호가 앞으로 가지 않으면(줄바꿈으로 줄 머리에 온 인용 등) 새 조문으로 보지 않는다
      if (a && after(articleKey(a[1], a[2]), lastKey)) {
        lastKey = articleKey(a[1], a[2]);
        start({
          kind: "조문",
          no: `제${Number(a[1])}조${a[2] ? `의${Number(a[2])}` : ""}`,
          key: lastKey,
          title: (a[3] || "").trim(),
          part: [chapter, section].filter(Boolean).join(" > "),
        });
      }
    }
    cur.lines.push(line);
  }
  if (cur) units.push(cur);

  const out = units.map(({ lines, ...u }) => ({ ...u, text: lines.join("\n") })).filter((u) => u.text);
  for (const u of out) {
    if (u.kind !== "부칙") continue;
    const d = addendaDate(u.text);
    if (d) u.no = `부칙(${d})`;
  }
  if (!out.some((u) => u.kind === "조문")) {
    const rest = out.filter((u) => u.kind === "부칙" || u.kind === "별표");
    const body = markdown.split(/\r?\n/);
    const cut = body.findIndex((l) => ADDENDA_RE.test(clean(l)) || ANNEX_RE.test(clean(l)));
    return [...splitSections(cut === -1 ? markdown : body.slice(0, cut).join("\n")), ...rest];
  }
  return out;
}

// 조문 번호가 건너뛴 곳: 추출 과정에서 조문 경계를 놓쳐 앞 조문에 합쳐졌을 가능성
export function articleGaps(units) {
  const nums = units.filter((u) => u.kind === "조문").map((u) => keyOrder(u.key)[0]);
  const missing = [];
  for (let i = 1; i < nums.length; i++) for (let n = nums[i - 1] + 1; n < nums[i]; n++) missing.push(`제${n}조`);
  if (nums.length && nums[0] > 1) missing.unshift(...Array.from({ length: nums[0] - 1 }, (_, i) => `제${i + 1}조`));
  return missing;
}

const norm = (s) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, "").toLowerCase();
const queryGroups = (query) =>
  (query || "")
    .trim()
    .split(/\s+/)
    .map((g) => g.split("|").map(norm).filter(Boolean))
    .filter((g) => g.length);

// 긴 조문은 검색어가 처음 나오는 곳 주변을 잘라 보여준다 (앞부분만 자르면 일치한 곳이 안 보일 수 있음)
export function excerpt(text, query, n) {
  if (text.length <= n) return text;
  const terms = queryGroups(query).flat();
  let pos = -1;
  for (const t of terms) {
    const re = new RegExp([...t].map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*"), "i");
    const m = text.match(re);
    if (m && (pos === -1 || m.index < pos)) pos = m.index;
  }
  if (pos === -1 || pos < n * 0.6) return `${text.slice(0, n)}\n…(이하 ${text.length - n}자 생략)`;
  const start = Math.max(0, pos - Math.floor(n / 3));
  const end = Math.min(text.length, start + n);
  return `${text.slice(0, 120)}\n…(중략)…\n${text.slice(start, end)}${end < text.length ? `\n…(이하 ${text.length - end}자 생략)` : ""}`;
}

// 공백으로 나눈 검색어는 모두 포함(AND), "a|b" 는 둘 중 하나(OR). 띄어쓰기 차이는 무시.
export function matchArticles(units, query) {
  const groups = queryGroups(query);
  if (!groups.length) return [];
  return units.filter((u) => {
    const t = norm(`${u.no} ${u.title} ${u.text}`);
    return groups.every((alts) => alts.some((a) => t.includes(a)));
  });
}

// "제10조의2", "10조의 2", "10", "부칙", "별표 3" 형태로 조문을 고른다.
export function pickArticles(units, refs) {
  const picked = [];
  const missing = [];
  for (const ref of refs) {
    const r = ref.replace(/\s+/g, "");
    let found;
    if (/^부칙/.test(r)) found = units.filter((u) => u.kind === "부칙");
    else if (/^구간\d+$/.test(r)) found = units.filter((u) => u.no === r);
    else if (/^[[<【〈《(（]?별(표|지)/.test(r)) {
      const kind = r.match(/별(표|지)/)[0];
      const n = r.match(/\d+/)?.[0];
      const re = new RegExp(`${kind}${n ? `${n}(?!\\d)` : ""}`);
      found = units.filter((u) => u.kind === "별표" && re.test(u.no.replace(/[\s제호]|서식/g, "")));
    } else {
      const m = r.match(/^제?(\d+)조?(?:의(\d+))?$/);
      found = m ? units.filter((u) => u.key === articleKey(m[1], m[2])) : [];
    }
    if (found.length) picked.push(...found.filter((u) => !picked.includes(u)));
    else missing.push(ref);
  }
  return { picked, missing };
}

async function parseOne(buf, name) {
  let r;
  try {
    r = await parse(buf);
  } catch (e) {
    throw new AlioError("PARSE", `${name} 본문 추출 실패: ${e.message}`);
  }
  if (!r.success) throw new AlioError("PARSE", `${name} 본문 추출 실패: ${r.error}`);
  if (r.isImageBased) throw new AlioError("PARSE", `${name} 은 스캔 이미지 PDF라 본문을 추출할 수 없음`);
  return r;
}

// 파일명 속 개정일을 비교 가능한 숫자로: "2026년도 3월 6일", "22년 10월", "20251114", "2025.11.14"
export function nameDate(name) {
  const y4 = name.match(/(\d{4})\s*년\s*도?\s*(\d{1,2})\s*월(?:\s*(\d{1,2})\s*일)?/);
  if (y4) return +y4[1] * 10000 + +y4[2] * 100 + +(y4[3] || 0);
  const y2 = name.match(/(?<!\d)(\d{2})\s*년\s*도?\s*(\d{1,2})\s*월(?:\s*(\d{1,2})\s*일)?/);
  if (y2) return (2000 + +y2[1]) * 10000 + +y2[2] * 100 + +(y2[3] || 0);
  const ymd = name.match(/(?<!\d)((?:19|20)\d{2})[.\-]?(\d{2})[.\-]?(\d{2})(?!\d)/);
  if (ymd) return +ymd[1] * 10000 + +ymd[2] * 100 + +ymd[3];
  return null;
}

// 압축 파일에는 개정 이력 전 버전이 함께 들어 있을 수 있다(국민연금공단 보수규정: 13개 버전).
// 합치면 옛 조문이 섞이므로 현행본 하나만 고르고, 특정할 수 없으면 추측하지 않고 실패로 알린다.
export function pickZipEntry(zipName, names) {
  if (names.length === 1) return names[0];
  const base = zipName.replace(/\.zip$/i, "").replace(/\s+/g, "");
  const same = names.filter((n) => n.replace(/\.\w+$/, "").replace(/\s+/g, "").endsWith(base));
  if (same.length === 1) return same[0];
  const dated = names.map((n) => [n, nameDate(n)]).filter(([, d]) => d);
  if (dated.length) {
    const max = Math.max(...dated.map(([, d]) => d));
    const top = dated.filter(([, d]) => d === max);
    if (top.length === 1) return top[0][0];
  }
  return null;
}

export async function extractDocument(buf, fileName) {
  if (!/\.zip$/i.test(fileName)) {
    const r = await parseOne(buf, fileName);
    return { markdown: r.markdown, fileType: r.fileType };
  }
  let zip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch (e) {
    throw new AlioError("PARSE", `${fileName} 압축 해제 실패: ${e.message}`);
  }
  const entries = Object.values(zip.files).filter((f) => !f.dir && /\.(hwpx?|pdf|docx)$/i.test(f.name));
  if (!entries.length) throw new AlioError("PARSE", `${fileName} 안에 읽을 수 있는 문서(hwp·hwpx·pdf·docx)가 없음`);
  const pick = pickZipEntry(fileName, entries.map((e) => e.name.split("/").pop()));
  if (!pick)
    throw new AlioError(
      "PARSE",
      `${fileName} 안의 문서 ${entries.length}개 중 현행본을 특정할 수 없음: ${entries.map((e) => e.name).slice(0, 6).join(", ")}`
    );
  const entry = entries.find((e) => e.name.split("/").pop() === pick);
  const r = await parseOne(Buffer.from(await entry.async("uint8array")), pick);
  return { markdown: r.markdown, fileType: `${r.fileType}(zip)`, innerName: pick };
}

// 규정 하나의 현행본 본문을 조문 단위로 반환. 첨부 목록은 매번 확인해 새 개정본이 올라오면 다시 읽는다.
// 검색 결과의 최종 수정일·시행일이 지난번과 같으면 상세 페이지를 다시 열지 않는다.
// 수정일을 모르는 호출(기관ID·idx만 받은 경우)은 항상 상세 페이지로 최신 첨부를 확인한다.
async function ruleFiles(rule, cacheDir) {
  const p = path.join(cacheDir, `files_${rule.apbaId}_${rule.idx}.json`);
  const stamp = rule.modDate ? `${rule.modDate}|${rule.enfDate || ""}` : null;
  if (stamp) {
    try {
      const c = JSON.parse(await fs.readFile(p, "utf8"));
      if (c.stamp === stamp && Date.now() - c.at < settings.fileListCacheMs) return c.files;
    } catch {}
  }
  const files = await getRuleFiles(rule);
  if (stamp) {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(p, JSON.stringify({ stamp, at: Date.now(), files }));
  }
  return files;
}

export async function loadRuleText(rule, { cacheDir = DEFAULT_CACHE_DIR } = {}) {
  const files = await ruleFiles(rule, cacheDir);
  if (!files.length) throw new AlioError("NO_FILE", "첨부파일이 없어 본문을 읽을 수 없음");
  const file = pickLatestFile(files);
  const cachePath = path.join(cacheDir, `${rule.apbaId}_${rule.idx}_${file.fileNo}.json`);

  try {
    const c = JSON.parse(await fs.readFile(cachePath, "utf8"));
    if (c.cacheVersion === CACHE_VERSION) return { ...c, cached: true };
  } catch {}

  const { buf } = await fetchRuleFile(file.fileNo);
  const r = await extractDocument(buf, file.fileName);

  const units = splitArticles(r.markdown);
  const gaps = articleGaps(units);
  const doc = {
    cacheVersion: CACHE_VERSION,
    apbaId: rule.apbaId,
    idx: String(rule.idx),
    org: rule.org || "",
    title: rule.title || "",
    file: r.innerName ? { ...file, innerName: r.innerName } : file,
    fileType: r.fileType,
    units,
    warnings: gaps.length
      ? [`조문 번호 누락 ${gaps.length}개(${gaps.slice(0, 8).join(", ")}${gaps.length > 8 ? " 등" : ""}) — 원문에 없거나, 추출 중 경계를 놓쳐 앞 조문에 합쳐졌을 수 있음`]
      : [],
  };
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(doc));
  return { ...doc, cached: false };
}
