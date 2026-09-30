import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { markdownToHwpx } from "kordoc";
import { settings, baseTitle, markSuperseded } from "../src/alio-client.js";
import { splitArticles, matchArticles, pickArticles, loadRuleText, articleGaps, excerpt, pickZipEntry, nameDate } from "../src/rule-text.js";

// 실제 규정(kordoc 추출 결과)의 모양을 본뜬 예시
const SAMPLE = `# 복무규정

[시행 2026. 3. 1.] [규정 제700호, 2026. 3. 1. 일부개정]

## 제1장 총 칙

제1조(목적) 이 규정은 직원의 복무에 관한 사항을 정함을 목적으로 한다.

### 제2조(적용범위) 이 규정은 모든 직원에게 적용한다.

## 제2장 근무

### 제1절 근무시간

### 제3조(근무시간) ① 근무시간은 1일 8시간으로 한다.

② 사장은 유연 근무제를 운영할 수 있다. <개정 2026. 3. 1.>

4. 제59조의 규정에 의하여 명예퇴직하는 자

제3조의 2(시차출퇴근) 직원은 시차출퇴근을 신청할 수 있다.

제4조 삭제 <2020. 1. 1.>

### 제5조(징계) 직장 내 괴롭힘을 한 직원은 징계한다.

부 칙

제1조(시행일) 이 규정은 2020년 1월 1일부터 시행한다.

부 칙 <2026. 3. 1.>

이 규정은 2026년 3월 1일부터 시행한다.

## [별표 1] 근무형태별 <b>근무시간</b>

<table><tr><td>시차출퇴근</td><td>07~10시 출근</td></tr></table>
`;

test("조문 분할: 번호·제목·장절·조의N·삭제 조문을 인식한다", () => {
  const u = splitArticles(SAMPLE);
  const arts = u.filter((x) => x.kind === "조문");
  assert.deepEqual(
    arts.map((a) => a.no),
    ["제1조", "제2조", "제3조", "제3조의2", "제4조", "제5조"]
  );
  assert.equal(arts[2].title, "근무시간");
  assert.equal(arts[2].part, "제2장 근무 > 제1절 근무시간");
  assert.equal(arts[0].part, "제1장 총 칙");
  assert.equal(arts[4].title, "");
});

test("조문 분할: 본문 속 인용(제59조의 규정에 의하여)은 새 조문으로 보지 않는다", () => {
  const art3 = splitArticles(SAMPLE).find((x) => x.no === "제3조");
  assert.match(art3.text, /유연 근무제/);
  assert.match(art3.text, /제59조의 규정에 의하여/);
});

test("조문 분할: 부칙 안의 제1조는 본문 조문과 섞이지 않고, 부칙은 날짜로 구분", () => {
  const u = splitArticles(SAMPLE);
  assert.equal(u.filter((x) => x.no === "제1조").length, 1);
  assert.deepEqual(
    u.filter((x) => x.kind === "부칙").map((x) => x.no),
    ["부칙(2020.1.1)", "부칙(2026.3.1)"]
  );
});

test("조문 분할: 별표를 따로 떼고 머리(제목·시행일)를 보존", () => {
  const u = splitArticles(SAMPLE);
  const annex = u.find((x) => x.kind === "별표");
  assert.equal(annex.no, "[별표 1]");
  assert.match(annex.text, /07~10시/);
  assert.match(u[0].text, /시행 2026\. 3\. 1\./);
});

test("조문 분할: 조문 구조가 없는 안내서형 지침은 로마숫자 제목 단위 구간으로", () => {
  const md = "복무 사용 및 적용지침\n\n| Ⅰ |  | 개 요 |\n\n목적: 복무 운영 지원\n\n| Ⅲ |  | 유연근무제 |\n\n시차출퇴근은 07~10시 출근\n\n부 칙(2025.12.1)\n\n이 지침은 공포한 날부터 시행한다.";
  const u = splitArticles(md);
  assert.deepEqual(u.map((x) => x.kind), ["구간", "구간", "구간", "부칙"]);
  assert.equal(u[2].title, "Ⅲ 유연근무제");
  assert.deepEqual(matchArticles(u, "시차출퇴근").map((x) => x.no), ["구간3"]);
  assert.equal(u[3].no, "부칙(2025.12.1)");
});

