// 스크립트 공용: npm·mcpb 를 셸 없이 node 로 직접 실행한다(Windows 의 .cmd·공백 경로 문제 회피).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// 패키지가 package.json 을 exports 로 열지 않아, 진입점에서 위로 올라가며 찾는다
function mcpbCli() {
  let dir = path.dirname(require.resolve("@anthropic-ai/mcpb"));
  while (!fs.existsSync(path.join(dir, "package.json")) || JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name !== "@anthropic-ai/mcpb") {
    const up = path.dirname(dir);
    if (up === dir) throw new Error("@anthropic-ai/mcpb 를 찾지 못함 (npm install 필요)");
    dir = up;
  }
  const { bin } = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  return path.join(dir, typeof bin === "string" ? bin : Object.values(bin)[0]);
}

export const mcpb = (args, opts = {}) => execFileSync(process.execPath, [mcpbCli(), ...args], opts);

// npm run 으로 실행되면 npm_execpath 가 npm 본체(npm-cli.js)를 가리킨다
export function npm(args, opts = {}) {
  const cli = process.env.npm_execpath;
  if (cli && /\.[cm]?js$/.test(cli)) return execFileSync(process.execPath, [cli, ...args], opts);
  const win = process.platform === "win32";
  return execFileSync(win ? "npm.cmd" : "npm", win ? args.map((a) => `"${a}"`) : args, { ...opts, shell: win });
}
