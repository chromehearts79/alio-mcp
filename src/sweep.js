#!/usr/bin/env node
// ALIO 정기 점검 스윕 (용도② 내규 수정 검토)
// 사용: node src/sweep.js --keyword 혁신 [--out <dir>]
//  - 전 기관을 키워드로 훑어 스냅샷 저장
//  - 직전 스냅샷과 비교해 신설/개정/폐지 규정을 리포트 → 우리 내규 검토 트리거
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sweepKeyword } from "./alio-client.js";
import { normalizeSnapshot, diffSnapshots } from "./diff.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => {
    if (v.startsWith("--")) a.push([v.slice(2), arr[i + 1]]);
    return a;
  }, [])
);
const keyword = args.keyword || "혁신";
const outDir = args.out || path.join(__dir, "..", "snapshots");

async function latestSnapshot(kw) {
  try {
    const files = (await fs.readdir(outDir))
      .filter((f) => f.startsWith(`snap_${kw}_`) && f.endsWith(".json"))
      .sort();
    if (!files.length) return null;
    const raw = JSON.parse(await fs.readFile(path.join(outDir, files[files.length - 1]), "utf8"));
    return { file: files[files.length - 1], data: normalizeSnapshot(raw) };
  } catch {
    return null;
  }
}

console.error(`[sweep] '${keyword}' 전 기관 스윕 시작…`);
const res = await sweepKeyword(keyword, {
  onProgress: (i, n, h) => i % 25 === 0 && console.error(`  ${i}/${n} 기관, ${h}건`),
});
const { searched, hits } = res;
const failed = [...res.failed, ...res.timedOut];

await fs.mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
const snapPath = path.join(outDir, `snap_${keyword}_${stamp}.json`);

// 직전 스냅샷과 비교 (현재 저장 전에 읽어야 함)
const prev = await latestSnapshot(keyword);
const curr = { version: 2, keyword, date: stamp, searched, failed, hits };
await fs.writeFile(snapPath, JSON.stringify(curr, null, 2));
console.error(`[sweep] 스냅샷 저장: ${snapPath} (${hits.length}건, 조회 실패 ${failed.length}곳)`);

const fmt = (r) => `  - ${r.org} | ${r.title} | 시행 ${r.enfDate}`;

if (failed.length) {
  console.log(`\n⚠️  조회 실패 ${failed.length}/${searched}곳 — 이 기관들의 규정은 신설·폐지 판정에서 제외됩니다.`);
  failed.forEach((f) => console.log(`  - ${f.org} (${f.kind}: ${f.error})`));
}

if (!prev) {
  console.log(`\n첫 스냅샷입니다 (${hits.length}건). 다음 실행부터 변경점을 리포트합니다.`);
  process.exit(0);
}

const { added, removed, revised, unsureOrgs } = diffSnapshots(prev.data, curr);

console.log(`\n===== ALIO '${keyword}' 규정 변경 리포트 =====`);
console.log(`직전: ${prev.file}  →  현재: ${stamp}`);
console.log(`총 ${hits.length}건 (이전 ${prev.data.hits.length}건)`);
if (prev.data.truncatedOrgs.length)
  console.log(
    `※ 직전 스냅샷(구버전)은 기관당 최대 10건만 수집해 ${prev.data.truncatedOrgs.join(", ")} 의 규정이 잘렸을 수 있습니다. ` +
      `이 기관들의 '신설'에는 기존 규정이 섞여 있을 수 있으니 이번 스냅샷부터 기준선으로 쓰세요.`
  );
if (unsureOrgs.length) console.log(`※ 조회 실패로 판정 보류된 기관 ${unsureOrgs.length}곳`);
console.log("");

console.log(`🆕 신설 ${added.length}건`);
added.forEach((r) => console.log(fmt(r)));
console.log(`\n✏️  개정(시행일·명칭 변경) ${revised.length}건`);
revised.forEach((r) =>
  console.log(
    `  - ${r.org} | ${r.prevTitle ? `${r.prevTitle} → ` : ""}${r.title} | ${r.prevEnfDate} → ${r.enfDate}`
  )
);
console.log(`\n🗑️  폐지/제외 ${removed.length}건`);
removed.forEach((r) => console.log(fmt(r)));
console.log(`\n→ 신설·개정 규정은 우리 내규와 대조해 수정 필요 여부를 검토하세요.`);
