// 저장 위치 — 환경변수가 있으면 따르고, 없으면 OS별 표준 위치를 쓴다.
import os from "node:os";
import path from "node:path";

const home = os.homedir();

// 캐시(규정 본문·지침·파일 목록): 지워도 다시 받아지는 데이터
function defaultCacheDir() {
  if (process.platform === "win32")
    return path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "alio-mcp", "cache");
  if (process.platform === "darwin") return path.join(home, "Library", "Caches", "alio-mcp");
  return path.join(process.env.XDG_CACHE_HOME || path.join(home, ".cache"), "alio-mcp");
}

// 빈 값이나 치환되지 않은 설치 설정("${user_config.…}")은 없는 것으로 본다
const env = (k) => {
  const v = (process.env[k] || "").trim();
  return v && !v.includes("${") ? v : "";
};

export const CACHE_DIR = env("ALIO_CACHE_DIR") || defaultCacheDir();
// 사용자가 열어 볼 파일(만든 한글 문서, 내려받은 규정 원문)
export const OUTPUT_DIR = env("ALIO_OUTPUT_DIR") || path.join(home, "Documents", "alio-mcp");
export const DOWNLOAD_DIR = path.join(OUTPUT_DIR, "downloads");
