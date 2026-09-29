#!/usr/bin/env node
// 실행 진입점. stdout 은 MCP 통신 전용이라, 어떤 모듈을 불러오기도 전에 console 출력을 stderr 로 돌린다.
// (server.js 를 바로 실행하면 kordoc 등 큰 모듈을 불러오는 동안 찍힌 글이 stdout 으로 샐 수 있다 — Windows 에서 재현)
const toStderr = (...a) => process.stderr.write(a.map(String).join(" ") + "\n");
console.log = console.info = console.debug = console.warn = toStderr;

const { start } = await import("./server.js");
await start().catch((e) => {
  console.error(e);
  process.exit(1);
});
