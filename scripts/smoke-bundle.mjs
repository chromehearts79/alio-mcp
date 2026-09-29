// 만든 확장 번들을 새 폴더에 풀어, 빈 홈 폴더에서 실제로 띄워 본다.
//   node scripts/smoke-bundle.mjs           오프라인 점검(도구 목록·한글 문서 저장·stdout)
//   node scripts/smoke-bundle.mjs --live    ALIO 실호출까지(규정 검색·PDF/HWP/HWPX/ZIP 본문·원문 받기)
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mcpb } from "./lib.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const bundle = path.join(root, "dist", `alio-mcp-${version}.mcpb`);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "alio-bundle-"));
try {
  mcpb(["unpack", bundle, dir], { stdio: "pipe" });
  const args = [path.join(root, "test", "e2e-smoke.mjs"), path.join(dir, "src", "main.js")];
  if (!process.argv.includes("--live")) args.push("--offline");
  execFileSync(process.execPath, args, { stdio: "inherit" });
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
