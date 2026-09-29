// Claude 데스크톱 확장(.mcpb) 만들기: 실행에 필요한 파일과 의존성만 모아 묶는다.
// OCR·이미지 처리용 선택 의존성(수백 MB)은 빼고, PDF 본문 추출용 pdfjs-dist 는 직접 의존성으로 포함된다.
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
if (manifest.version !== pkg.version) throw new Error(`버전 불일치: manifest ${manifest.version} / package ${pkg.version}`);

const dist = path.join(root, "dist");
const stage = path.join(dist, "bundle");
await fs.rm(stage, { recursive: true, force: true });
await fs.mkdir(stage, { recursive: true });
for (const f of ["src", "manifest.json", "package.json", "package-lock.json", "README.md", "LICENSE"])
  await fs.cp(path.join(root, f), path.join(stage, f), { recursive: true });

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
execFileSync(npm, ["ci", "--omit=dev", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stage, stdio: "inherit" });

const mcpb = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "mcpb.cmd" : "mcpb");
const out = path.join(dist, `alio-mcp-${pkg.version}.mcpb`);
execFileSync(mcpb, ["validate", path.join(stage, "manifest.json")], { stdio: "inherit" });
execFileSync(mcpb, ["pack", stage, out], { stdio: "inherit" });
const { size } = await fs.stat(out);
console.log(`\n→ ${path.relative(root, out)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
