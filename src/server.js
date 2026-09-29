#!/usr/bin/env node
// ALIO 내부규정 MCP 서버 — 공공기관 내규 검색·본문 비교·지침 최신성 확인·한글 문서 작성
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { listOrgs, searchOrgs, getRuleFiles, fetchRuleDocument, settings, mapLimit } from "./alio-client.js";
import { loadRuleText, matchArticles, pickArticles, excerpt } from "./rule-text.js";
import {
  GUIDELINE_TITLE,
  NAME_CHANGES,
  listGuidelineVersions,
  versionAt,
  loadGuidelineVersion,
  diffUnits,
  readSeen,
  markSeen,
  guidelineHeader,
} from "./guideline.js";
import { markdownToStyledHwpx, HOUSE_STYLE } from "./hwpx.js";
import { OUTPUT_DIR, DOWNLOAD_DIR } from "./paths.js";
import { runWithSignal, isCancelled } from "./context.js";
import { writeNewFile } from "./fsutil.js";
import { findRelated } from "./related.js";
import { coverageNote, refreshInBackground } from "./catalog.js";

// 버전은 package.json 하나에서 가져온다(manifest·릴리스 태그도 이 값과 맞춰 검사)
export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const MAX_OUTPUT = 60000;
// MCP 클라이언트는 기본 60초 안에 응답이 없으면 요청을 끊는다. 그 전에 부분 결과라도 돌려준다.
const BUDGET_MS = Number(process.env.ALIO_TOOL_BUDGET_MS) || 40000;
const text = (s) => ({ content: [{ type: "text", text: s }] });
const fail = (s) => ({ ...text(s), isError: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 검색결과를 다시 넘겨 파일을 받기 위한 최소 식별자 스키마
const ruleRef = {
  apbaId: z.string().describe("기관 ID (검색결과의 apbaId)"),
  idx: z.string().describe("규정 idx (검색결과의 idx)"),
  org: z.string().optional().describe("기관명 (파일명용)"),
  title: z.string().optional().describe("규정명 (파일명용)"),
  category: z.string().optional().describe("분류코드 K1100~K1500"),
  tableName: z.string().optional(),
  idxName: z.string().optional(),
};

const orgFilter = {
  orgName: z.string().optional().describe("기관명 부분일치 (예: 인천국제공항공사)"),
  orgType: z.string().optional().describe("기관 유형 부분일치 (예: 공기업, 준정부기관, 기타공공기관, 시장형, 위탁집행형)"),
  dept: z.string().optional().describe("주무부처 부분일치 (예: 국토교통부, 금융위원회)"),
};
const filterOrgs = (orgs, { orgName, orgType, dept }) =>
  orgs.filter(
    (o) =>
      (!orgName || o.name.includes(orgName)) &&
      (!orgType || (o.type || "").includes(orgType)) &&
      (!dept || (o.dept || "").includes(dept))
  );
const describeFilter = ({ orgName, orgType, dept }) =>
  [orgName && `기관 '${orgName}'`, orgType && `유형 '${orgType}'`, dept && `부처 '${dept}'`].filter(Boolean).join(", ");

// 클라이언트가 progressToken 을 주면 진행 알림을 보낸다(지원하는 클라이언트는 대기 시간을 연장).
function progressReporter(extra) {
  const token = extra?._meta?.progressToken;
  let last = 0;
  return (progress, total, message) => {
    if (token === undefined || Date.now() - last < 1000) return;
    last = Date.now();
    extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress, total, message } }).catch(() => {});
  };
}

const timeoutNote = (list, what) =>
  list.length
    ? `\n⏱️ 시간 제한(${BUDGET_MS / 1000}초)으로 ${what} ${list.length}건을 처리하지 못했습니다: ${list
        .slice(0, 15)
        .map((x) => x.org + (x.title ? ` ${x.title}` : ""))
        .join(", ")}${list.length > 15 ? " 등" : ""}\n   → 같은 요청을 다시 실행하면 이미 처리한 부분은 캐시로 바로 넘어가고 나머지를 이어서 처리합니다. 결과를 추측하지 마세요.\n`
    : "";

