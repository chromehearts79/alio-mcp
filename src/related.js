// 비슷한 규정 찾기: 자사 규정(또는 주제어)과 같은 성격의 타 기관 규정을 찾는다.
//  1) 전체 규정 목록에서 분야 사전(thesaurus)으로 제목 후보를 넓게 고르고
//  2) 후보의 조문 제목 구성을 자사 규정과 비교해(예: 위원회·혁신계획·혁신책임관 조항이 있는가) 순위를 매긴다.
// 본문 읽기는 규정당 2~3초라 시간 예산 안에서 읽은 만큼 반영하고, 다시 부르면 캐시로 이어서 확인한다.
import { loadCatalog } from "./catalog.js";
import { loadRuleText, matchArticles } from "./rule-text.js";
import { mapLimit, settings, listOrgs, searchRules, AlioError } from "./alio-client.js";
import { isCancelled } from "./context.js";
import { classifyTitle, titleScore, coreTitle, normTitle } from "./thesaurus.js";

// 조문 제목 정규화: 낱말 끝 조사를 떼고(혁신계획의 수립 → 혁신계획 수립) 붙여 쓴다
const normArticle = (t) =>
  String(t || "")
    .split(/[\s·ㆍ,/()（）\[\]「」『』"'“”‘’]+/)
    .map((w) => w.replace(/(의|에|을|를|은|는|과|와|로|으로|에대한|에관한)$/, ""))
    .filter((w) => w && !["및", "등", "의", "또는"].includes(w))
    .join("");
const bigrams = (s) => {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
};
const dice = (a, b) => {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return (2 * n) / (a.size + b.size);
};

// 어느 규정에나 있는 조문 — 성격 비교에서 뺀다(비교와 같은 방식으로 정규화)
const GENERIC = new Set(
  ["목적", "정의", "용어의 정의", "적용범위", "적용 범위", "적용대상", "적용", "시행일", "시행", "경과조치", "다른 규정과의 관계", "다른 내규와의 관계", "타 규정과의 관계",
   "위임", "보칙", "세칙", "운영세칙", "세부운영사항", "세부사항", "시행세칙", "준용", "준용규정", "효력", "재검토기한", "유효기간", "기타", "삭제", "규정의 개폐", "개정", "폐지", "원칙", "책무"].map((t) => normArticle(t))
);

// 조문 제목 목록(흔한 조문 제외) — 규정의 '성격'
export function signature(units) {
  const seen = new Set();
  const out = [];
  for (const u of units) {
    if (u.kind !== "조문" || !u.title) continue;
    const n = normArticle(u.title);
    if (n.length < 2 || GENERIC.has(n) || seen.has(n)) continue;
    seen.add(n);
    out.push({ title: u.title.trim(), grams: bigrams(n) });
  }
  return out;
}

// 기준 규정의 조문 중 후보에도 같은 주제 조문(제목 글자 조각 유사도 0.5 이상)이 있는 비율과 그 조문들
export function overlap(base, cand, threshold = 0.5) {
  if (!base.length) return { score: 0, shared: [] };
  const shared = base.filter((b) => cand.some((c) => dice(b.grams, c.grams) >= threshold)).map((b) => b.title);
  return { score: shared.length / base.length, shared };
}

// maxCheck: 본문까지 비교할 후보 수(제목 점수 순). 넓은 분야(복무 등)는 후보가 천 건을 넘어 상위만 본다.
// 기준 규정의 제목·분류. 전체 목록을 아직 다 받지 못해 그 기관이 없으면(처음 쓸 때) 그 기관 목록을 직접 받는다.
export async function resolveBase(rule, rules) {
  const same = (r) => r.apbaId === rule.apbaId && String(r.idx) === String(rule.idx);
  const hit = rules.find(same);
  if (hit) return hit;
  const org = (await listOrgs()).find((o) => o.apbaId === rule.apbaId);
  if (!org) throw new AlioError("NO_FILE", `기관 ${rule.apbaId} 를 ALIO 기관 목록에서 찾지 못했습니다. apbaId 를 확인하세요.`);
  const found = (await searchRules(org, { keyword: "" })).find(same);
  if (!found) throw new AlioError("NO_FILE", `${org.name} 규정 목록에 idx=${rule.idx} 가 없습니다. alio_search_rules 결과의 idx 를 확인하세요.`);
  return found;
}

export async function findRelated({ rule, topic, filter = {}, limit = 20, maxCheck = 60, includeSameOrg = false, deadline, onProgress }) {
  // 목록 받기에는 예산의 일부만 쓴다(뒤에 본문 비교가 이어짐)
  const catDeadline = deadline ? Math.min(deadline, Date.now() + (deadline - Date.now()) * 0.6) : undefined;
  const orgFilter =
    filter.orgType || filter.dept
      ? (o) => (!filter.orgType || (o.type || "").includes(filter.orgType)) && (!filter.dept || (o.dept || "").includes(filter.dept))
      : undefined;
  const cat = await loadCatalog({ deadline: catDeadline, orgFilter });

  // 기준 정하기
  let base = null;
  let baseTitle = topic || "";
  let baseSig = [];
  if (rule) {
    const entry = await resolveBase(rule, cat.rules);
    const doc = await loadRuleText({ ...entry, ...rule });
    base = { ...entry, ...rule, org: entry?.org || rule.org || doc.org, title: entry?.title || rule.title || doc.title, units: doc.units };
    baseTitle = base.title || baseTitle;
    baseSig = signature(doc.units);
  }
  if (!baseTitle) throw new Error("기준 규정(apbaId·idx)이나 주제어(topic) 중 하나는 있어야 합니다");

  const matched = classifyTitle(baseTitle);
  const groups = matched.map((m) => m.group);
  const core = coreTitle(baseTitle);

  const inScope = (r) =>
    !r.superseded &&
    (includeSameOrg || !base || r.apbaId !== base.apbaId) &&
    (!filter.orgType || (r.type || "").includes(filter.orgType)) &&
    (!filter.dept || (r.dept || "").includes(filter.dept)) &&
    (!filter.category || r.category === filter.category);
  const cands = [];
  for (const r of cat.rules) {
    if (!inScope(r)) continue;
    const t = titleScore(r.title, matched, core);
    if (t.score > 0) cands.push({ rule: r, title: t });
  }
  cands.sort((a, b) => b.title.score - a.title.score || String(b.rule.enfDate).localeCompare(String(a.rule.enfDate)));

  // 본문 비교: 제목 점수 순으로 시간 안에서 읽는다
  let read = 0;
  let done = 0;
  const failed = [];
  const toCheck = cands.slice(0, maxCheck);
  await mapLimit(
    toCheck,
    settings.concurrency,
    async (c) => {
      try {
        const doc = await loadRuleText(c.rule);
        if (!doc.cached) read++;
        if (baseSig.length) c.body = overlap(baseSig, signature(doc.units));
        else {
          // 주제어만 있으면: 본문에 주제어가 든 조문 수
          const hits = matchArticles(doc.units, topic).length;
          c.body = { score: Math.min(1, hits / 3), shared: hits ? [`'${topic}' 조문 ${hits}개`] : [] };
        }
        c.articles = doc.units.filter((u) => u.kind === "조문").length;
      } catch (e) {
        if (isCancelled()) throw e;
        failed.push({ org: c.rule.org, title: c.rule.title, kind: e.kind || "UNKNOWN", error: e.message });
      }
      onProgress?.(++done, toCheck.length);
    },
    { deadline }
  );

  for (const c of cands) c.score = c.body ? 0.5 * c.title.score + 0.5 * c.body.score : 0.5 * c.title.score;
  const checked = cands.filter((c) => c.body).sort((a, b) => b.score - a.score);
  const unchecked = toCheck.filter((c) => !c.body && !failed.some((f) => f.org === c.rule.org && f.title === c.rule.title));
  const titleOnly = cands.slice(maxCheck);
  return {
    base,
    baseTitle,
    groups,
    core,
    baseSignature: baseSig.map((b) => b.title),
    catalog: cat,
    total: cands.length,
    top: checked.slice(0, limit),
    unchecked,
    titleOnly,
    failed,
    newlyRead: read,
  };
}

export { normTitle };