// 실제 기관 파일 45건 점검에서 발견한 표기들
test("실사례: '부 칙(2009.9.24)'처럼 괄호가 붙은 부칙 — 부칙 속 제1조가 본문 조문으로 섞이지 않는다", () => {
  const md = "제1조(목적) 목적\n\n제2조(정의) 정의\n\n부 칙(2009.9.24)\n\n### 제1조(시행일) 시행한다.\n\n부 칙('06.7.31)\n\n제1조(시행일) 시행한다.\n\n### 부 칙(개정 `24. 12. 20.)\n\n시행한다.";
  const u = splitArticles(md);
  assert.deepEqual(u.filter((x) => x.kind === "조문").map((x) => x.no), ["제1조", "제2조"]);
  assert.deepEqual(u.filter((x) => x.kind === "부칙").map((x) => x.no), ["부칙(2009.9.24)", "부칙(2006.7.31)", "부칙(2024.12.20)"]);
});

test("실사례: PDF 앞머리 목차 줄(···)을 부칙·조문으로 오인하지 않는다", () => {
  const md = "목 차\n\n제1조목적 ··········· 1\n\n제 13 조 유급휴일 ········ 3\n\n부 칙 ··················· 9\n\n제1조 (목적) 이 규정은 복무를 정한다.\n\n제2조 (적용 범위) 전 직원\n\n부 칙(제정 `20. 10. 22.)\n\n시행한다.";
  const u = splitArticles(md);
  assert.deepEqual(u.filter((x) => x.kind === "조문").map((x) => x.no), ["제1조", "제2조"]);
  assert.equal(u.filter((x) => x.kind === "부칙").length, 1);
});

test("실사례: 탭+쪽번호 목차(kordoc 4.16 PDF 추출)의 '제 60 조삭제 ⇥ 15'를 조문으로 오인하지 않는다", () => {
  // 목차의 삭제 조문이 첫 조문으로 잡히면, 번호가 커지는 것만 조문으로 보는 규칙 때문에 본문 제1조~가 모두 인용 처리된다
  const md =
    "목\t차\n\n제1조목적 \t 5 제2조 적용범위 \t 5 제2장복무\n\n제 13 조 유급휴일 \t 6 제4장 휴가 및 휴직\n\n제 60 조삭제 \t 15\n\n부 칙 \t 15\n\n" +
    "제1조 (목적) 이 규정은 복무를 정한다.\n\n제2조 (적용범위) 전 직원\n\n제60조 삭제\n\n부 칙(제정 ’12. 12. 31)\n\n시행한다.";
  const u = splitArticles(md);
  assert.deepEqual(u.filter((x) => x.kind === "조문").map((x) => x.no), ["제1조", "제2조", "제60조"]);
  assert.equal(u.filter((x) => x.kind === "부칙").length, 1);
});

test("조문 번호 뒤 탭 '제22조\\t(목적)'이나 본문 속 탭은 목차로 보지 않는다", () => {
  const u = splitArticles("제22조\t(목적) 이 규정은 …\n\n(예 : 육아휴직\t) 중인 자").filter((x) => x.kind === "조문");
  assert.deepEqual(u.map((x) => x.no), ["제22조"]);
  assert.match(u[0].text, /육아휴직/);
});

test("실사례: 줄바꿈으로 줄 머리에 온 인용 '제10조(징계)에 따라'는 앞 조문 내용으로 둔다", () => {
  const md = "제39조(포상) ① 다음의 경우\n\n제10조(징계)에 따라 감경할 수 있다.\n\n제40조(보칙) 끝";
  const u = splitArticles(md).filter((x) => x.kind === "조문");
  assert.deepEqual(u.map((x) => x.no), ["제39조", "제40조"]);
  assert.match(u[0].text, /제10조\(징계\)에 따라/);
});

test("실사례: 탭이 끼거나 띄어 쓴 조문 번호 '제22조\\t(…)', '제 1 조(…)', '제22조의 2(…)'", () => {
  const u = splitArticles("제 1 조(목적) a\n\n제22조\t(연차휴가의 허가) b\n\n제22조의 2(연속 연가) c").filter((x) => x.kind === "조문");
  assert.deepEqual(u.map((x) => x.no), ["제1조", "제22조", "제22조의2"]);
  assert.equal(u[1].title, "연차휴가의 허가");
});

