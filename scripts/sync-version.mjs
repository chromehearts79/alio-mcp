// `npm version <patch|minor|major>` 때 자동 실행(package.json "version" 스크립트).
// package.json 의 새 버전을 manifest.json 에 옮기고, CHANGELOG 의 [Unreleased] 를 그 버전 항목으로 연다.
// npm 이 이 두 파일까지 같은 커밋·태그(vX.Y.Z)에 넣는다 → 태그를 올리면 릴리스 워크플로가 번들을 게시.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = (f) => path.join(root, f);
const { version } = JSON.parse(fs.readFileSync(file("package.json"), "utf8"));

const mf = fs.readFileSync(file("manifest.json"), "utf8");
fs.writeFileSync(file("manifest.json"), mf.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));

let log = fs.readFileSync(file("CHANGELOG.md"), "utf8");
if (!new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`, "m").test(log)) {
  const date = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }); // YYYY-MM-DD
  const body = log.split(/^## \[Unreleased\]\s*$/m)[1]?.split(/^## \[/m)[0] ?? "";
  if (!body.trim()) {
    console.error("CHANGELOG.md 의 [Unreleased] 가 비어 있습니다. 바뀐 점을 적은 뒤 다시 올리세요.");
    process.exit(1);
  }
  log = log.replace(/^## \[Unreleased\][ \t]*$/m, `## [Unreleased]\n\n## [${version}] - ${date}`);
  const prev = log.match(/^\[Unreleased\]: .*compare\/(v[^.]+\.[^.]+\.[^.]+)\.\.\.HEAD$/m)?.[1];
  if (prev)
    log = log.replace(
      /^\[Unreleased\]: .*$/m,
      `[Unreleased]: https://github.com/chromehearts79/alio-mcp/compare/v${version}...HEAD\n[${version}]: https://github.com/chromehearts79/alio-mcp/compare/${prev}...v${version}`
    );
  fs.writeFileSync(file("CHANGELOG.md"), log);
}

execFileSync("git", ["add", "manifest.json", "CHANGELOG.md"], { cwd: root, stdio: "inherit" });
console.log(`manifest.json·CHANGELOG.md → ${version}`);
