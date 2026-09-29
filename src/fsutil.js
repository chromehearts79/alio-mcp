// 사용자 폴더에 파일 쓰기. 저장 위치는 AI가 인자로 정하므로, 링크를 따라가 엉뚱한 파일을 덮어쓰지 않게 한다.
import fs from "node:fs/promises";
import path from "node:path";

export class UnsafePathError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsafePathError";
    this.code = "EUNSAFEPATH";
  }
}

const lstat = (p) => fs.lstat(p).catch(() => null);

// overwrite=false: 이미 있으면(링크 포함) EEXIST 로 실패한다.
// overwrite=true : 링크면 거부하고, 같은 폴더의 임시 파일에 쓴 뒤 바꿔 넣는다(쓰다 끊겨도 원본이 깨지지 않음).
export async function writeFileSafe(file, data, { overwrite = false } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (!overwrite) return fs.writeFile(file, data, { flag: "wx" });
  if ((await lstat(file))?.isSymbolicLink()) throw new UnsafePathError(`저장 경로가 링크(바로가기)여서 쓰지 않았습니다: ${file}`);
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.writeFile(tmp, data, { flag: "wx" });
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

// 파일명에 쓸 수 없는 문자를 바꾸고, 같은 이름이 있으면(링크 포함) 번호를 붙인 새 파일로 쓴다.
export async function writeNewFile(dir, name, ext, data) {
  const base = name.replace(new RegExp(`\\${ext}$`, "i"), "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim() || "문서";
  for (let i = 1; i < 1000; i++) {
    const file = path.join(dir, `${base}${i > 1 ? ` (${i})` : ""}${ext}`);
    if (await lstat(file)) continue;
    try {
      await writeFileSafe(file, data);
      return file;
    } catch (e) {
      if (e.code !== "EEXIST") throw e; // 그 사이 다른 파일이 생기면 다음 번호로
    }
  }
  throw new UnsafePathError(`같은 이름의 파일이 너무 많습니다: ${path.join(dir, base + ext)}`);
}
