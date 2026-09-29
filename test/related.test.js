// 비슷한 규정 찾기 — 분야 분류·제목 점수·조문 비교(오프라인). 실제 ALIO 제목으로 확인한 판정을 고정한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTitle, titleScore, coreTitle, normTitle } from "../src/thesaurus.js";
import { signature, overlap } from "../src/related.js";

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
