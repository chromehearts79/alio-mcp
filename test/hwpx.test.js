// 한글 문서 서식 기준 — 오프라인 테스트
import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { markdownToStyledHwpx, HOUSE_STYLE } from "../src/hwpx.js";

const MD = `# 테스트세칙 일부개정안

> 요약 문장

## 개정 이유

- 첫째 항목입니다 English words stay together
  - 둘째 항목

※ 참고 문단입니다

## 신구조문 대비표

| 현 행 | 개 정 안 | 사유·근거 |
| --- | --- | --- |
| 제2조(정의) **기획재정부의** 지침 | 제2조(정의) **재정경제부의** 지침 | 부처명 변경 |
| ※ 표 안 참고 | 같음 | 없음 |

| 구분 | 내용 |
| --- | --- |
| 가 | 나 |
`;

const load = async () => {
  const { buffer, stats } = await markdownToStyledHwpx(MD);
  const zip = await JSZip.loadAsync(buffer);
  return {
    buffer,
    stats,
    header: await zip.file("Contents/header.xml").async("string"),
    sec: await zip.file("Contents/section0.xml").async("string"),
  };
};
const doc = load();

// needle 글자가 들어 있는 run 의 charPr (문단이 여러 run 으로 쪼개져 있어도 찾는다)
function charPrOf(d, needle) {
  const plain = (x) => [...x.matchAll(/<hp:t>([^<]*)/g)].map((m) => m[1]).join("");
  const p = [...d.sec.matchAll(/<hp:p (?:(?!<hp:p )[\s\S])*?<\/hp:p>/g)].map((m) => m[0]).find((x) => plain(x).includes(needle));
  assert.ok(p, `문단 '${needle}' 없음`);
  const runs = [...p.matchAll(/<hp:run charPrIDRef="(\d+)">([\s\S]*?)<\/hp:run>/g)];
  const id = (runs.find((m) => plain(m[2]) && needle.includes(plain(m[2]).trim().slice(0, 2))) || runs.find((m) => plain(m[2])))[1];
  return d.header.match(new RegExp(`<hh:charPr id="${id}"[\\s\\S]*?</hh:charPr>`))[0];
}
const fontId = (d, face) => d.header.match(new RegExp(`<hh:fontface lang="HANGUL"[\\s\\S]*?<hh:font id="(\\d+)" face="${face}"`))[1];

test("mimetype 이 맨 앞·무압축", async () => {
  const { buffer } = await doc;
  assert.equal(buffer.subarray(30, 38).toString(), "mimetype");
  assert.equal(buffer.readUInt16LE(8), 0); // 압축 방식 0 = STORE
});

test("글꼴: 전부 함초롬바탕, ※ 문단은 함초롬돋움", async () => {
  const d = await doc;
  const batang = fontId(d, HOUSE_STYLE.font);
  const dotum = fontId(d, HOUSE_STYLE.refFont);
  assert.match(charPrOf(d, "첫째 항목"), new RegExp(`hangul="${batang}"`));
  assert.match(charPrOf(d, "테스트세칙"), new RegExp(`hangul="${batang}"`));
  assert.match(charPrOf(d, "※"), new RegExp(`fontRef hangul="${dotum}"`));
  assert.match(charPrOf(d, "참고 문단"), new RegExp(`fontRef hangul="${dotum}"`));
  assert.match(charPrOf(d, "표 안 참고"), new RegExp(`fontRef hangul="${dotum}"`));
  assert.match(charPrOf(d, "둘째 항목"), new RegExp(`fontRef hangul="${batang}"`));
  assert.equal(d.stats.ref.length, 2);
});

test("크기: 본문 15pt, 자료표 12pt, 제목은 유지", async () => {
  const d = await doc;
  assert.match(charPrOf(d, "첫째 항목"), /height="1500"/);
  assert.match(charPrOf(d, "둘째 항목"), /height="1500"/);
  assert.match(charPrOf(d, "부처명 변경"), /height="1200"/);
  assert.match(charPrOf(d, "구분"), /height="1200"/);
  assert.doesNotMatch(charPrOf(d, "테스트세칙"), /height="1[25]00"/);
});

test("줄 나눔: 한글 어절(BREAK_WORD)·영어 단어(KEEP_WORD), 왼쪽 정렬 없음", async () => {
  const { header } = await doc;
  assert.doesNotMatch(header, /breakNonLatinWord="KEEP_WORD"/);
  assert.doesNotMatch(header, /breakLatinWord="BREAK_WORD"/);
  assert.doesNotMatch(header, /<hh:align horizontal="LEFT"/);
});

test("신구조문 대비표: 굵게 → 밑줄, 머리행은 그대로, 열 너비 37:37:26", async () => {
  const d = await doc;
  const changed = charPrOf(d, "기획재정부의");
  assert.match(changed, /<hh:underline type="BOTTOM"/);
  assert.doesNotMatch(changed, /bold="1"|<hh:bold\/>/);
  assert.doesNotMatch(charPrOf(d, "현 행"), /<hh:underline type="BOTTOM"/);
  const cmp = d.sec.match(/<hp:tbl [^>]*>(?:(?!<\/hp:tbl>)[\s\S])*?현 행[\s\S]*?<\/hp:tbl>/)[0];
  const w = [...cmp.match(/<hp:tr>[\s\S]*?<\/hp:tr>/)[0].matchAll(/<hp:cellSz width="(\d+)"/g)].map((m) => +m[1]);
  const total = w.reduce((a, b) => a + b, 0);
  assert.deepEqual(w.map((x) => Math.round((x / total) * 100)), [37, 37, 26]);
});

test("자료표 행 높이는 12pt 한 줄보다 크다(글자 잘림 방지)", async () => {
  const { sec } = await doc;
  const tbls = [...sec.matchAll(/<hp:tbl [^>]*rowCnt="([2-9])" colCnt="([2-9])"[\s\S]*?<\/hp:tbl>/g)];
  assert.ok(tbls.length >= 2);
  for (const t of tbls)
    for (const m of t[0].matchAll(/<hp:cellSz width="\d+" height="(\d+)"/g)) assert.ok(+m[1] >= 1200 * 1.3 + 282, `높이 ${m[1]}`);
});