test("실사례: 붙여 쓴 장 제목 '제6장유연근무'를 인식하고, 장으로 시작하는 문장은 장 제목으로 보지 않는다", () => {
  const md = "## 제4장 휴일 및 휴가\n\n제17조(외부강의) a\n\n제6장유연근무\n\n제18조(유연근무) b\n\n제2장의 규정에 따라 처리한다.\n\n제7장기타사항\n\n제19조(위임) c";
  const u = splitArticles(md).filter((x) => x.kind === "조문");
  assert.deepEqual(u.map((x) => [x.no, x.part]), [["제17조", "제4장 휴일 및 휴가"], ["제18조", "제6장유연근무"], ["제19조", "제7장기타사항"]]);
  assert.doesNotMatch(u[0].text, /제6장/);
  assert.match(u[1].text, /제2장의 규정에 따라/);
});

test("실사례: '<별지 제1호 서식>', '【별표 2】' 표기도 별표로 떼어내고 번호로 고른다", () => {
  const md = "제1조(목적) a\n\n부 칙(2025. 11. 28.)\n\n① (시행일) 시행한다.\n\n<별지 제1호 서식> (개정 2014. 2. 4)\n\n결근계\n\n<별지 제10호 서식>\n\n재택근무신청서\n\n【별표 2】 수당표\n\n표";
  const u = splitArticles(md);
  assert.deepEqual(u.filter((x) => x.kind === "별표").map((x) => x.no), ["<별지 제1호 서식>", "<별지 제10호 서식>", "【별표 2】"]);
  assert.doesNotMatch(u.find((x) => x.kind === "부칙").text, /결근계/);
  assert.deepEqual(pickArticles(u, ["별지 1"]).picked.map((x) => x.no), ["<별지 제1호 서식>"]);
  assert.deepEqual(pickArticles(u, ["별지 10"]).picked.map((x) => x.no), ["<별지 제10호 서식>"]);
  assert.deepEqual(pickArticles(u, ["별표 2"]).picked.map((x) => x.no), ["【별표 2】"]);
});

test("실사례: 둥근 괄호 별표 '(별표 1) 프로젝트 구분'을 부칙에서 떼어내고, '(별표 1)에 따른' 인용은 그대로 둔다", () => {
  const md = "제1조(목적) a\n\n(별표 1)에 따른 과제를 수행한다.\n\n부칙(2023.09.15)\n\n① 이 기준은 공포한 날로부터 시행한다.\n\n(별표 1) 프로젝트 구분 (2012.5.16. 개정)\n\n과제 종류 표\n\n(별표 12) 제안심사절차\n\n절차도";
  const u = splitArticles(md);
  assert.deepEqual(u.filter((x) => x.kind === "별표").map((x) => x.no), ["(별표 1)", "(별표 12)"]);
  assert.match(u.find((x) => x.no === "제1조").text, /\(별표 1\)에 따른/);
  assert.doesNotMatch(u.find((x) => x.kind === "부칙").text, /프로젝트 구분/);
  assert.deepEqual(pickArticles(u, ["별표 1"]).picked.map((x) => x.no), ["(별표 1)"]);
});

test("실사례: 별표 제목이 조사처럼 보이는 글자로 시작해도('(별표 7) 과제 중단') 별표로 떼어낸다", () => {
  const md = "제1조(목적) a\n\n(별표 6) 회의체 운영\n\n표\n\n(별표 7) 과제 중단 프로세스\n\n흐름도\n\n[별표8]수당표\n\n표\n\n[별표 9]와 같이 정한다.";
  const u = splitArticles(md).filter((x) => x.kind === "별표");
  assert.deepEqual(u.map((x) => x.no), ["(별표 6)", "(별표 7)", "[별표8]"]);
  assert.match(u[2].text, /\[별표 9\]와 같이/);
});

test("실사례: 앞 문장에 붙은 다음 조문의 본문이 '이 규정은'처럼 띄어 쓴 '이'로 시작해도 나눈다", () => {
  const md = "제1조(목적) 목적으로 한다. 제2조(적용범위) 이 규정은 전 직원에게 적용한다.\n\n제3조(정의) 제4조(감경)이 정한 바에 따른다.\n\n제4조(감경) 끝";
  const u = splitArticles(md).filter((x) => x.kind === "조문");
  assert.deepEqual(u.map((x) => x.no), ["제1조", "제2조", "제3조", "제4조"]);
  assert.match(u[1].text, /^제2조\(적용범위\) 이 규정은/);
});

