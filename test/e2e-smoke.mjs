// 설치본 동작 확인: node test/e2e-smoke.mjs [server.js 경로] [--offline]
// 새 사용자 환경처럼 빈 홈 폴더에서 서버를 띄워 도구를 부른다. 기본은 ALIO 실호출, --offline 은 네트워크 없이 되는 것만.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const offline = process.argv.includes("--offline");
const server = path.resolve(process.argv.slice(2).find((a) => !a.startsWith("--")) || "src/server.js");
const home = await fs.mkdtemp(path.join(os.tmpdir(), "alio-home-"));
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, "AppData", "Local") };
// Windows 는 이 값들이 없으면 네트워크·임시 폴더가 동작하지 않는다
for (const k of ["SystemRoot", "windir", "TEMP", "TMP", "ComSpec", "PATHEXT"]) if (process.env[k]) env[k] = process.env[k];
// 설치 설정을 비워 둔 확장처럼 치환되지 않은 값을 넘긴다 → 기본 폴더로 떨어져야 한다
env.ALIO_OUTPUT_DIR = "${user_config.output_dir}";

const client = new Client({ name: "e2e-smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env, stderr: "ignore" }));

let failed = 0;
async function step(label, name, args, check) {
  const t = Date.now();
  try {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
    const body = r.content?.[0]?.text || "";
    const why = r.isError ? "isError" : check(body);
    console.log(`${why ? "✖" : "✔"} ${label} (${((Date.now() - t) / 1000).toFixed(1)}s)${why ? ` — ${why}\n${body.slice(0, 600)}` : ""}`);
    if (why) failed++;
    return body;
  } catch (e) {
    console.log(`✖ ${label} — ${e.message}`);
    failed++;
    return "";
  }
}

const tools = (await client.listTools()).tools.map((t) => t.name);
console.log(`도구 ${tools.length}개: ${tools.join(", ")}`);
if (tools.length !== 8) failed++;

if (!offline) {
  await step("지침 최신성·조문", "alio_guideline", { articles: ["제11조"] }, (b) => (/📌 현행/.test(b) && /제11조/.test(b) ? "" : "지침 조문 없음"));
  const found = await step("제목 검색", "alio_search_rules", { orgName: "한국인터넷진흥원", keyword: "혁신" }, (b) => (/apbaId=\S+ idx=\d+/.test(b) ? "" : "검색 결과 없음"));
  const m = found.match(/apbaId=(\S+) idx=(\d+) cat=(\S+)/);
  if (m) await step("본문 목차(검색 결과 규정)", "alio_read_rule", { apbaId: m[1], idx: m[2], category: m[3] }, (b) => (/목차:/.test(b) ? "" : "목차 없음"));
  for (const [label, apbaId, idx] of [
    ["PDF 규정 본문", "C0129", "36588"],
    ["HWP 규정 본문", "C0082", "19714"],
    ["HWPX 규정 본문", "C0352", "9578"],
    ["ZIP 안 HWPX 규정 본문", "C0352", "9464"],
  ])
    await step(label, "alio_read_rule", { apbaId, idx }, (b) => (/조문 [1-9]\d*개/.test(b) ? "" : "조문 분할 실패"));
  await step("본문 검색", "alio_search_text", { orgName: "한국인터넷진흥원", titleKeyword: "혁신", query: "위원회" }, (b) => (/조문 일치/.test(b) ? "" : "형식 이상"));
  await step("원문 내려받기", "alio_download_rule", { apbaId: "C0082", idx: "19714", org: "한국서부발전", title: "경영혁신활동 운영기준" }, (b) =>
    b.includes(path.join(home, "Documents", "alio-mcp", "downloads")) ? "" : "기본 폴더가 아님"
  );
}
const md = "# 시험 문서\n\n> 요약\n\n## 내용\n\n- 항목\n\n| 현 행 | 개 정 안 | 사유 |\n| --- | --- | --- |\n| **가** | **나** | 다 |\n\n※ 참고\n";
const saved = await step("한글 문서 저장", "alio_write_hwpx", { markdown: md, fileName: "시험:문서" }, (b) =>
  b.includes(path.join(home, "Documents", "alio-mcp", "시험_문서.hwpx")) ? "" : "저장 위치·파일명 이상"
);
if (saved) {
  const f = path.join(home, "Documents", "alio-mcp", "시험_문서.hwpx");
  const head = (await fs.readFile(f)).subarray(30, 38).toString();
  console.log(`${head === "mimetype" ? "✔" : "✖"} 저장된 HWPX 구조`);
  if (head !== "mimetype") failed++;
}
const cacheDir =
  process.platform === "darwin"
    ? path.join(home, "Library", "Caches", "alio-mcp")
    : process.platform === "win32"
      ? path.join(env.LOCALAPPDATA, "alio-mcp", "cache")
      : path.join(home, ".cache", "alio-mcp");
if (!offline) {
  const n = (await fs.readdir(cacheDir).catch(() => [])).length;
  console.log(`${n ? "✔" : "✖"} 캐시 기본 위치 (${n}개 파일)`);
  if (!n) failed++;
}

await client.close();
await fs.rm(home, { recursive: true, force: true });
console.log(failed ? `\n실패 ${failed}건` : "\n모두 통과");
process.exit(failed ? 1 : 0);
