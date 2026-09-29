// 내규 조문 분할 회귀 벤치 — 실제 ALIO 내규로 본문 추출·조문 분할이 기준과 같은지 확인한다.
//
//   node bench/run.mjs            기준(bench/corpus.json)과 비교. 달라진 규정이 있거나 ALIO 응답 구조가 바뀌면 exit 1
//   node bench/run.mjs --update   원문이 개정된 규정의 기준을 새 현행본으로 갱신
//   node bench/run.mjs --accept   달라진 결과까지 새 기준으로 받아들임(분할 규칙을 일부러 고쳤을 때만)
//
// 기준에는 원문을 넣지 않는다(재배포 금지). 규정 식별자·현행 파일번호·조문 번호/제목 목록만 둔다.
// 받은 원문은 bench/.cache/ 에 파일번호별로 보관해 다시 받지 않는다(커밋하지 않음).
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRuleFiles, pickLatestFile, fetchRuleFile, mapLimit, settings } from "../src/alio-client.js";
import { extractDocument, splitArticles, articleGaps } from "../src/rule-text.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusPath = path.join(here, "corpus.json");
const fileCache = process.env.BENCH_FILE_CACHE || path.join(here, ".cache");
const update = process.argv.includes("--update");
const accept = process.argv.includes("--accept");

const corpus = JSON.parse(await fs.readFile(corpusPath, "utf8"));
const keyOf = (u) => `${u.kind}:${u.no}${u.title ? `(${u.title})` : ""}`;

async function sourceFile(file) {
  const p = path.join(fileCache, `${file.fileNo}.bin`);
  try {
    return await fs.readFile(p);
  } catch {}
  const { buf } = await fetchRuleFile(file.fileNo);
  await fs.mkdir(fileCache, { recursive: true });
  await fs.writeFile(p, buf);
  return buf;
}

async function measure(item) {
  const files = await getRuleFiles(item);
  const file = pickLatestFile(files);
  if (!file) return { status: "fail", kind: "NO_FILE", error: "첨부 없음" };
  const r = await extractDocument(await sourceFile(file), file.fileName);
  const units = splitArticles(r.markdown).filter((u) => u.kind !== "머리");
  return { status: "ok", fileNo: file.fileNo, fileType: r.fileType, units: units.map(keyOf), gaps: articleGaps(units).length };
}

function diff(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  return { missing: a.filter((x) => !B.has(x)), added: b.filter((x) => !A.has(x)) };
}

const t0 = Date.now();
const { results } = await mapLimit(corpus, settings.concurrency, async (item) => {
  try {
    return { item, ...(await measure(item)) };
  } catch (e) {
    return { item, status: "fail", kind: e.kind || "UNKNOWN", error: e.message };
  }
});

const same = [];
const revised = [];
const changed = [];
const failed = [];
for (const r of results) {
  if (r.status === "fail") failed.push(r);
  else if (r.fileNo !== r.item.fileNo) revised.push(r);
  else if (r.units.join("\n") !== r.item.units.join("\n") || r.gaps !== r.item.gaps) changed.push(r);
  else same.push(r);
}

const label = (r) => `${r.item.org} | ${r.item.title} (apbaId=${r.item.apbaId} idx=${r.item.idx})`;
console.log(`내규 조문 분할 벤치 — ${corpus.length}건, ${((Date.now() - t0) / 1000).toFixed(0)}초`);
console.log(`  일치 ${same.length} · 원문 개정 ${revised.length} · 달라짐 ${changed.length} · 조회 실패 ${failed.length}`);
const clean = results.filter((r) => r.status === "ok" && r.gaps === 0).length;
console.log(`  (참고) 조문 번호 누락 없이 분할된 규정 ${clean}/${results.filter((r) => r.status === "ok").length}`);
for (const r of changed) {
  const d = diff(r.item.units, r.units);
  console.log(`\n✖ 달라짐: ${label(r)}`);
  console.log(`   단위 ${r.item.units.length} → ${r.units.length}, 번호 누락 ${r.item.gaps} → ${r.gaps}`);
  d.missing.slice(0, 5).forEach((x) => console.log(`   - ${x}`));
  d.added.slice(0, 5).forEach((x) => console.log(`   + ${x}`));
}
for (const r of revised) console.log(`\n↻ 원문 개정: ${label(r)} fileNo ${r.item.fileNo} → ${r.fileNo}${update || accept ? " (기준 갱신)" : " — --update 로 기준 갱신"}`);
for (const r of failed) console.log(`\n⚠️ 조회 실패 [${r.kind}]: ${label(r)} — ${r.error}`);

if (update || accept) {
  const next = results.map((r) => {
    const take = r.status === "ok" && (revised.includes(r) || (accept && changed.includes(r)));
    return take ? { ...r.item, fileNo: r.fileNo, fileType: r.fileType, units: r.units, gaps: r.gaps } : r.item;
  });
  await fs.writeFile(corpusPath, JSON.stringify(next, null, 1) + "\n");
  console.log(`\n기준 저장: ${path.relative(process.cwd(), corpusPath)}`);
}

// 사이트 구조가 바뀐 흔적(SCHEMA)이나 분할 결과 변화는 실패. 네트워크 실패는 1할을 넘을 때만 실패.
const schema = failed.filter((r) => r.kind === "SCHEMA").length;
const bad = (changed.length && !accept) || schema || failed.length > corpus.length * 0.1;
if (bad) console.log(`\n실패: ${[changed.length && !accept && `분할 결과 달라짐 ${changed.length}건`, schema && `ALIO 응답 구조 변화 ${schema}건`, failed.length > corpus.length * 0.1 && `조회 실패 ${failed.length}건`].filter(Boolean).join(", ")}`);
process.exit(bad ? 1 : 0);