test("검색 결과 발췌: 긴 조문은 검색어 주변을 보여준다", () => {
  const long = "① (시행일) 이 규정은 시행한다.\n" + "가".repeat(2000) + "\n② 재택 근무에 관한 경과조치는 따로 정한다.\n" + "나".repeat(500);
  const e = excerpt(long, "재택근무", 400);
  assert.match(e, /재택 근무에 관한 경과조치/);
  assert.match(e, /^① \(시행일\)/);
  assert.match(e, /중략/);
  assert.equal(excerpt("짧은 조문", "없음", 400), "짧은 조문");
  assert.match(excerpt("재택근무 " + "다".repeat(900), "재택근무", 400), /^재택근무/);
});

test("실사례: '제12조 <삭제 2005.11.29.>'를 삭제 조문으로 인식", () => {
  const u = splitArticles("제11조(가) a\n\n제12조 <삭제 2005.11.29.>\n\n제13조(나) b").filter((x) => x.kind === "조문");
  assert.deepEqual(u.map((x) => x.no), ["제11조", "제12조", "제13조"]);
});

test("실사례: PDF에서 앞 문장에 이어 붙은 '…책정한다. 제 11 조 (적용예외) …'를 나눈다", () => {
  const md = "제10조(연봉) 연봉은 따로 책정한다. 제 11 조 (적용예외) 원장은 필요한 경우 연봉으로 책정할 수 있다.\n\n제12조(보칙) 끝";
  const u = splitArticles(md).filter((x) => x.kind === "조문");
  assert.deepEqual(u.map((x) => [x.no, x.title]), [["제10조", "연봉"], ["제11조", "적용예외"], ["제12조", "보칙"]]);
});

test("문장 속 인용은 이어 붙어 있어도 나누지 않는다 (다음 번호가 아니거나 문장 끝이 아님)", () => {
  const md = "제10조(징계) 제11조(감경)에 따라 감경한다. 제30조(포상)를 준용한다.\n\n제11조(감경) 끝";
  const u = splitArticles(md).filter((x) => x.kind === "조문");
  assert.deepEqual(u.map((x) => x.no), ["제10조", "제11조"]);
  assert.match(u[0].text, /제30조\(포상\)를 준용/);
});

test("압축 파일: 개정 이력이 함께 든 ZIP에서 현행본 하나만 고른다 (국민연금공단 보수규정 실사례)", () => {
  const names = [
    "보수규정(2021년도 12월 개정).hwp",
    "보수규정(2025년도 12월 30일 개정).hwp",
    "보수규정(2026년도 3월 6일 개정).hwp",
    "보수규정(2025년도 9월 개정).hwp",
  ];
  assert.equal(pickZipEntry("보수규정(2026년도 3월 6일 개정).zip", names), "보수규정(2026년도 3월 6일 개정).hwp");
  assert.equal(pickZipEntry("묶음.zip", names), "보수규정(2026년도 3월 6일 개정).hwp");
  assert.equal(pickZipEntry("묶음.zip", ["인사규정.hwp", "보수규정.hwp"]), null);
  assert.equal(pickZipEntry("a.zip", ["단일.pdf"]), "단일.pdf");
  assert.equal(nameDate("인사규정(22년 10월 개정).hwp"), 20221000);
  assert.equal(nameDate("복무규정 개정(20251114).hwp"), 20251114);
});

test("실사례: 밑줄 표시된 개정 조문 '<u>제2조(정의) …</u>'도 조문으로 인식", () => {
  const u = splitArticles("제1조(목적) a\n\n<u>제2조(정의) 용어의 정의</u>\n\n<u>② “실험동물”이란 ｢동물보호법｣ 제2조제1호</u>\n\n제3조(구성) c").filter((x) => x.kind === "조문");
  assert.deepEqual(u.map((x) => x.no), ["제1조", "제2조", "제3조"]);
  assert.doesNotMatch(u[1].text, /<u>/);
});

test("조문 번호 누락 감지", () => {
  const u = splitArticles("제1조(가) a\n\n제2조(나) b\n\n제5조(다) c");
  assert.deepEqual(articleGaps(u), ["제3조", "제4조"]);
  assert.deepEqual(articleGaps(splitArticles(SAMPLE)), []);
});

