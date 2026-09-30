// 분야별 본문 보완 기준 측정 — 분야 사전의 body(anchors·hosts)를 추측이 아니라 실제 본문으로 정한다.
//   node bench/anchors.mjs <분야>                         (예: 혁신, 임원보수 — 분야 id 나 이름)
//   --terms 혁신계획,혁신과제                              재 볼 검색어 후보(없으면 사전 낱말 + 그 분야 규정 조문 제목에 자주 나오는 말)
//   --query '혁신계획|혁신과제'                             담는 규정에 쓸 검색어(없으면 사전의 anchors)
//   --hosts '보수규정=보수,연봉,급여@(규정|규칙)$;정관=정관'   재 볼 담는 규정 후보 묶음(없으면 사전의 hosts). '@' 뒤는 제목 형태(정규식)
//   --sample 100  --pos 150  --host-sample 80              배경 표본 수 · 분야 규정 표본 수 · 담는 규정 묶음별 표본 수
// 재는 것
//   ① 검색어 재현율: 제목이 그 분야로 분명한 규정(강한 낱말) 중 본문에 그 말이 든 비율 — 높을수록 좋다
//   ② 검색어 배경 비율: 그 분야도 담는 규정도 아닌 무작위 규정 중 그 말이 든 비율 — 0 에 가까울수록 좋다
//   ③ 담는 규정 일치율: 묶음별로 검색어가 든 규정 비율. 그 분야 제목 규정이 '있는 기관'과 '없는 기관'을 나눠 본다
//      (보완 검색이 필요한 것은 없는 기관 — 있는 기관의 담는 규정은 대개 "따로 정한다"는 연결 조항)
// 표본은 고정 간격으로 골라 다시 실행하면 같은 규정을 읽는다(캐시로 이어짐). 본문은 서버와 같은 캐시·예의로 읽는다.
import { loadCatalog } from "../src/catalog.js";
import { loadRuleText, matchArticles } from "../src/rule-text.js";
import { mapLimit, settings } from "../src/alio-client.js";
import { GROUPS, classifyTitle, hostFamilies, normTitle } from "../src/thesaurus.js";

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const key = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const group = GROUPS.find((g) => g.id === key || g.name.includes(key || "\0"));
if (!group) {
  console.error(`분야를 주세요: ${GROUPS.map((g) => g.id).join(", ")}`);
  process.exit(2);
}
const SAMPLE = Number(opt("sample", 100));
const POS = Number(opt("pos", 150));
const HOST_SAMPLE = Number(opt("host-sample", 0)); // 0 = 전부
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const every = (list, n) => {
  if (!n || list.length <= n) return list;
  const step = list.length / n;
  return Array.from({ length: n }, (_, i) => list[Math.floor(i * step)]);
};

// 담는 규정 후보: --hosts 로 주면 그것으로 재고, 없으면 사전 값
const hostSpec = opt("hosts");
const probe = hostSpec
  ? {
      ...group,
      body: {
        ...(group.body || {}),
        hosts: hostSpec.split(";").map((s) => {
          const [name, rest] = s.split("=");
          const [words, re] = rest.split("@");
          return { name: name.trim(), words: words.split(",").map((w) => w.trim()).filter(Boolean), ...(re ? { titleRe: new RegExp(re) } : {}) };
        }),
      },
    }
  : group;
const fams = (r) => hostFamilies(probe, r.title);

const cat = await loadCatalog();
if (cat.missing.length) {
  console.error(`전체 규정 목록을 다 받지 못했습니다(${cat.missing.length}곳). 다시 실행하세요.`);
  process.exit(1);
}
const current = cat.rules.filter((r) => !r.superseded);
const levelOf = (r) => classifyTitle(r.title).find((m) => m.group === group)?.level;
const positivesAll = current.filter((r) => levelOf(r) === "strong");
const covered = new Set(positivesAll.map((r) => r.apbaId));
const positives = every(positivesAll, POS);
const hostRules = current.filter((r) => fams(r).length);
const rest = current.filter((r) => !levelOf(r) && !fams(r).length);
const background = every(rest, SAMPLE);

async function readAll(rules, label) {
  let done = 0;
  const failed = [];
  const { results } = await mapLimit(rules, settings.concurrency, async (r) => {
    try {
      const doc = await loadRuleText(r);
      if (!doc.cached) await sleep(settings.delayMs);
      return { rule: r, units: doc.units };
    } catch (e) {
      failed.push(`${r.org} ${r.title}: ${e.message}`);
      return null;
    } finally {
      if (++done % 25 === 0 || done === rules.length) process.stderr.write(`\r${label} ${done}/${rules.length}   `);
    }
  });
  process.stderr.write("\n");
  return { docs: results.filter(Boolean), failed };
}

