// MCP 서버 하네스 — 오프라인 테스트. 메모리 전송으로 실제 클라이언트를 붙여 도구를 부른다.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "alio-server-test-"));
// 캐시·저장 위치는 경로 모듈을 불러오기 전에 정해야 한다
process.env.ALIO_CACHE_DIR = path.join(tmp, "cache");
process.env.ALIO_OUTPUT_DIR = path.join(tmp, "out");
const { createServer, VERSION } = await import("../src/server.js");
const { settings, clearCaches } = await import("../src/alio-client.js");

const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
const readme = await fs.readFile(path.join(root, "README.md"), "utf8");
const orgsJson = await fs.readFile(path.join(root, "test", "fixtures", "orgs.json"), "utf8");

// 네트워크 대체: 기관 목록은 실제 응답, 나머지는 라우터가 정한다
const realFetch = globalThis.fetch;
let route;
let calls = 0;
globalThis.fetch = async (url, init) => {
  calls++;
  return route(String(url), init);
};
const json = (o) => new Response(typeof o === "string" ? o : JSON.stringify(o), { headers: { "content-type": "application/json" } });
const offline = () => {
  throw new TypeError("fetch failed (오프라인 테스트)");
};

let client;
before(async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  client = new Client({ name: "test", version: "0" });
  await client.connect(b);
});
after(async () => {
  await client.close();
  globalThis.fetch = realFetch;
  await fs.rm(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  route = offline;
  calls = 0;
  settings.retries = 0;
  settings.delayMs = 0;
  settings.retryBaseMs = 0;
  clearCaches();
});

const call = (name, args, opts) => client.callTool({ name, arguments: args }, undefined, opts);
const bodyOf = (r) => r.content.map((c) => c.text).join("\n");

test("버전: 서버·package.json·manifest 가 같다", () => {
  assert.equal(VERSION, pkg.version);
  assert.equal(client.getServerVersion().version, pkg.version);
  assert.equal(manifest.version, pkg.version);
});

test("도구 목록: 등록 = manifest = README 표", async () => {
  const registered = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(manifest.tools.map((t) => t.name).sort(), registered);
  const inReadme = [...readme.matchAll(/^\| `(alio_\w+)` \|/gm)].map((m) => m[1]).sort();
  assert.deepEqual(inReadme, registered);
});

// Windows 는 관리자·개발자 모드가 아니면 링크를 만들 수 없다 → 그 부분만 건너뛴다
const trySymlink = (target, p) => fs.symlink(target, p).then(() => true, (e) => (e.code === "EPERM" ? false : Promise.reject(e)));

test("한글 문서 저장: 같은 이름은 번호를 붙이고, 링크 자리는 건너뛴다", async (t) => {
  const out = path.join(tmp, "docs");
  const md = "# 제목\n\n- 항목\n";
  const r1 = bodyOf(await call("alio_write_hwpx", { markdown: md, fileName: "개정안", outDir: out }));
  assert.match(r1, /개정안\.hwpx/);
  const r2 = bodyOf(await call("alio_write_hwpx", { markdown: md, fileName: "개정안.hwpx", outDir: out }));
  assert.match(r2, /개정안 \(2\)\.hwpx/);

  // "개정안 (3).hwpx" 자리에 다른 파일을 가리키는 링크를 둔다 → 따라가 덮어쓰면 안 된다
  const victim = path.join(tmp, "victim.txt");
  await fs.writeFile(victim, "원본");
  if (!(await trySymlink(victim, path.join(out, "개정안 (3).hwpx")))) return t.skip("이 환경에서는 링크를 만들 수 없음");
  // "개정안 (4).hwpx" 자리엔 아직 없는 파일을 가리키는 링크 → 따라가 새 파일을 만들면 안 된다
  const planted = path.join(tmp, "planted.hwpx");
  await trySymlink(planted, path.join(out, "개정안 (4).hwpx"));
  const r3 = bodyOf(await call("alio_write_hwpx", { markdown: md, fileName: "개정안", outDir: out }));
  assert.match(r3, /개정안 \(5\)\.hwpx/);
  assert.equal(await fs.readFile(victim, "utf8"), "원본");
  await assert.rejects(fs.access(planted), "링크를 따라 밖에 파일이 생김");
});

test("저장 오류는 원인과 조치를 알려 준다", async () => {
  const notDir = path.join(tmp, "file.txt");
  await fs.writeFile(notDir, "x");
  const r = await call("alio_write_hwpx", { markdown: "# t\n", fileName: "a", outDir: path.join(notDir, "sub") });
  assert.equal(r.isError, true);
  assert.match(bodyOf(r), /파일 저장 오류 \[(ENOTDIR|EEXIST)\].*\n→ 저장 폴더/);
});

test("ALIO 연결 실패는 종류와 조치를 알려 준다", async () => {
  const r = await call("alio_read_rule", { apbaId: "C0000", idx: "1" });
  assert.equal(r.isError, true);
  assert.match(bodyOf(r), /\[NETWORK\].*\n→ ALIO\(www\.alio\.go\.kr\)에 연결하지 못했습니다/);
});

test("요청을 취소하면 서버도 조회를 멈춘다", async () => {
  // 기관 목록은 바로, 기관별 검색은 건당 100ms 걸리는 사이트
  route = async (u) => {
    if (u.endsWith("/item/itemOrganListSusi.json")) return json(orgsJson);
    if (u.includes("/etc/")) return offline();
    await new Promise((r) => setTimeout(r, 100));
    return json({ data: { result: [], page: { totalPage: 0, totalCount: 0 } } });
  };
  const ac = new AbortController();
  const pending = call("alio_search_rules", { keyword: "없는규정" }, { signal: ac.signal });
  await new Promise((r) => setTimeout(r, 350));
  ac.abort();
  await assert.rejects(pending);
  await new Promise((r) => setTimeout(r, 300)); // 진행 중이던 요청이 끝날 시간
  const atStop = calls;
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(calls, atStop, `취소 뒤에도 조회가 계속됨 (${atStop} → ${calls})`);
  assert.ok(atStop < 60, `취소 전 조회 수가 너무 많음: ${atStop}`);
});

test("직접 실행하면 라이브러리의 console 출력이 stdout(통신)을 오염시키지 않는다", async () => {
  const noise = `data:text/javascript,setTimeout(()=>{console.log("NOISE-LOG");console.info("NOISE-INFO")},300)`;
  const p = spawn(process.execPath, ["--import", noise, path.join(root, "src", "server.js")], {
    env: { ...process.env, ALIO_CACHE_DIR: path.join(tmp, "cache2"), ALIO_OUTPUT_DIR: path.join(tmp, "out2"), ALIO_BACKGROUND_REFRESH: "0" },
  });
  let out = "";
  let err = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  p.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) + "\n"
  );
  await new Promise((r) => setTimeout(r, 1200));
  p.kill();
  const lines = out.split("\n").filter(Boolean);
  assert.ok(lines.length >= 1, "initialize 응답 없음");
  for (const l of lines) assert.doesNotThrow(() => JSON.parse(l), `JSON 이 아닌 stdout 줄: ${l}`);
  assert.match(err, /NOISE-LOG/);
  assert.match(err, /NOISE-INFO/);
});