test("본문 검색: 띄어쓰기 무시, 공백=AND, |=OR, HTML 태그 무시", () => {
  const u = splitArticles(SAMPLE);
  const nos = (q) => matchArticles(u, q).map((x) => x.no);
  assert.deepEqual(nos("유연근무제"), ["제3조"]);
  assert.deepEqual(nos("직장내괴롭힘"), ["제5조"]);
  assert.deepEqual(nos("유연근무|시차출퇴근"), ["제3조", "제3조의2", "[별표 1]"]);
  assert.deepEqual(nos("근무시간 시차출퇴근"), ["[별표 1]"]);
  assert.deepEqual(nos("없는말"), []);
  assert.deepEqual(nos("   "), []);
});

test("조문 선택: 여러 표기와 없는 조문 보고", () => {
  const u = splitArticles(SAMPLE);
  const { picked, missing } = pickArticles(u, ["제3조의2", "3조의 2", "5", "부칙", "별표 1", "제99조"]);
  assert.deepEqual(
    picked.map((x) => x.no),
    ["제3조의2", "제5조", "부칙(2020.1.1)", "부칙(2026.3.1)", "[별표 1]"]
  );
  assert.deepEqual(missing, ["제99조"]);
});

test("규정명 비교: 날짜 괄호·분류번호만 떼고 내용 괄호는 남긴다", () => {
  assert.equal(baseTitle("복무규정 (201228)"), "복무규정");
  assert.equal(baseTitle("인사규정(2019년 9월 개정)"), "인사규정");
  assert.equal(baseTitle("4-3. 복무규칙"), "복무규칙");
  assert.equal(baseTitle("0503 복무규정"), "복무규정");
  assert.equal(baseTitle("지-56 연구소 휴직자 복무관리 지침"), "연구소휴직자복무관리지침");
  assert.equal(baseTitle("인사규정(계약직)"), "인사규정(계약직)");
  // 해마다 새 판으로 올라오는 편람·지침: 연도를 떼어 같은 규정의 판으로 본다(연도가 분류번호로 잘려 '년…'이 남지 않게)
  assert.equal(baseTitle("2024년 경영평가 지침"), "경영평가지침");
  assert.equal(baseTitle("2023년도 국민체육진흥기금 지원사업 성과평가 편람"), "국민체육진흥기금지원사업성과평가편람");
  assert.equal(baseTitle("1-업무성과평가규정(190808)"), "업무성과평가규정");
  assert.equal(baseTitle("119구급대 운영규정"), "119구급대운영규정");
});

test("실사례: 연도만 다른 판(서울올림픽기념국민체육진흥공단 성과평가 편람)은 가장 늦은 판만 현행으로 본다", () => {
  const r = (idx, title, enfDate) => ({ apbaId: "C0029", idx, title, enfDate });
  const marked = markSuperseded([
    r("52110", "2024년도 국민체육진흥기금 지원사업 성과평가 편람", "2024.04.17"),
    r("51444", "2023년도 국민체육진흥기금 지원사업 성과평가 편람", "2023.03.16"),
    r("44912", "2021년도 기금지원사업 성과평가 편람", "2021.04.09"),
    r("39051", "1-업무성과평가규정(190808)", "2019.08.08"),
    r("44276", "업무성과평가규정(210331)", "2021.03.31"),
  ]);
  assert.deepEqual(marked.filter((x) => !x.superseded).map((x) => x.idx), ["52110", "44912", "44276"]);
});

test("실사례: 같은 기관에 같은 이름으로 올라온 옛 버전(육아정책연구소 복무규정 5건)은 최신 1건만 남긴다", () => {
  const r = (idx, title, enfDate, apbaId = "C0440") => ({ apbaId, idx, title, enfDate });
  const marked = markSuperseded([
    r("45517", "복무규정", "2025.11.28"),
    r("43771", "복무규정 (201228)", "2020.12.28"),
    r("30642", "복무규정", "2016.12.30"),
    r("13354", "4-3. 복무규칙", "2015.12.03"),
    r("99999", "복무규정", "2010.01.01", "C0001"),
  ]);
  assert.deepEqual(marked.filter((x) => !x.superseded).map((x) => x.idx), ["45517", "13354", "99999"]);
  assert.equal(marked[1].latestIdx, "45517");
});

// ---- 전체 과정: 상세페이지 → 현행본 다운로드 → 본문 추출 → 캐시 ----
const fx = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const detailHtml = await fs.readFile(path.join(fx, "detail_C0105_21892.html"), "utf8");
const hwpx = Buffer.from(await markdownToHwpx(SAMPLE));

