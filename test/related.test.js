// 비슷한 규정 찾기 — 분야 분류·제목 점수·조문 비교(오프라인). 실제 ALIO 제목으로 확인한 판정을 고정한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GROUPS, classifyTitle, titleScore, coreTitle, normTitle, hostFamilies, anchorQuery } from "../src/thesaurus.js";
import { signature, overlap, fieldCoverage, hostRules } from "../src/related.js";

const ids = (t) => classifyTitle(t).map((m) => `${m.group.id}:${m.level}`);
const scoreFor = (base, cand) => titleScore(cand, classifyTitle(base), coreTitle(base)).score;

test("분야 분류: 이름이 달라도 같은 경영혁신 규정으로 잡는다", () => {
  for (const t of ["열린경영혁신추진세칙", "혁신경영 실행지침", "변화혁신위원회규정", "ESG경영혁신위원회 운영지침", "조직문화 개선 및 경영혁신 촉진에 관한 규정"])
    assert.deepEqual(ids(t).filter((x) => x.startsWith("혁신")), ["혁신:strong"], t);
});

test("분야 분류: '혁신'이 들어가도 다른 성격이면 경영혁신이 아니다", () => {
  for (const t of ["혁신도시 지역기업 우대기준", "디지털혁신위원회 운영기준", "기술혁신사업 보안규칙", "혁신성장산업 등 영위기업에 대한 보증운용기준"])
    assert.ok(!ids(t).some((x) => x.startsWith("혁신:")), t);
  assert.deepEqual(ids("규제혁신위원회 운영규정"), ["규제:strong"]);
  assert.ok(ids("혁신제안제도 운영지침").includes("제안:strong"));
});

test("분야 분류: 취업규칙을 '취업규정'으로 부르는 기관(21곳)도 복무 규정으로 잡는다", () => {
  assert.ok(ids("취업규정").includes("복무:strong"));
  assert.ok(ids("국방기술진흥연구소 취업규정").includes("복무:strong"));
});

test("분야 분류: '윤리규정'은 윤리 규정이지만 '연구윤리규정'은 아니다", () => {
  assert.ok(ids("교직원윤리규정").includes("윤리:strong"));
  assert.ok(ids("윤리규정행동세칙").includes("윤리:strong"));
  assert.ok(!ids("연구윤리규정").some((x) => x.startsWith("윤리:")));
  assert.ok(!ids("학술연구지 연구윤리규정").some((x) => x.startsWith("윤리:")));
});

test("분야 분류: 애매한 제목은 약하게(본문으로 가림)", () => {
  assert.ok(ids("혁신요령").includes("혁신:weak"));
  assert.ok(ids("환자경험혁신위원회규정").includes("혁신:weak"));
});

test("제목 점수: 기준과 같은 낱말 > 같은 분야 다른 낱말 > 약한 낱말", () => {
  const base = "유연근무제 운영지침";
  assert.equal(scoreFor(base, "유연근무제 운영규칙"), 1);
  assert.equal(scoreFor(base, "복무규정"), 0.8);
  assert.equal(scoreFor(base, "근무혁신 운영지침"), 0.5);
  assert.equal(scoreFor(base, "보수규정"), 0);
});

test("제목 점수: 사전에 없는 분야는 제목 핵심 말로 찾는다", () => {
  assert.equal(coreTitle("4-61 드론 운영지침(2025년도 6월 개정)"), "드론");
  assert.equal(scoreFor("드론 운영지침", "드론 운영 및 관리규정"), 0.9);
  assert.equal(normTitle("4-61 혁신제안제도 운영지침(2025년 개정)"), "혁신제안제도운영지침");
});

test("담는 규정: 제목에 분야 낱말이 없어도 그 분야 조항을 담을 만한 규정을 고르고, 이미 제목 후보인 규정·계약 서류는 뺀다", () => {
  const g = GROUPS.find((x) => x.id === "혁신");
  assert.deepEqual(hostFamilies(g, "성과관리규정"), ["성과관리·경영평가"]);
  assert.deepEqual(hostFamilies(g, "혁신제안제도 운영지침"), ["제안제도"]); // '혁신제안'은 경영혁신 제목이 아님
  assert.deepEqual(hostFamilies(g, "경영관리규정"), ["경영계획·경영관리"]);
  assert.deepEqual(hostFamilies(g, "ESG경영위원회 운영규정"), []); // 측정: ESG 규정 134건 중 경영혁신 조항 0건
  assert.deepEqual(hostFamilies(g, "경영혁신규정"), []); // 제목 후보에서 봄
  assert.deepEqual(hostFamilies(g, "제안서 평가위원회 운영규정"), []);
  assert.deepEqual(hostFamilies(g, "복무규정"), []);
  assert.deepEqual(hostFamilies(GROUPS.find((x) => x.id === "복무"), "성과관리규정"), []); // 기준이 없는 분야
  assert.equal(anchorQuery(g), g.body.anchors.join("|"));
  // 측정 근거 없이 값만 넣지 않는다
  for (const x of GROUPS.filter((x) => x.body)) assert.ok(x.body.anchors.length && x.body.measured && !/대기/.test(x.body.measured), x.name);
});