const nOrg = new Set(current.map((r) => r.apbaId)).size;
console.log(
  `분야 '${group.name}' — 제목 규정 ${positivesAll.length}건(기관 ${covered.size}/${nOrg}곳, 표본 ${positives.length}건), ` +
    `담는 규정 후보 ${hostRules.length}건, 배경 표본 ${background.length}건(나머지 ${rest.length}건 중)`
);
const pos = await readAll(positives, "분야 규정");
const bg = await readAll(background, "배경 표본");

// 검색어 후보: 직접 준 것, 없으면 분야 사전의 강한 낱말 + 현재 본문 검색어 + 분야 규정 조문 제목에 자주 나오는 말
function articleWords(docs) {
  const df = new Map();
  for (const d of docs) {
    const seen = new Set();
    for (const u of d.units) {
      if (u.kind !== "조문" || !u.title) continue;
      for (const w of u.title.split(/[^가-힣A-Za-z]+/)) {
        const s = w.replace(/(의|에|을|를|은|는|과|와|로|으로)$/, "");
        if (s.length >= 3) seen.add(s);
      }
    }
    for (const s of seen) df.set(s, (df.get(s) || 0) + 1);
  }
  return [...df].filter(([, n]) => n >= Math.max(2, docs.length * 0.2)).sort((a, b) => b[1] - a[1]).map(([w]) => w);
}
const given = opt("terms");
const terms = given
  ? given.split(",").map((s) => s.trim()).filter(Boolean)
  : [...new Set([...(group.body?.anchors || []), ...group.strong, ...articleWords(pos.docs).slice(0, 15)])];

const has = (d, t) => matchArticles(d.units, t).length > 0;
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "-");
console.log(`\n① 검색어 재현율(분야 규정 ${pos.docs.length}건 중)  ② 배경 비율(표본 ${bg.docs.length}건 중)`);
const rows = terms.map((t) => ({ t, a: pos.docs.filter((d) => has(d, t)).length, b: bg.docs.filter((d) => has(d, t)).length }));
rows.sort((x, y) => y.a - x.a || x.b - y.b);
for (const { t, a, b } of rows) console.log(`  ${t.padEnd(14)} ① ${pct(a, pos.docs.length).padStart(4)} (${a})   ② ${pct(b, bg.docs.length).padStart(4)} (${b})`);

const query = opt("query") || group.body?.anchors?.join("|");
if (hostRules.length && query) {
  const q = pos.docs.filter((d) => has(d, query)).length;
  const qb = bg.docs.filter((d) => has(d, query)).length;
  console.log(`\n③ 담는 규정 일치율 — 검색어 '${query}' (분야 규정 ${pct(q, pos.docs.length)}, 배경 ${pct(qb, bg.docs.length)})`);
  for (const h of probe.body.hosts) {
    const inFam = hostRules.filter((r) => fams(r).includes(h.name));
    const un = inFam.filter((r) => !covered.has(r.apbaId));
    const co = inFam.filter((r) => covered.has(r.apbaId));
    const line = [];
    for (const [label, list] of [["제목 규정 없는 기관", un], ["있는 기관", co]]) {
      const pick = every(list, HOST_SAMPLE);
      const { docs, failed } = await readAll(pick, `${h.name} ${label}`);
      const hit = docs.filter((d) => has(d, query));
      line.push(`${label} ${hit.length}/${docs.length} (${pct(hit.length, docs.length)})${pick.length < list.length ? ` [표본, 전체 ${list.length}건]` : ""}${failed.length ? ` 실패 ${failed.length}` : ""}`);
      if (label === "제목 규정 없는 기관" && hit.length)
        line.push(`    예: ${hit.slice(0, 4).map((d) => `${d.rule.org} ${d.rule.title}[${matchArticles(d.units, query).slice(0, 2).map((u) => u.no).join(",")}]`).join(" / ")}`);
    }
    console.log(`  ${h.name} (${inFam.length}건)\n    ${line.join("\n    ")}`);
  }
} else if (!probe.body?.hosts?.length) console.log(`\n③ 담는 규정(hosts) 후보가 없습니다 — --hosts 로 후보 묶음을 주세요.`);

const failed = [...pos.failed, ...bg.failed];
if (failed.length) console.log(`\n본문 읽기 실패 ${failed.length}건: ${failed.slice(0, 5).join(" / ")}${failed.length > 5 ? " 등" : ""}`);