const failList = (label, list) =>
  list.length ? `\n⚠️ ${label} ${list.length}건 — 결과에 빠졌을 수 있음:\n` + list.map((f) => `- ${f.org} ${f.title || ""} (${f.kind}: ${f.error})`).join("\n") + "\n" : "";

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n…(이하 ${s.length - n}자 생략 — alio_read_rule 의 articles 로 전문 조회)` : s);
const heading = (u) =>
  u.kind === "조문"
    ? `${u.no}${u.title ? `(${u.title})` : ""}${u.part ? `  [${u.part}]` : ""}`
    : `${u.no}${u.title ? ` ${u.title}` : ""}`;

// 출력 상한을 넘으면 남은 블록 수를 알리고 멈춘다
function joinCapped(head, blocks, what) {
  let out = head;
  for (let i = 0; i < blocks.length; i++) {
    if (out.length + blocks[i].length > MAX_OUTPUT) {
      return out + `\n\n…출력 한도로 ${what} ${blocks.length - i}건 생략. 조건을 좁혀 다시 조회하세요.`;
    }
    out += blocks[i];
  }
  return out;
}

// 오류를 사용자·모델이 다음 행동을 정할 수 있는 안내로 바꾼다
const KIND_HINTS = {
  HTTP: "ALIO가 요청을 거부했습니다. 잠시 뒤 다시 시도하세요.",
  NETWORK: "ALIO(www.alio.go.kr)에 연결하지 못했습니다. 인터넷 연결(업무망이면 외부 사이트 접속 허용 여부)을 확인하고 다시 시도하세요.",
  SCHEMA: "ALIO 응답이 예상과 다릅니다. 사이트 개편이나 접속 차단일 수 있습니다. 결과를 추측하지 말고 사용자에게 알리세요.",
  NO_FILE: "이 규정에는 첨부 파일이 없습니다.",
  PARSE: "본문을 추출하지 못했습니다(스캔 PDF·손상 파일 등). alio_download_rule 로 원문을 받아 직접 확인하세요.",
};
const FS_HINTS = {
  ENOENT: "경로를 찾을 수 없습니다",
  EACCES: "접근 권한이 없습니다",
  EPERM: "작업 권한이 없습니다",
  ENOTDIR: "경로 중간이 폴더가 아닙니다",
  EISDIR: "파일 자리에 폴더가 있습니다",
  EEXIST: "같은 이름이 이미 있습니다",
  ENOSPC: "디스크 공간이 부족합니다",
  EROFS: "읽기 전용 위치입니다",
};
export function describeError(e, toolName) {
  if (e?.name === "AlioError") return `⚠️ ${toolName} 실패 [${e.kind}] ${e.message}\n→ ${KIND_HINTS[e.kind] || "다시 시도하세요."}`;
  if (e?.code === "EUNSAFEPATH") return `⚠️ ${toolName} 실패: ${e.message}`;
  if (typeof e?.code === "string" && FS_HINTS[e.code])
    return `⚠️ ${toolName} 실패: 파일 저장 오류 [${e.code}] ${FS_HINTS[e.code]}${e.path ? ` (${e.path})` : ""}\n→ 저장 폴더(outDir)를 확인하세요.`;
  return `⚠️ ${toolName} 실패: 예상하지 못한 오류 — ${e?.message || e}\n→ 결과를 추측하지 말고 사용자에게 알리세요.`;
}

// 응답 상한 — 도구별 요약(joinCapped)을 거친 뒤에도 넘치면 여기서 자른다
const MAX_RESPONSE = 100000;
export const capText = (t) =>
  t.length > MAX_RESPONSE ? t.slice(0, MAX_RESPONSE) + `\n\n…(응답이 ${MAX_RESPONSE.toLocaleString()}자를 넘어 잘렸습니다 — 조건을 좁혀 다시 조회하세요)` : t;

const REVIEW_FRAME = `[내규 검토 기본 프레임] 내규 개정·비교 검토 요청을 받으면 이 순서를 따른다.
0. 기준 최신성: 모든 alio 도구 결과 맨 위의 '📌 기준 지침' 줄을 확인한다. '⚠️'가 붙어 있으면 다른 작업보다 먼저 alio_guideline 을 호출해 새 개정에서 달라진 점을 사용자에게 설명한다. 검토 대상 규정의 시행일을 alio_guideline 의 since 로 넘겨, 그 규정이 만들어진 뒤 지침에서 달라진 점도 확인한다. 법령정보 MCP(korean-law)가 있으면 인용 법령(공운법 제15조 등)의 현행·시행예정 개정도 확인한다.
1. 자사 규정: alio_search_rules(orgName) → alio_read_rule 로 전문을 읽고 형식 오류(오기, 조문 번호 누락 경고, 인용 법령·부처명·조문 번호)를 점검한다.
2. 기준 대조: 자사 규정 조문을 현행 지침의 대응 조문(alio_guideline 의 articles·query)과 대조해 불일치·미반영 사항을 찾는다.
3. 비교군: alio_find_related 에 자사 규정(apbaId·idx)을 넘겨 같은 성격의 타 기관 현행 규정을 찾는다. 기관마다 규정 이름이 달라 제목 검색만으로는 빠지는 규정이 많다. 같은 유형(orgType)으로 좁힐 수 있다(⚠️옛 버전 추정 제외).
4. 조문 비교: alio_search_text·alio_read_rule 로 항목별 공백과 수준 차이를 찾는다.
5. 개정안: '필수(법령·지침 불일치, 오기)'와 '권고(타 기관 사례)'를 나누고 근거(지침 개정일·조문, 기관·규정·조문)를 적는다. 결과물에 기준 지침 개정일과 최신성 확인일을 명시한다. 한글 파일이 필요하면 alio_write_hwpx 로 저장한다.
결과에 '⏱️ 시간 제한'이 있으면 같은 요청을 다시 실행해 이어서 처리한다. 확인되지 않은 내용은 추측하지 않는다.`;

const fmtDiff = (label, base, cur, d) => {
  const real = d.changed.filter((c) => !c.renameOnly);
  const renamed = d.changed.filter((c) => c.renameOnly);
  const addedArts = d.added.filter((u) => u.kind !== "부칙");
  const addedAdd = d.added.filter((u) => u.kind === "부칙");
  const names = NAME_CHANGES.map(([a, b]) => `${a}→${b}`).join(", ");
  const out = [
    `\n━━ ${label}: ${base.title} → ${cur.title}`,
    `조문 추가 ${addedArts.length} · 삭제 ${d.removed.length} · 실질 변경 ${real.length} · 명칭만 변경 ${renamed.length}(${names}) · 부칙 추가 ${addedAdd.length}`,
  ];
  for (const c of real) {
    out.push(`\n■ 변경 ${heading(c.unit)}${c.prevTitle ? ` [제목 변경: ${c.prevTitle}]` : ""}`);
    c.removed.forEach((l) => out.push(`  - ${l.length > 400 ? l.slice(0, 400) + "…" : l}`));
    c.added.forEach((l) => out.push(`  + ${l.length > 400 ? l.slice(0, 400) + "…" : l}`));
  }
  for (const u of addedArts) out.push(`\n■ 추가 ${heading(u)}\n${clip(u.text, 800)}`);
  for (const u of d.removed) out.push(`\n■ 삭제 ${heading(u)}`);
  if (renamed.length) out.push(`\n명칭만 변경된 조문: ${renamed.map((c) => c.unit.no).join(", ")}`);
  if (addedAdd.length) out.push(`추가된 부칙: ${addedAdd.map((u) => u.no).join(", ")}`);
  return out.join("\n") + "\n";
};

// 도구·프롬프트를 등록한 서버. 테스트는 이것을 메모리 전송으로 붙여 쓴다.
export function createServer() {
  const server = new McpServer(
    { name: "alio-mcp", version: VERSION },
    { instructions: `alio-mcp: 공공기관 내부규정(ALIO) 검색·본문 비교와 「${GUIDELINE_TITLE}」 최신성 확인 도구.\n\n${REVIEW_FRAME}` }
  );

  // 공통 래퍼: 취소 신호 전달, 오류를 안내 문구로, 응답 길이 상한, 결과 맨 위에 기준 지침(최신성) 표시.
  // 지침 확인은 도구 작업과 동시에 진행한다.
  function tool(name, description, schema, handler, { header = true } = {}) {
    server.tool(name, description, schema, (args, extra) =>
      runWithSignal(extra?.signal, async () => {
        let result;
        try {
          const [head, r] = await Promise.all([header ? guidelineHeader() : "", handler(args, extra)]);
          result = r;
          const c = result?.content?.[0];
          if (c?.type === "text") c.text = head + c.text;
        } catch (e) {
          // 취소된 요청은 결과로 바꾸지 않는다(SDK 가 응답을 보내지 않음)
          if (isCancelled()) throw e;
          result = fail(describeError(e, name));
        }
        for (const c of result.content || []) if (c.type === "text") c.text = capText(c.text);
        return result;
      })
    );
  }

  tool(
    "alio_list_orgs",
    "ALIO 등록 공공기관 목록(355곳)을 조회한다. filter로 기관명/유형/부처 부분일치 필터 가능.",
    { filter: z.string().optional().describe("기관명·유형·부처 부분일치 키워드") },
    async ({ filter }) => {
      const orgs = await listOrgs();
      const f = (filter || "").trim();
      const list = f ? orgs.filter((o) => `${o.name} ${o.type} ${o.dept}`.includes(f)) : orgs;
      const lines = list.map((o) => `- ${o.name} | ${o.type} | ${o.dept} | apbaId=${o.apbaId}`);
      return text(`공공기관 ${list.length}/${orgs.length}곳${f ? ` ("${f}" 필터)` : ""}\n${lines.join("\n")}`);
    }
  );

  tool(
    "alio_search_rules",
    "공공기관 내부규정을 제목 키워드로 검색한다. 기관명·기관 유형(공기업/준정부기관 등)·주무부처로 대상 기관을 좁힐 수 있고, 없으면 전 기관(355곳)을 동시 조회로 훑는다(약 20초). category(K1100 인사·K1200 보수·K1300 직제·K1400 기타·K1500 정관)로 좁힐 수 있다. 본문 내용으로 찾으려면 alio_search_text 를 쓴다.",
    {
      keyword: z.string().describe("규정 제목 검색어 (예: 경영혁신, 혁신, 인사)"),
      ...orgFilter,
      category: z.string().optional().describe("분류코드 K1100~K1500"),
      maxOrgs: z.number().optional().describe("최대 기관 수 제한(기본 전체)"),
    },
    async ({ keyword, category, maxOrgs, ...f }, extra) => {
      const deadline = Date.now() + BUDGET_MS;
      const report = progressReporter(extra);
      let targets = filterOrgs(await listOrgs(), f);
      if (!targets.length) return fail(`조건(${describeFilter(f)})에 해당하는 기관이 없습니다. alio_list_orgs 로 명칭을 확인하세요.`);
      if (maxOrgs) targets = targets.slice(0, maxOrgs);

      const { searched, hits, failed, timedOut } = await searchOrgs(targets, {
        keyword,
        category: category || "",
        deadline,
        onProgress: (done, total) => report(done, total, `기관 ${done}/${total}곳 조회`),
      });
      const ok = searched - failed.length;
      const failNote = failList("조회 실패 기관", failed) + timeoutNote(timedOut, "기관");

      if (ok === 0) return fail(`'${keyword}' 검색 실패: 대상 ${targets.length}곳 중 조회에 성공한 기관이 없습니다.${failNote}`);
      if (!hits.length)
        return text(
          `'${keyword}' 제목의 규정 없음 (${targets.length}곳 중 ${ok}곳 정상 조회).${failNote}\n` +
            `※ 제목 검색이므로 다른 명칭(유사어)으로 쓰였을 수 있습니다. 본문에서 찾으려면 alio_search_text 를 쓰세요. 결과를 추측하지 마세요.`
        );

      const lines = hits.map(
        (r) =>
          `- ${r.org} | ${r.title} | ${r.categoryName} | 시행 ${r.enfDate} | apbaId=${r.apbaId} idx=${r.idx} cat=${r.category}` +
          (r.superseded ? ` | ⚠️옛 버전 추정(최신 idx=${r.latestIdx}, 시행 ${r.latestEnfDate})` : "")
      );
      const old = hits.filter((r) => r.superseded).length;
      return text(
        `'${keyword}' 규정 ${hits.length}건 (${targets.length}곳 중 ${ok}곳 정상 조회)${failNote}\n` +
          (old ? `※ 같은 기관에 같은 이름으로 여러 건 올라온 규정 중 시행일이 늦은 것이 따로 있는 ${old}건은 '⚠️옛 버전 추정'으로 표시했습니다.\n` : "") +
          `※ 본문은 alio_read_rule, 파일은 alio_download_rule 에 apbaId/idx/category 를 넘기세요.\n\n` +
          lines.join("\n")
      );
    }
  );

  tool(
    "alio_read_rule",
    "규정 하나의 현행본 본문을 조문 단위로 읽는다. articles 를 주면 그 조문 전문, query 를 주면 본문에 그 말이 들어간 조문 전문, 둘 다 없으면 목차(조문 번호·제목, 부칙, 별표)를 돌려준다. query 는 공백=모두 포함, '|'=둘 중 하나, 띄어쓰기 차이는 무시한다.",
    {
      ...ruleRef,
      articles: z.array(z.string()).optional().describe("조문 번호 목록 (예: ['제5조','제16조의2','부칙','별표 3'])"),
      query: z.string().optional().describe("본문 검색어 (예: '유연근무|시차출퇴근', '징계 감경')"),
    },
    async ({ articles, query, ...rule }) => {
      const doc = await loadRuleText(rule);
      const count = (k) => doc.units.filter((u) => u.kind === k).length;
      const shape = count("구간")
        ? `조문 구조 없음 → 제목 기준 구간 ${count("구간")}개`
        : `조문 ${count("조문")}개 · 부칙 ${count("부칙")}개 · 별표 ${count("별표")}개`;
      const head =
        `${doc.org || doc.apbaId} ${doc.title || `idx=${doc.idx}`}\n` +
        `현행본: ${doc.file.fileName}${doc.file.innerName ? ` 안의 ${doc.file.innerName}` : ""} (fileNo=${doc.file.fileNo}) | ${shape}${doc.cached ? " | 캐시" : ""}\n` +
        (doc.warnings || []).map((w) => `⚠️ ${w}\n`).join("");

      if (articles?.length) {
        const { picked, missing } = pickArticles(doc.units, articles);
        const miss = missing.length ? `\n⚠️ 이 규정에 없는 조문: ${missing.join(", ")}\n` : "";
        return text(joinCapped(head + miss, picked.map((u) => `\n■ ${heading(u)}\n${clip(u.text, 6000)}\n`), "조문"));
      }

      if (query) {
        const found = matchArticles(doc.units, query);
        if (!found.length)
          return text(
            head + `\n본문에 '${query}' 가 들어간 조문 없음 (전체 ${doc.units.length}개 단위 확인).\n※ 다른 표현(유사어)으로 쓰였을 수 있습니다. 결과를 추측하지 마세요.`
          );
        return text(
          joinCapped(head + `\n'${query}' 일치 ${found.length}개\n`, found.map((u) => `\n■ ${heading(u)}\n${excerpt(u.text, query, 3000)}\n`), "조문")
        );
      }

      const toc = [];
      let part = null;
      for (const u of doc.units) {
        if (u.kind === "머리") continue;
        if (u.kind === "조문" && u.part !== part) {
          part = u.part;
          if (part) toc.push(`\n[${part}]`);
        }
        toc.push(`- ${u.kind === "조문" ? `${u.no}${u.title ? `(${u.title})` : ""}` : heading(u)}`);
      }
      const intro = doc.units.find((u) => u.kind === "머리");
      return text(
        head +
          (intro ? `\n${clip(intro.text, 400)}\n` : "") +
          `\n목차:\n${toc.join("\n")}\n` +
          `\n※ 전문은 articles(조문 번호·'부칙'·'별표 N'·'구간N'), 내용 검색은 query 로 다시 조회하세요.`
      );
    }
  );

  tool(
    "alio_search_text",
    "여러 기관 규정의 본문(조문)에서 검색어를 찾는다. 제목 키워드로 읽을 규정을 먼저 고른 뒤(예: '복무'), 그 본문에서 query(예: '유연근무|시차출퇴근')가 들어간 조문을 기관별로 보여준다. 기관명·유형·주무부처로 좁힐 수 있다. 처음 읽는 규정은 동시에 여러 건씩 읽고, 이후엔 캐시로 빠르다. 시간 제한에 걸리면 처리한 만큼 돌려주며 같은 요청을 다시 실행하면 이어서 읽는다.",
    {
      titleKeyword: z.string().describe("읽을 규정의 제목 키워드 (예: 복무, 인사, 보수, 윤리). 기관을 하나로 좁혔을 때만 빈 값 허용"),
      query: z.string().describe("본문 검색어. 공백=모두 포함, '|'=둘 중 하나, 띄어쓰기 무시"),
      ...orgFilter,
      category: z.string().optional().describe("분류코드 K1100~K1500"),
      maxRules: z.number().optional().describe("본문을 읽을 최대 규정 수 (기본 30, 최대 150)"),
      includeOld: z
        .boolean()
        .optional()
        .describe("같은 기관에 같은 이름으로 올라온 옛 버전까지 읽기 (기본 false: 시행일이 가장 늦은 것만)"),
    },
    async ({ titleKeyword, query, category, maxRules, includeOld, ...f }, extra) => {
      const deadline = Date.now() + BUDGET_MS;
      const report = progressReporter(extra);
      const targets = filterOrgs(await listOrgs(), f);
      if (!targets.length) return fail(`조건(${describeFilter(f)})에 해당하는 기관이 없습니다.`);
      if (!titleKeyword.trim() && targets.length > 1)
        return fail("titleKeyword 없이 여러 기관의 전체 규정을 읽을 수는 없습니다. 제목 키워드를 주거나 기관을 하나로 좁히세요.");
      const limit = Math.min(Math.max(1, maxRules || 30), 150);

      const { hits: allRules, failed: orgFailed, timedOut: orgTimedOut } = await searchOrgs(targets, {
        keyword: titleKeyword,
        category: category || "",
        deadline,
        onProgress: (done, total) => report(done, total * 2, `제목 검색 ${done}/${total}곳`),
      });
      const rules = includeOld ? allRules : allRules.filter((r) => !r.superseded);
      const oldSkipped = allRules.length - rules.length;
      if (!rules.length)
        return text(
          `제목에 '${titleKeyword}' 가 들어간 규정이 없어 본문을 읽지 않았습니다 (${targets.length}곳).` +
            failList("조회 실패 기관", orgFailed) +
            timeoutNote(orgTimedOut, "기관")
        );

      const toRead = rules.slice(0, limit);
      const readFailed = [];
      let articleHits = 0;
      let read = 0;
      const { results, skipped: unreadIdx } = await mapLimit(
        toRead,
        settings.concurrency,
        async (r) => {
          try {
            const doc = await loadRuleText(r);
            if (!doc.cached) await sleep(settings.delayMs);
            const found = matchArticles(doc.units, query);
            if (!found.length) return null;
            articleHits += found.length;
            return (
              `\n■ ${r.org} | ${r.title} | 시행 ${r.enfDate} | apbaId=${r.apbaId} idx=${r.idx}` +
              (r.superseded ? ` | ⚠️옛 버전 추정(최신 idx=${r.latestIdx})` : "") +
              "\n" +
              (doc.warnings || []).map((w) => `  ⚠️ ${w}\n`).join("") +
              found.map((u) => `  ▸ ${heading(u)}\n${excerpt(u.text, query, 800)}`).join("\n") +
              "\n"
            );
          } catch (e) {
            readFailed.push({ org: r.org, title: r.title, kind: e.kind || "UNKNOWN", error: e.message });
            return null;
          } finally {
            read++;
            report(targets.length + (read / toRead.length) * targets.length, targets.length * 2, `본문 ${read}/${toRead.length}건`);
          }
        },
        { deadline }
      );
      const blocks = results.filter(Boolean);
      const unread = unreadIdx.map((i) => toRead[i]);

      const skipped = rules.length - toRead.length;
      const head =
        `본문 '${query}' 검색 — 제목 '${titleKeyword}' 규정 ${rules.length}건 중 ${toRead.length - unread.length}건 읽음` +
        `${describeFilter(f) ? ` (${describeFilter(f)})` : ""}\n` +
        `→ ${blocks.length}개 규정, ${articleHits}개 조문 일치\n` +
        (oldSkipped ? `※ 같은 기관·같은 이름의 옛 버전 추정 ${oldSkipped}건은 제외 (includeOld=true 로 포함 가능)\n` : "") +
        (skipped ? `⚠️ ${skipped}건은 읽지 않음 (maxRules=${limit}). maxRules 를 늘리거나 유형·부처로 좁히세요.\n` : "") +
        failList("조회 실패 기관", orgFailed) +
        failList("본문 읽기 실패 규정", readFailed) +
        timeoutNote(orgTimedOut, "기관(제목 검색)") +
        timeoutNote(unread, "규정(본문 읽기)") +
        (blocks.length ? "" : `\n일치하는 조문 없음. 다른 표현(유사어)으로 다시 찾아보세요. 결과를 추측하지 마세요.\n`);
      return text(joinCapped(head, blocks, "규정"));
    }
  );

  tool(
    "alio_find_related",
    "자사 규정(apbaId·idx) 또는 주제어(topic)와 같은 성격의 타 기관 규정을 찾는다. 기관마다 이름이 다른 규정(예: 경영혁신규정·혁신경영 실행지침·변화혁신위원회규정)을 내규 분야 사전으로 넓게 모은 뒤, 조문 구성(같은 주제의 조항이 있는지)을 비교해 순위를 매긴다. 처음에는 전체 규정 목록(355곳, 약 3만 6천 건)과 후보 본문을 받느라 여러 번 나눠 처리할 수 있으며, 같은 요청을 다시 실행하면 이어서 한다.",
    {
      apbaId: z.string().optional().describe("기준 규정의 기관 ID (alio_search_rules 결과)"),
      idx: z.string().optional().describe("기준 규정 idx"),
      topic: z.string().optional().describe("기준 규정 대신 주제어 (예: 유연근무, 임금피크제, 경영혁신)"),
      orgType: z.string().optional().describe("기관 유형 부분일치 (예: 공기업, 준정부기관, 기타공공기관)"),
      dept: z.string().optional().describe("주무부처 부분일치"),
      category: z.string().optional().describe("분류코드 K1100~K1500"),
      limit: z.number().optional().describe("보여줄 규정 수 (기본 20)"),
      maxCheck: z.number().optional().describe("본문까지 비교할 후보 수 (기본 60, 최대 200). 후보가 많은 분야에서 늘린다"),
      includeSameOrg: z.boolean().optional().describe("기준 기관의 다른 규정도 포함 (기본 false)"),
    },
    async ({ apbaId, idx, topic, orgType, dept, category, limit, maxCheck, includeSameOrg }, extra) => {
      if (!(apbaId && idx) && !topic) return fail("기준 규정(apbaId·idx)이나 주제어(topic) 중 하나를 주세요.");
      const report = progressReporter(extra);
      const r = await findRelated({
        rule: apbaId && idx ? { apbaId, idx } : null,
        topic,
        filter: { orgType, dept, category },
        limit: Math.min(Math.max(1, limit || 20), 60),
        maxCheck: Math.min(Math.max(10, maxCheck || 60), 200),
        includeSameOrg,
        deadline: Date.now() + BUDGET_MS,
        onProgress: (d, t) => report(d, t, `후보 본문 ${d}/${t}건`),
      });
      const baseName = r.base ? `${r.base.org} 「${r.base.title}」` : `주제어 '${topic}'`;
      const field = r.groups.length ? r.groups.map((g) => g.name).join("·") : `사전에 없는 분야 — 제목 핵심 말 '${r.core}'로 찾음`;
      const checked = r.total - r.titleOnly.length - r.unchecked.length;
      const head =
        `비슷한 규정 찾기 — 기준: ${baseName} (분야: ${field})\n` +
        (r.base ? `기준 조문 ${r.baseSignature.length}개(목적·정의 등 흔한 조문 제외)와 같은 주제 조문이 있는지 비교\n` : "") +
        `${coverageNote(r.catalog)}\n` +
        `후보 ${r.total}건(제목) 중 ${checked}건 본문 비교${r.titleOnly.length ? ` · 나머지 ${r.titleOnly.length}건은 제목만 일치(본문 미확인)` : ""}\n` +
        failList("본문 읽기 실패", r.failed) +
        timeoutNote(r.unchecked.map((c) => ({ org: c.rule.org, title: c.rule.title })), "후보(본문 비교)");
      if (!r.total) return text(head + `\n같은 성격으로 보이는 규정을 찾지 못했습니다. 다른 주제어로 다시 찾거나 alio_search_rules 로 제목을 직접 검색하세요. 결과를 추측하지 마세요.`);
      const blocks = r.top.map(
        (c, i) =>
          `\n■ ${i + 1}. ${c.rule.org} | ${c.rule.title} | 시행 ${c.rule.enfDate} | apbaId=${c.rule.apbaId} idx=${c.rule.idx} cat=${c.rule.category}\n` +
          `   유사도 ${c.score.toFixed(2)} — ${c.title.why}` +
          (r.base ? ` · 같은 주제 조문 ${c.body.shared.length}/${r.baseSignature.length}${c.body.shared.length ? `: ${c.body.shared.slice(0, 6).join(", ")}` : ""}` : ` · ${c.body.shared.join(", ") || "본문에 주제어 없음"}`)
      );
      const sameWords = r.titleOnly.filter((c) => c.title.score >= 0.9);
      const tail =
        (r.titleOnly.length
          ? `\n\n제목만 일치(본문 미확인) ${r.titleOnly.length}건${sameWords.length ? ` — 이 중 기준과 제목 낱말까지 같은 규정 ${sameWords.length}건: ${sameWords.slice(0, 8).map((c) => `${c.rule.org} ${c.rule.title}`).join(" / ")}${sameWords.length > 8 ? " 등" : ""}` : ""}\n→ maxCheck 를 늘리거나 orgType·dept 로 좁혀 다시 실행하세요.`
          : "") +
        `\n\n※ 유사도 = 제목 분야 일치(절반) + 기준 조문과 같은 주제 조문 비율(절반). 순위는 참고용이니 채택 전에 alio_read_rule 로 조문 전문을 확인하세요.`;
      return text(joinCapped(head, blocks, "규정") + tail);
    }
  );

  tool(
    "alio_get_rule_files",
    "규정의 첨부파일(제정·개정 이력 포함) 목록과 fileNo를 조회한다. alio_search_rules 결과의 apbaId/idx/category 를 넘긴다.",
    ruleRef,
    async (rule) => {
      const files = await getRuleFiles(rule);
      if (!files.length) return text("첨부파일을 찾지 못했습니다.");
      return text(
        `첨부 ${files.length}개:\n` + files.map((f) => `- fileNo=${f.fileNo} | ${f.fileName}`).join("\n")
      );
    }
  );

  tool(
    "alio_download_rule",
    "규정 현행 파일(첨부 중 가장 나중에 등록된 개정본)을 로컬에 저장하고 경로를 반환한다. 본문을 읽기만 할 거라면 alio_read_rule 이 더 간단하다.",
    { ...ruleRef, outDir: z.string().optional().describe(`저장 폴더 (기본 ${DOWNLOAD_DIR})`) },
    async ({ outDir, ...rule }) => {
      const doc = await fetchRuleDocument(rule, outDir || DOWNLOAD_DIR);
      if (!doc.saved) return text("첨부파일이 없어 다운로드하지 못했습니다.");
      return text(
        `저장 완료:\n- 파일: ${doc.saved.fileName} (fileNo=${doc.saved.fileNo})\n- 경로: ${doc.saved.path}\n- 크기: ${doc.saved.bytes} bytes\n- 형식: ${doc.saved.contentType}\n` +
          `- 전체 ${doc.files.length}개 중 가장 나중에 등록된 파일을 현행본으로 저장\n\n→ 본문은 alio_read_rule 로 조문 단위로 읽을 수 있습니다.`
      );
    }
  );


  tool(
    "alio_guideline",
    `「${GUIDELINE_TITLE}」의 최신 개정 여부를 ALIO(재정경제부 게시)에서 확인하고, 달라진 점을 조문별로 비교한다. 지난 확인 이후 새 개정이 있으면 그 차이를, since(예: 검토할 규정의 시행일)를 주면 그 시점 개정본과 현행의 차이를, 아무것도 없으면 직전 개정 대비 차이를 보여준다. articles·query 로 현행 지침 조문을 읽는다. 내규 검토 전에 먼저 호출한다.`,
    {
      since: z.string().optional().describe("기준일 (예: '2023.02.15' — 자사 규정 시행일). 그날 시행 중이던 개정본과 현행을 비교"),
      articles: z.array(z.string()).optional().describe("현행 지침에서 읽을 조문 (예: ['제9조','제11조'])"),
      query: z.string().optional().describe("현행 지침 본문 검색어 (공백=모두 포함, '|'=둘 중 하나)"),
    },
    async ({ since, articles, query }) => {
      const versions = await listGuidelineVersions({ force: true });
      const cur = versions[0];
      const curDoc = await loadGuidelineVersion(cur);
      const seen = await readSeen();
      const checked = new Date().toISOString().slice(0, 10);
      const parts = [
        `📌 현행: ${cur.title} — ALIO '공공기관 법령/지침' 게시 ${cur.postedDate}${cur.publisher ? ` (${cur.publisher})` : ""}, 최신성 확인 ${checked}`,
        `개정 이력(최근 5): ${versions.slice(0, 5).map((v) => v.revDate).join(" · ")} (ALIO 게시 ${versions.length}건)`,
      ];
      const newer = seen ? versions.filter((v) => v.revDate > seen.revDate) : [];
      if (!seen) parts.push("이번이 첫 확인입니다.");
      else if (seen.boardNo === cur.boardNo) parts.push(`지난 확인(${seen.seenAt.slice(0, 10)}) 이후 새 개정 없음.`);
      else parts.push(`⚠️ 지난 확인(${seen.revDate} 개정본) 이후 새 개정 ${newer.length}건: ${newer.map((v) => v.revDate).join(", ")} — 아래 달라진 점을 사용자에게 설명하고 이 기준으로 검토하세요.`);

      const blocks = [];
      if (seen && seen.boardNo !== cur.boardNo) {
        const prev = versions.find((v) => v.boardNo === seen.boardNo);
        if (prev) blocks.push(fmtDiff("지난 확인 이후 달라진 점", prev, cur, diffUnits((await loadGuidelineVersion(prev)).units, curDoc.units)));
      }
      if (since) {
        const base = versionAt(versions, since);
        if (!base) blocks.push(`\n기준일 ${since} 이전 개정본이 ALIO 게시 목록에 없습니다(가장 오래된 것: ${versions.at(-1).revDate}).\n`);
        else if (base.boardNo === cur.boardNo) blocks.push(`\n기준일 ${since} 이후 지침 개정 없음 — 현행과 같습니다.\n`);
        else blocks.push(fmtDiff(`기준일 ${since} 당시 개정본 이후 달라진 점`, base, cur, diffUnits((await loadGuidelineVersion(base)).units, curDoc.units)));
      }
      if (!blocks.length && !articles?.length && !query && versions[1])
        blocks.push(fmtDiff("직전 개정 대비", versions[1], cur, diffUnits((await loadGuidelineVersion(versions[1])).units, curDoc.units)));

      if (articles?.length) {
        const { picked, missing } = pickArticles(curDoc.units, articles);
        if (missing.length) blocks.push(`\n⚠️ 현행 지침에 없는 조문: ${missing.join(", ")}\n`);
        picked.forEach((u) => blocks.push(`\n■ 현행 ${heading(u)}\n${clip(u.text, 4000)}\n`));
      }
      if (query) {
        const found = matchArticles(curDoc.units, query);
        blocks.push(found.length ? `\n현행 지침에서 '${query}' 일치 ${found.length}개` : `\n현행 지침에 '${query}' 가 들어간 조문 없음. 추측하지 마세요.\n`);
        found.forEach((u) => blocks.push(`\n■ ${heading(u)}\n${excerpt(u.text, query, 2000)}\n`));
      }

      await markSeen(cur);
      return text(joinCapped(parts.join("\n") + "\n", blocks, "항목"));
    },
    { header: false }
  );

  tool(
    "alio_write_hwpx",
    `마크다운을 한글 문서(HWPX, 보고서 양식)로 저장하고 경로를 반환한다. 개정안·검토보고서·신구조문 대비표를 한글 파일로 줄 때 쓴다.
  서식 기준(자동 적용): 글꼴 ${HOUSE_STYLE.font}(※·별첨으로 시작하는 문단은 ${HOUSE_STYLE.refFont}), 본문 ${HOUSE_STYLE.bodyPt}pt, 표 안 ${HOUSE_STYLE.tablePt}pt, 한글 어절·영어 단어 단위 줄 나눔, 양쪽 정렬.
  마크다운 작성법:
  - '# 제목' → 문서 제목, 제목 바로 뒤 '> 문장' → 요약 상자, '## 장 제목' → Ⅰ·Ⅱ 장 머리
  - '- 항목' → □, 들여쓴 '  - 항목' → ○, 한 번 더 들여쓰면 - (개조식: '~함', 명사형으로 끝맺기)
  - 표는 GFM 표. 셀 안 줄바꿈은 <br>
  - 신구조문 대비표: 머리행을 '| 현 행 | 개 정 안 | 사유·근거 |'로 쓰면 열 너비 37:37:26, 셀 안 **굵게** 표시한 바뀐 부분은 밑줄로 바뀐다. 개정안 칸에서 현행과 같은 부분은 '------'로 줄여 쓴다
  - '※ 문장' → 참고 문단(${HOUSE_STYLE.refFont})`,
    {
      markdown: z.string().describe("문서 내용 (마크다운)"),
      fileName: z.string().describe("저장 파일명 (예: 'OO세칙_개정안(초안)_2026-09-29'). .hwpx 는 자동으로 붙는다"),
      reportInfo: z.string().optional().describe("제목 아래 한 줄 (예: '(2026. 9. 29., 초안)')"),
      outDir: z.string().optional().describe(`저장 폴더 (기본 ${OUTPUT_DIR})`),
    },
    async ({ markdown, fileName, reportInfo, outDir }) => {
      const { buffer, stats, warnings } = await markdownToStyledHwpx(markdown, { reportInfo });
      const dest = await writeNewFile(outDir || OUTPUT_DIR, fileName, ".hwpx", buffer);
      return text(
        `저장 완료: ${dest} (${buffer.length.toLocaleString()} bytes)\n` +
          `- 본문 문단 ${stats.body}개(${HOUSE_STYLE.bodyPt}pt) · 표 안 문단 ${stats.table}개(${HOUSE_STYLE.tablePt}pt) · 제목 상자 ${stats.box}개(크기 유지)\n` +
          (stats.cmpTables ? `- 신구조문 대비표 ${stats.cmpTables}개: 열 너비 조정, 굵게 표시 → 밑줄\n` : "") +
          (stats.ref.length ? `- ${HOUSE_STYLE.refFont} 적용 문단 ${stats.ref.length}개\n` : "") +
          (stats.midRef.length ? `⚠️ 문장 중간에 ※가 있어 글꼴을 바꾸지 않은 문단: ${stats.midRef.join(" / ")}\n` : "") +
          warnings.map((w) => `⚠️ ${w}\n`).join("") +
          `※ 여러 쪽에 걸친 표는 한글에서 열어 확인하세요. HWP 형식이 필요하면 한글에서 '다른 이름으로 저장'으로 바꿉니다.`
      );
    }
  );

  server.registerPrompt(
    "review_rule",
    {
      title: "내규 검토 (최신 지침 기준)",
      description: "자사 규정을 현행 「공공기관의 혁신에 관한 지침」과 타 기관 규정에 비추어 검토하는 기본 절차",
      argsSchema: {
        org: z.string().describe("자사 기관명 (예: 한국인터넷진흥원)"),
        rule: z.string().describe("검토할 규정 제목 키워드 (예: 혁신, 복무)"),
        focus: z.string().optional().describe("특히 볼 항목 (예: 위원회 구성, 보상)"),
      },
    },
    ({ org, rule, focus }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `${org}의 '${rule}' 관련 규정을 검토해 개정 필요 사항을 정리해 주세요.${focus ? ` 특히 ${focus}을(를) 중점적으로 봐 주세요.` : ""}\n\n` +
              `${REVIEW_FRAME}\n\n0단계에서 alio_guideline 을 호출할 때 since 에는 1단계에서 확인한 ${org} 규정의 시행일을 넣으세요(먼저 규정 시행일을 확인).`,
          },
        },
      ],
    })
  );

  return server;
}

// stdio 로 시작한다. 보통은 src/main.js 가 부른다(모듈을 불러오기 전에 stdout 보호). node src/server.js 로 바로 실행해도 동작한다.
export async function start() {
  // stdout 은 MCP 통신 전용 — 의존 라이브러리가 console 로 찍는 글이 통신을 깨지 않게 stderr 로 돌린다
  const toStderr = (...a) => process.stderr.write(a.map(String).join(" ") + "\n");
  console.log = console.info = console.debug = console.warn = toStderr;
  await createServer().connect(new StdioServerTransport());
  console.error(`alio-mcp ${VERSION} running (stdio)`);
  // 전체 규정 목록 중 오래된 기관을 뒤에서 천천히 갱신(비슷한 규정 찾기가 기다리지 않게)
  if (process.env.ALIO_BACKGROUND_REFRESH !== "0") refreshInBackground();
}

let isMain = false;
try {
  isMain = !!process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
} catch {}
if (isMain)
  start().catch((e) => {
    console.error(e);
    process.exit(1);
  });