const realFetch = globalThis.fetch;
let downloads;
let fileBytes;
let html;
let cacheDir;

beforeEach(async () => {
  settings.delayMs = 0;
  settings.retryBaseMs = 0;
  downloads = [];
  fileBytes = hwpx;
  html = detailHtml;
  cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "alio-cache-"));
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/item/itemBoard21110.do")) return new Response(html, { headers: { "content-type": "text/html" } });
    if (u.includes("/download/rulefiledown.json")) {
      downloads.push(new URL(u).searchParams.get("fileNo"));
      return new Response(fileBytes, { headers: { "content-type": "application/haansofthwp" } });
    }
    return new Response("x", { status: 404 });
  };
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  await fs.rm(cacheDir, { recursive: true, force: true });
});

const rule = { apbaId: "C0105", idx: "21892", category: "K1100", org: "테스트기관", title: "복무규정" };

test("본문 읽기: 현행본(가장 나중 fileNo)을 받아 조문으로 나눈다", async () => {
  const doc = await loadRuleText(rule, { cacheDir });
  assert.deepEqual(downloads, ["218027"]);
  assert.equal(doc.cached, false);
  assert.equal(doc.fileType, "hwpx");
  assert.ok(doc.units.some((u) => u.no === "제3조의2"));
  assert.deepEqual(matchArticles(doc.units, "직장내괴롭힘").map((u) => u.no), ["제5조"]);
});

test("본문 읽기: 두 번째는 캐시에서 읽고 다시 받지 않는다", async () => {
  await loadRuleText(rule, { cacheDir });
  const again = await loadRuleText(rule, { cacheDir });
  assert.equal(again.cached, true);
  assert.deepEqual(downloads, ["218027"]);
});

test("본문 읽기: 새 개정본(fileNo)이 올라오면 캐시를 쓰지 않고 새로 읽는다", async () => {
  await loadRuleText(rule, { cacheDir });
  html = detailHtml.replace("</body>", `<a href="/download/rulefiledown.json?fileNo=230001">인사규정(26년 3월 개정).hwpx</a></body>`);
  const doc = await loadRuleText(rule, { cacheDir });
  assert.equal(doc.cached, false);
  assert.deepEqual(downloads, ["218027", "230001"]);
});

test("실사례: 수정일이 같으면 느린 상세 페이지(건당 약 1.5초)를 다시 열지 않는다", async () => {
  let detail = 0;
  const base = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/item/itemBoard21110.do")) detail++;
    return base(url, init);
  };
  const r = { ...rule, modDate: "2025.07.01", enfDate: "2025.06.26" };
  await loadRuleText(r, { cacheDir });
  const again = await loadRuleText(r, { cacheDir });
  assert.equal(again.cached, true);
  assert.equal(detail, 1, "수정일이 같은데 상세 페이지를 다시 열었음");

  await loadRuleText({ ...r, modDate: "2026.03.10" }, { cacheDir });
  assert.equal(detail, 2, "수정일이 바뀌었는데 상세 페이지를 확인하지 않았음");

  await loadRuleText(rule, { cacheDir });
  assert.equal(detail, 3, "수정일을 모르는 호출은 항상 확인해야 함");
});

test("첨부 목록 캐시도 기간이 지나면 다시 확인한다", async () => {
  let detail = 0;
  const base = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/item/itemBoard21110.do")) detail++;
    return base(url, init);
  };
  const r = { ...rule, modDate: "2025.07.01", enfDate: "2025.06.26" };
  const keep = settings.fileListCacheMs;
  try {
    await loadRuleText(r, { cacheDir });
    settings.fileListCacheMs = 0;
    await loadRuleText(r, { cacheDir });
    assert.equal(detail, 2);
  } finally {
    settings.fileListCacheMs = keep;
  }
});

test("본문 읽기: 해석할 수 없는 파일은 PARSE 오류", async () => {
  fileBytes = Buffer.from("이건 한글 파일이 아님");
  await assert.rejects(loadRuleText(rule, { cacheDir }), (e) => e.kind === "PARSE");
});

test("본문 읽기: 첨부가 없으면 NO_FILE 오류", async () => {
  html = "<html><body>첨부 없음</body></html>";
  await assert.rejects(loadRuleText(rule, { cacheDir }), (e) => e.kind === "NO_FILE");
});
