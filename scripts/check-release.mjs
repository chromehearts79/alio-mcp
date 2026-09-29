// 출시 전 검사 — 어긋나면 exit 1.
//   node scripts/check-release.mjs                 버전·CHANGELOG·npm 패키지 파일 목록·manifest
//   node scripts/check-release.mjs --tag v0.5.1    릴리스 태그가 버전과 같은지, CHANGELOG 에 그 버전 항목이 있는지
//   node scripts/check-release.mjs --bundle        dist/alio-mcp-<버전>.mcpb 구성(필수 파일·빠져야 할 선택 의존성·크기)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { mcpb, npm } from "./lib.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const arg = (k) => {
  const i = process.argv.indexOf(k);
  return i === -1 ? undefined : process.argv[i + 1] ?? "";
};
const problems = [];
const check = (ok, msg) => ok || problems.push(msg);

const pkg = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));
const manifest = JSON.parse(read("manifest.json"));
const changelog = read("CHANGELOG.md");
const v = pkg.version;

// 1. 버전 한 곳 관리
check(manifest.version === v, `manifest.json 버전 ${manifest.version} ≠ package.json ${v}`);
check(lock.version === v && lock.packages?.[""]?.version === v, `package-lock.json 버전 ${lock.version} ≠ package.json ${v} (npm install 로 갱신)`);
check(/^## \[Unreleased\]/m.test(changelog), "CHANGELOG.md 에 '## [Unreleased]' 항목이 없음");
const tag = arg("--tag");
if (tag !== undefined) {
  check(tag === `v${v}`, `릴리스 태그 ${tag} ≠ v${v}`);
  check(new RegExp(`^## \\[${v.replace(/\./g, "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}`, "m").test(changelog), `CHANGELOG.md 에 '## [${v}] - 날짜' 항목이 없음 (npm version 으로 올리면 자동)`);
}

// 2. manifest 형식 (MCPB 스키마)
try {
  mcpb(["validate", path.join(root, "manifest.json")], { stdio: "pipe" });
} catch (e) {
  problems.push(`manifest.json 스키마 오류:\n${e.stdout || e.message}`);
}

// 3. npm 패키지 파일 목록: 실행에 필요한 파일은 다 있고, 개발용 파일은 없어야 한다
const packed = JSON.parse(npm(["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" }))[0].files.map((f) => f.path.replace(/\\/g, "/"));
const srcFiles = fs.readdirSync(path.join(root, "src")).filter((f) => f.endsWith(".js")).map((f) => `src/${f}`);
for (const f of [...srcFiles, "package.json", "manifest.json", "README.md", "LICENSE"]) check(packed.includes(f), `npm 패키지에 ${f} 가 빠짐`);
for (const f of packed) check(!/^(test|bench|scripts|dist|\.github)\//.test(f), `npm 패키지에 개발용 파일 포함: ${f}`);
// src 안 상대 경로 import 가 모두 패키지 안 파일을 가리키는지
for (const f of srcFiles)
  for (const m of read(f).matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["'](\.\.?\/[^"']+)["']/g)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
    check(packed.includes(target) || m[1] === "../package.json", `${f} 가 불러오는 ${m[1]} 이 패키지에 없음`);
  }
const bin = Object.values(pkg.bin)[0];
check(read(bin).startsWith("#!/usr/bin/env node"), `${bin} 첫 줄에 #!/usr/bin/env node 가 없음`);
check(manifest.server.entry_point === bin, `manifest entry_point ${manifest.server.entry_point} ≠ package bin ${bin}`);

// 4. 확장 번들 구성
if (process.argv.includes("--bundle")) {
  const file = path.join(root, "dist", `alio-mcp-${v}.mcpb`);
  if (!fs.existsSync(file)) problems.push(`번들이 없음: dist/alio-mcp-${v}.mcpb (npm run bundle)`);
  else {
    const size = fs.statSync(file).size;
    const names = Object.keys((await JSZip.loadAsync(fs.readFileSync(file))).files);
    const has = (p) => names.some((n) => n === p || n.startsWith(p + "/"));
    for (const p of ["manifest.json", bin, "node_modules/kordoc", "node_modules/pdfjs-dist", "node_modules/@modelcontextprotocol/sdk"]) check(has(p), `번들에 ${p} 가 빠짐`);
    for (const p of ["node_modules/onnxruntime-node", "node_modules/onnxruntime-web", "node_modules/@huggingface", "node_modules/sharp", "node_modules/@anthropic-ai/mcpb"]) check(!has(p), `번들에 빠져야 할 ${p} 가 들어감`);
    const natives = names.filter((n) => n.endsWith(".node"));
    check(!natives.length, `번들에 OS 전용 바이너리가 있음(다른 OS에서 실패): ${natives.slice(0, 3).join(", ")}`);
    check(size < 25 * 1024 * 1024, `번들이 너무 큼: ${(size / 1024 / 1024).toFixed(1)}MB`);
    console.log(`번들: ${names.length}개 파일, ${(size / 1024 / 1024).toFixed(1)}MB`);
  }
}

if (problems.length) {
  console.error(`✖ 출시 전 검사 실패 ${problems.length}건\n` + problems.map((p) => `- ${p}`).join("\n"));
  process.exit(1);
}
console.log(`✔ 출시 전 검사 통과 (v${v}${tag ? `, 태그 ${tag}` : ""})`);
