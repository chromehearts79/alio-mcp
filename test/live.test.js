// 실서버 점검: ALIO 사이트 구조가 바뀌었는지 확인. `npm run test:live` 로만 실행.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listOrgs, searchRules, getRuleFiles, pickLatestFile } from "../src/alio-client.js";
import { loadRuleText } from "../src/rule-text.js";

test("실서버: 기관 목록 → 전체 페이지 검색 → 첨부파일 해석", async () => {
  const orgs = await listOrgs();
  assert.ok(orgs.length > 300, `기관 수 ${orgs.length}`);

  const incheon = orgs.find((o) => o.apbaId === "C0105");
  assert.ok(incheon, "인천국제공항공사(C0105) 없음");

  const rules = await searchRules(incheon);
  assert.ok(rules.length > 10, `규정 ${rules.length}건 — 10건 이하면 페이지네이션 이상`);

  const hr = rules.find((r) => r.title === "인사규정");
  assert.ok(hr, "인사규정 없음");
  const files = await getRuleFiles(hr);
  assert.ok(files.length >= 7, `첨부 ${files.length}개`);
  assert.ok(files.every((f) => /^\d+$/.test(f.fileNo) && f.fileName), "번호/파일명 누락");
  assert.ok(Number(pickLatestFile(files).fileNo) >= 218027);

  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "alio-live-"));
  const doc = await loadRuleText(hr, { cacheDir });
  const arts = doc.units.filter((u) => u.kind === "조문");
  assert.ok(arts.length >= 70, `조문 ${arts.length}개 — 본문 추출·분할 이상`);
  assert.equal(arts[0].no, "제1조");
  assert.deepEqual(doc.warnings, []);
  await fs.rm(cacheDir, { recursive: true, force: true });
});

test("실서버: 「공공기관의 혁신에 관한 지침」 목록·현행본 해석", async () => {
  const { listGuidelineVersions, loadGuidelineVersion } = await import("../src/guideline.js");
  const vs = await listGuidelineVersions({ force: true });
  assert.ok(vs.length >= 13, `버전 ${vs.length}개`);
  assert.ok(vs[0].revDate >= "2026-07-31", `현행 ${vs[0].revDate}`);
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "alio-live-g-"));
  const doc = await loadGuidelineVersion(vs[0], { cacheDir });
  const arts = doc.units.filter((u) => u.kind === "조문");
  assert.ok(arts.length >= 50, `조문 ${arts.length}개`);
  assert.ok(arts.some((u) => u.no === "제11조" && /혁신포털/.test(u.title)));
  await fs.rm(cacheDir, { recursive: true, force: true });
});
