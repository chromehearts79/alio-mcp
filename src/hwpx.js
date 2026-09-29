// 마크다운 → 한글(HWPX) 문서. kordoc 보고서 양식으로 만든 뒤 문서 서식 기준을 입힌다.
//
// 서식 기준(기본값)
// - 글꼴: 전체 함초롬바탕, ※(당구장 표시)·별첨으로 시작하는 문단은 함초롬돋움
// - 크기: 본문 15pt, 자료표(2행·2열 이상) 안 12pt. 제목·요약·장 제목 상자(1행 또는 1열 표)는 유지
// - 줄 나눔: 한글 어절, 영어 단어 / 정렬: 양쪽(가운데·오른쪽 정렬은 의도된 배치로 보고 유지)
// - 신구조문 대비표(머리행에 '현행'·'개정안'): 열 너비 37:37:26, **굵게** 표시한 부분은 밑줄로
import JSZip from "jszip";
import { markdownToHwpx, simulateWrap } from "kordoc";

export const HOUSE_STYLE = { font: "함초롬바탕", refFont: "함초롬돋움", bodyPt: 15, tablePt: 12 };

const LANGS = ["hangul", "latin", "hanja", "japanese", "other", "symbol", "user"];
// 문단 첫머리가 ※ 이거나 별첨 표기(별첨, [별첨], <별첨>, 별첨1 …)
const REF_PARA = /^\s*(※|[[<〈【(（]?\s*별\s*첨)/;
const CMP_WIDTHS = { 2: [0.5, 0.5], 3: [0.37, 0.37, 0.26] };

const xmlText = (p) =>
  [...p.matchAll(/<hp:t>([\s\S]*?)<\/hp:t>/g)]
    .map((m) => m[1])
    .join("")
    .replace(/<hp:nbSpace\/>/g, " ")
    .replace(/<hp:tab[^>]*>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

// 언어별 fontface 에 필요한 글꼴을 찾고, 없으면 추가한다. → { lang: { face: id } }
function ensureFonts(header, faces) {
  const ids = {};
  header = header.replace(/<hh:fontface lang="(\w+)"[\s\S]*?<\/hh:fontface>/g, (block, lang) => {
    const found = {};
    for (const face of faces) {
      const m = block.match(new RegExp(`<hh:font id="(\\d+)" face="${face}"`));
      if (m) found[face] = m[1];
      else {
        const id = String((block.match(/<hh:font /g) || []).length);
        block = block.replace("</hh:fontface>", `<hh:font id="${id}" face="${face}" type="TTF" isEmbedded="0"/></hh:fontface>`);
        found[face] = id;
      }
    }
    ids[lang.toLowerCase()] = found;
    return block.replace(/fontCnt="\d+"/, `fontCnt="${(block.match(/<hh:font /g) || []).length}"`);
  });
  return { header, ids };
}

// 표 위치와 종류: data=자료표(2행·2열 이상), cmp=신구조문 대비표
function tableSpans(sec) {
  const spans = [];
  const stack = [];
  for (const m of sec.matchAll(/<hp:tbl [^>]*>|<\/hp:tbl>/g)) {
    if (m[0] !== "</hp:tbl>") {
      const rows = +m[0].match(/rowCnt="(\d+)"/)[1];
      const cols = +m[0].match(/colCnt="(\d+)"/)[1];
      stack.push({ start: m.index, rows, cols });
      continue;
    }
    const t = stack.pop();
    const body = sec.slice(t.start, m.index + m[0].length);
    const firstRow = xmlText(body.match(/<hp:tr>[\s\S]*?<\/hp:tr>/)?.[0] || "").replace(/\s/g, "");
    spans.push({
      ...t,
      end: m.index + m[0].length,
      data: t.rows >= 2 && t.cols >= 2,
      cmp: t.rows >= 2 && /현행/.test(firstRow) && /개정안/.test(firstRow),
    });
  }
  return spans;
}

const innermost = (pos, spans) =>
  spans.filter((s) => s.start < pos && pos < s.end).sort((a, b) => b.start - a.start)[0] || null;

export async function styleHwpx(buf, style = {}) {
  const st = { ...HOUSE_STYLE, ...style };
  const zip = await JSZip.loadAsync(buf);
  let header = await zip.file("Contents/header.xml").async("string");
  const sectionNames = Object.keys(zip.files).filter((n) => /^Contents\/section\d+\.xml$/.test(n));

  const fonts = ensureFonts(header, [st.font, st.refFont]);
  header = fonts.header;
  const fontRef = (face) => `<hh:fontRef ${LANGS.map((l) => `${l}="${fonts.ids[l][face]}"`).join(" ")}/>`;
  header = header.replace(/<hh:fontRef [^>]*\/>/g, fontRef(st.font));

  // 문단 모양: 양쪽 정렬, 한글 어절·영어 단어 줄 나눔.
  // 주의: 한글 쪽 값은 이름과 동작이 반대 — BREAK_WORD=어절, KEEP_WORD=글자 (한컴 저장본 기준)
  header = header
    .replace(/<hh:align horizontal="LEFT"/g, '<hh:align horizontal="JUSTIFY"')
    .replace(/breakLatinWord="\w+"/g, 'breakLatinWord="KEEP_WORD"')
    .replace(/breakNonLatinWord="\w+"/g, 'breakNonLatinWord="BREAK_WORD"');

  const charPrs = new Map([...header.matchAll(/<hh:charPr id="(\d+)"[\s\S]*?<\/hh:charPr>/g)].map((m) => [m[1], m[0]]));
  let nextId = Math.max(...[...charPrs.keys()].map(Number)) + 1;
  const variants = new Map();
  const added = [];
  // 글자 모양 복제본: 크기·글꼴·밑줄(굵게 해제)을 바꾼 것
  function variant(id, { height, face, underline }) {
    const base = charPrs.get(id);
    const cur = base.match(/height="(\d+)"/)[1];
    height = height || cur;
    if (height === cur && face === st.font && !underline) return id;
    const key = `${id}|${height}|${face}|${underline ? 1 : 0}`;
    if (!variants.has(key)) {
      let x = base
        .replace(`id="${id}"`, `id="${nextId}"`)
        .replace(/height="\d+"/, `height="${height}"`)
        .replace(fontRef(st.font), fontRef(face));
      if (underline)
        x = x
          .replace(/ bold="1"/, "")
          .replace(/<hh:bold\/>/, "")
          .replace(/<hh:underline [^>]*\/>/, "")
          .replace(/(<hh:offset [^>]*\/>)/, '$1<hh:underline type="BOTTOM" shape="SOLID" color="#000000"/>');
      added.push(x);
      charPrs.set(String(nextId), x);
      variants.set(key, String(nextId++));
    }
    return variants.get(key);
  }
  const isBold = (id) => / bold="1"|<hh:bold\/>/.test(charPrs.get(id));

  const stats = { body: 0, table: 0, box: 0, ref: [], midRef: [], cmpTables: 0 };
  const sections = {};
  for (const name of sectionNames) {
    let sec = await zip.file(name).async("string");
    const spans = tableSpans(sec);
    stats.cmpTables += spans.filter((s) => s.cmp).length;
    // 가장 안쪽 문단 단위(표를 품은 바깥 문단은 건너뜀)
    sec = sec.replace(/<hp:p (?:(?!<hp:p )[\s\S])*?<\/hp:p>/g, (p, offset) => {
      const t = innermost(offset, spans);
      const inCmpBody = t?.cmp && !isHeaderRow(sec, t, offset);
      let height = null;
      if (!t) (height = String(st.bodyPt * 100)), stats.body++;
      else if (t.data) (height = String(st.tablePt * 100)), stats.table++;
      else stats.box++;
      const text = xmlText(p);
      let face = st.font;
      if (REF_PARA.test(text)) (face = st.refFont), stats.ref.push(text.slice(0, 40));
      else if (text.includes("※")) stats.midRef.push(text.slice(0, 40));
      return p.replace(/(<hp:run charPrIDRef=")(\d+)"/g, (_, a, id) =>
        `${a}${variant(id, { height, face, underline: inCmpBody && isBold(id) })}"`
      );
    });
    sections[name] = sec;
  }

  header = header.replace("</hh:charProperties>", added.join("") + "</hh:charProperties>");
  header = header.replace(/(<hh:charProperties itemCnt=")\d+"/, `$1${(header.match(/<hh:charPr /g) || []).length}"`);
  for (const name of sectionNames) sections[name] = fitTables(sections[name], header);

  zip.file("Contents/header.xml", header);
  for (const [name, sec] of Object.entries(sections)) zip.file(name, sec);
  // mimetype 은 맨 앞·무압축이어야 한글이 연다
  const out = new JSZip();
  out.file("mimetype", await zip.file("mimetype").async("uint8array"), { compression: "STORE" });
  for (const [name, f] of Object.entries(zip.files)) {
    if (name === "mimetype" || f.dir) continue;
    out.file(name, await f.async("uint8array"));
  }
  const buffer = await out.generateAsync({ type: "nodebuffer", compression: "DEFLATE", mimeType: "application/hwp+zip" });
  return { buffer, stats };
}

// offset 의 문단이 표의 첫 행(머리행)에 있는가
function isHeaderRow(sec, t, offset) {
  const firstRowEnd = sec.indexOf("</hp:tr>", t.start);
  return offset < firstRowEnd;
}

// 자료표: 대비표 열 너비 조정, 바뀐 글자 크기로 행 높이 재계산(줄 수 × 줄 높이 + 셀 여백)
function fitTables(sec, header) {
  const charPr = new Map(
    [...header.matchAll(/<hh:charPr id="(\d+)" height="(\d+)"[\s\S]*?<hh:ratio hangul="(\d+)"/g)].map((m) => [m[1], { h: +m[2], ratio: +m[3] }])
  );
  const paraPr = new Map(
    [...header.matchAll(/<hh:paraPr id="(\d+)"[\s\S]*?<\/hh:paraPr>/g)].map((m) => {
      const b = m[0];
      const v = (k) => +(b.match(new RegExp(`<hc:${k} value="(-?\\d+)"`))?.[1] || 0);
      return [m[1], { spacing: +(b.match(/<hh:lineSpacing type="PERCENT" value="(\d+)"/)?.[1] || 160), side: v("left") + v("right"), gap: v("prev") + v("next") }];
    })
  );

  const cellHeight = (tc) => {
    const width = +tc.match(/<hp:cellSz width="(\d+)"/)[1];
    const [l, r, t, b] = (tc.match(/<hp:cellMargin left="(\d+)" right="(\d+)" top="(\d+)" bottom="(\d+)"/) || [0, 141, 141, 141, 141]).slice(1).map(Number);
    let total = t + b;
    for (const p of tc.match(/<hp:p [\s\S]*?<\/hp:p>/g) || []) {
      const pp = paraPr.get(p.match(/paraPrIDRef="(\d+)"/)?.[1]) || { spacing: 160, side: 0, gap: 0 };
      const runs = [...p.matchAll(/charPrIDRef="(\d+)"/g)].map((m) => charPr.get(m[1])).filter(Boolean);
      const size = Math.max(1000, ...runs.map((c) => c.h));
      const ratio = runs[0]?.ratio || 100;
      const avail = width - l - r - pp.side;
      const text = xmlText(p);
      const lines = text ? simulateWrap(text, avail, avail, size, ratio, "keep").lines : 1;
      total += Math.ceil((lines * size * Math.max(pp.spacing, 130)) / 100) + pp.gap;
    }
    return total + 200; // 마지막 줄 아래 여유
  };

  return sec.replace(/<hp:tbl [\s\S]*?<\/hp:tbl>/g, (tbl) => {
    const head = tbl.match(/<hp:tbl [^>]*>/)[0];
    const rows = +head.match(/rowCnt="(\d+)"/)[1];
    const cols = +head.match(/colCnt="(\d+)"/)[1];
    if (rows < 2 || cols < 2 || /rowSpan="[2-9]|colSpan="[2-9]/.test(tbl)) return tbl;

    const firstRow = xmlText(tbl.match(/<hp:tr>[\s\S]*?<\/hp:tr>/)[0]).replace(/\s/g, "");
    const ratios = /현행/.test(firstRow) && /개정안/.test(firstRow) ? CMP_WIDTHS[cols] : null;
    let widths = null;
    if (ratios) {
      const total = [...tbl.match(/<hp:tr>[\s\S]*?<\/hp:tr>/)[0].matchAll(/<hp:cellSz width="(\d+)"/g)].reduce((a, m) => a + +m[1], 0);
      widths = ratios.map((x) => Math.round(total * x));
      widths[cols - 1] = total - widths.slice(0, -1).reduce((a, b) => a + b, 0);
    }

    let sum = 0;
    tbl = tbl.replace(/<hp:tr>[\s\S]*?<\/hp:tr>/g, (tr) => {
      if (widths)
        tr = tr.replace(/<hp:tc [\s\S]*?<\/hp:tc>/g, (tc) => {
          const col = +tc.match(/<hp:cellAddr colAddr="(\d+)"/)[1];
          return tc.replace(/(<hp:cellSz width=")\d+"/, `$1${widths[col]}"`);
        });
      const h = Math.max(...(tr.match(/<hp:tc [\s\S]*?<\/hp:tc>/g) || []).map(cellHeight));
      sum += h;
      return tr.replace(/(<hp:cellSz width="\d+" height=")\d+"/g, `$1${h}"`);
    });
    return tbl.replace(/(<hp:sz width="\d+" widthRelTo="\w+" height=")\d+"/, `$1${sum}"`);
  });
}

// 마크다운 → 서식 기준을 입힌 HWPX
export async function markdownToStyledHwpx(markdown, { reportInfo, style } = {}) {
  const warnings = [];
  const raw = await markdownToHwpx(markdown, {
    gongmun: { preset: "보고서", ...(reportInfo ? { reportInfo } : {}) },
    warnings,
  });
  const { buffer, stats } = await styleHwpx(Buffer.from(raw), style);
  return { buffer, stats, warnings };
}