test("담는 규정: 제목 형태(보수 본규정만)와 '제목 규정이 없는 기관만' 조건", () => {
  const g = GROUPS.find((x) => x.id === "임원보수");
  assert.deepEqual(hostFamilies(g, "보수규정"), ["보수 본규정"]);
  assert.deepEqual(hostFamilies(g, "국립암센터 보수규정"), ["보수 본규정"]);
  assert.deepEqual(hostFamilies(g, "연봉규정"), ["보수 본규정"]);
  assert.deepEqual(hostFamilies(g, "보수규정 시행세칙"), []); // 측정: 시행세칙·지침은 4%
  assert.deepEqual(hostFamilies(g, "임금피크제 운영규정"), []);
  assert.deepEqual(hostFamilies(g, "임원보수규정"), []); // 제목 후보
  const r = (apbaId, title) => ({ apbaId, title, superseded: false });
  const rules = [r("A", "보수규정"), r("A", "임원보수규정"), r("B", "보수규정"), r("C", "보수규정 시행세칙")];
  assert.deepEqual(hostRules(rules, g).map((x) => x.apbaId), ["B"]); // A 는 전용 임원보수규정이 있음
});

test("담는 규정: 측정한 분야별 대표 사례", () => {
  const g = (id) => GROUPS.find((x) => x.id === id);
  assert.deepEqual(hostFamilies(g("적극행정"), "감사규정"), ["감사 본규정"]);
  assert.deepEqual(hostFamilies(g("적극행정"), "자체감사규정"), ["감사 본규정"]);
  assert.deepEqual(hostFamilies(g("적극행정"), "인사규정"), ["인사 본규정"]);
  assert.deepEqual(hostFamilies(g("적극행정"), "일상감사 시행지침"), []); // 시행지침은 20%라 뺌
  assert.deepEqual(hostFamilies(g("적극행정"), "적극행정 면책제도 운영규정"), []); // 제목 후보
  assert.deepEqual(hostFamilies(g("제안"), "지식경영시스템 운영지침"), ["지식경영"]);
  assert.deepEqual(hostFamilies(g("제안"), "포상규정"), []); // 1%라 뺌
  assert.deepEqual(hostFamilies(g("규제"), "제규정관리규정"), ["내규관리"]);
  assert.equal(g("적극행정").body.uncoveredOnly, true);
  assert.ok(!g("규제").body.uncoveredOnly); // 있는 기관의 내규관리 규제심사 조항도 비교 자료
});

test("제목 규정 보유 현황: 강한 낱말 제목의 현행 규정이 있는 기관만 센다(옛 버전·약한 낱말·다른 유형 제외)", () => {
  const g = GROUPS.find((x) => x.id === "복무");
  const r = (apbaId, org, title, type = "공기업", superseded = false) => ({ apbaId, org, title, type, superseded });
  const rules = [
    r("A", "가공사", "복무규정"),
    r("B", "나공단", "인사규정"),
    r("B", "나공단", "복무규정", "공기업", true), // 옛 버전만 있음
    r("C", "다재단", "직원근무규정"), // '근무'는 약한 낱말
    r("D", "라연구원", "복무규정", "기타공공기관"),
  ];
  assert.deepEqual(fieldCoverage(rules, g), { group: g, orgs: 2, total: 4, lacking: ["나공단", "다재단"] });
  assert.deepEqual(fieldCoverage(rules, g, { orgType: "공기업" }).lacking, ["나공단", "다재단"]);
  assert.equal(fieldCoverage(rules, g, { orgType: "공기업" }).total, 3);
});

const units = (...titles) => titles.map((title) => ({ kind: "조문", title }));

test("조문 비교: 흔한 조문(목적·정의·시행일)은 빼고, 조사가 달라도 같은 주제 조문을 짝짓는다", () => {
  const base = signature(units("목적", "용어의 정의", "혁신 전략 및 계획 수립", "열린경영혁신위원회 설치·운영", "혁신책임관 및 총괄부서 등 지정", "준용규정 등"));
  assert.deepEqual(base.map((b) => b.title), ["혁신 전략 및 계획 수립", "열린경영혁신위원회 설치·운영", "혁신책임관 및 총괄부서 등 지정"]);
  const cand = signature(units("목적", "정의", "혁신계획의 수립", "혁신경영위원회의 설치", "포상"));
  const o = overlap(base, cand);
  assert.deepEqual(o.shared, ["혁신 전략 및 계획 수립", "열린경영혁신위원회 설치·운영"]);
  assert.equal(o.score, 2 / 3);
});

test("조문 비교: 성격이 다른 규정은 겹치지 않는다", () => {
  const base = signature(units("혁신 전략 및 계획 수립", "열린경영혁신위원회 설치·운영", "혁신 교육 실시"));
  const other = signature(units("우대기준", "지역기업의 범위", "가점 부여", "위원회의 구성"));
  assert.equal(overlap(base, other).score, 0);
});
