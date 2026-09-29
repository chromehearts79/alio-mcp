// 비슷한 규정 찾기 품질 벤치 — 실제 ALIO 데이터로 찾기 결과가 기준을 넘는지 확인한다.
//   node bench/related.mjs      (bench/related-cases.json 의 사례마다, 도구 한 번 분량(40초)씩 나눠 끝까지 실행)
// 사례: ① 이름이 제각각인 경영혁신 규정(정답지 15건)이 상위에 모이고 혁신도시·기술혁신 같은 잡음이 없는가
//       ② 같은 제목 규정이 수백 건인 유연근무에서 상위가 모두 유연근무 규정인가
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRelated } from "../src/related.js";
import { loadCatalog } from "../src/catalog.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(await fs.readFile(path.join(here, "related-cases.json"), "utf8"));
let bad = 0;

// 품질만 재도록 전체 규정 목록을 먼저 다 받아 둔다(첫 사용 시 목록 받는 속도는 망에 따라 크게 달라 따로 표시)
{
  const t = Date.now();
  const c = await loadCatalog();
  console.log(`전체 규정 목록 준비: ${c.covered}/${c.orgCount}곳, ${c.rules.length.toLocaleString()}건, ${((Date.now() - t) / 1000).toFixed(0)}초${c.failed.length ? `, 조회 실패 ${c.failed.length}곳` : ""}\n`);
  if (c.missing.length) {
    console.log(`✖ 전체 규정 목록을 받지 못함(${c.missing.length}곳)`);
    process.exit(1);
  }
}

for (const c of cases) {
  const t0 = Date.now();
  let r;
  let calls = 0;
  // 목록·본문이 처음이면 여러 번에 나눠 받는다(도구를 다시 실행하는 것과 같다)
  for (calls = 1; calls <= 12; calls++) {
    r = await findRelated({ rule: { apbaId: c.base.apbaId, idx: c.base.idx }, deadline: Date.now() + 40000, limit: 30 });
    if (!r.catalog.missing.length && !r.unchecked.length) break;
  }
  const top = r.top.slice(0, c.gate.topK);
  const lines = [`■ ${c.name} — 기준 ${c.base.org} 「${c.base.title}」 (${calls}회 호출, ${((Date.now() - t0) / 1000).toFixed(0)}초)`];
  const fails = [];
  if (r.catalog.missing.length || r.unchecked.length) fails.push(`끝까지 처리하지 못함(목록 미수신 ${r.catalog.missing.length}곳, 본문 미확인 ${r.unchecked.length}건)`);
  if (c.truth) {
    const truth = new Set(c.truth.map((t) => `${t.apbaId}|${t.idx}`));
    const hits = top.filter((x) => truth.has(`${x.rule.apbaId}|${x.rule.idx}`)).length;
    const noise = top.filter((x) => c.gate.noise.some((n) => x.rule.title.includes(n)));
    lines.push(`  상위 ${c.gate.topK}에 정답 ${hits}/${truth.size} (기준 ${c.gate.minHitsInTopK} 이상), 잡음 ${noise.length} (기준 ${c.gate.maxNoiseInTopK} 이하)`);
    if (hits < c.gate.minHitsInTopK) fails.push(`정답 ${hits}건 < ${c.gate.minHitsInTopK}`);
    if (noise.length > c.gate.maxNoiseInTopK) fails.push(`잡음: ${noise.map((x) => x.rule.title).join(", ")}`);
    const missed = c.truth.filter((t) => !top.some((x) => x.rule.apbaId === t.apbaId && x.rule.idx === t.idx));
    if (missed.length) lines.push(`  상위 밖 정답: ${missed.map((t) => `${t.org} ${t.title}(${(r.top.findIndex((x) => x.rule.idx === t.idx) + 1 || 0) ? `${r.top.findIndex((x) => x.rule.idx === t.idx) + 1}위` : "상위 30 밖"})`).join(" / ")}`);
  }
  if (c.titlePattern) {
    const re = new RegExp(c.titlePattern);
    const ok = top.filter((x) => re.test(x.rule.title)).length;
    lines.push(`  상위 ${c.gate.topK} 중 제목이 같은 성격 ${ok} (기준 ${c.gate.minTitleMatchInTopK} 이상)`);
    if (ok < c.gate.minTitleMatchInTopK) fails.push(`같은 성격 ${ok}건 < ${c.gate.minTitleMatchInTopK}: ${top.filter((x) => !re.test(x.rule.title)).map((x) => x.rule.title).join(", ")}`);
  }
  lines.push(...top.slice(0, 5).map((x, i) => `  ${i + 1}. ${x.score.toFixed(2)} ${x.rule.org} | ${x.rule.title} | 같은 조항 ${x.body.shared.slice(0, 3).join(", ")}`));
  console.log(lines.join("\n") + (fails.length ? `\n  ✖ ${fails.join(" / ")}` : "\n  ✔ 통과") + "\n");
  if (fails.length) bad++;
}
process.exit(bad ? 1 : 0);
