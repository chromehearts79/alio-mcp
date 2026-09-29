// 실제 ALIO 응답을 test/fixtures 에 저장한다. 사이트 구조가 바뀌면 다시 실행해 갱신.
// 사용: node test/capture-fixtures.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const BASE = "https://www.alio.go.kr";
const H = {
  "User-Agent": "Mozilla/5.0",
  Referer: `${BASE}/item/itemOrganList.do?reportFormRootNo=21110`,
  Origin: BASE,
  "Content-Type": "application/json",
};
const post = (u, b) =>
  fetch(BASE + u, { method: "POST", headers: H, body: JSON.stringify(b) }).then((r) => r.json());

await fs.mkdir(dir, { recursive: true });

const orgs = await post("/item/itemOrganListSusi.json", {
  apbaType: [], jidtDptm: [], area: [], apbaId: "", reportFormRootNo: "21110",
});
await fs.writeFile(path.join(dir, "orgs.json"), JSON.stringify(orgs));

const inc = orgs.data.organList.find((o) => o.apbaId === "C0105");
const pages = {};
for (let p = 1; ; p++) {
  pages[p] = await post("/item/itemReportListSusi.json", {
    pageNo: p, apbaId: "C0105", apbaType: inc.apbaType, reportFormRootNo: "21110",
    search_word: "", search_flag: "title", bid_type: "", enfc_istt: "",
  });
  if (p >= pages[1].data.page.totalPage) break;
}
await fs.writeFile(path.join(dir, "search_C0105_all.json"), JSON.stringify(pages));

const qs = new URLSearchParams({
  disclosureNo: "null", apbaId: "C0105", nowcode: "21110", reportFormNo: "21110",
  table_name: "COMM_RULE", idx_name: "RULE_NO", idx: "21892", reportGbn: "N", bid_type: "K1100",
});
const html = await fetch(`${BASE}/item/itemBoard21110.do?${qs}`, { headers: H }).then((r) => r.text());
await fs.writeFile(path.join(dir, "detail_C0105_21892.html"), html);

// '공공기관 법령/지침' 게시판 전체(분야별 기준 지침)
const board = {};
for (let p = 1; ; p++) {
  const q = new URLSearchParams({ type: "title", word: "", pageNo: String(p) });
  board[p] = await fetch(`${BASE}/etc/findEtcLawList.json?${q}`, { headers: H }).then((r) => r.json());
  if (p >= board[1].data.page.totalPage) break;
}
await fs.writeFile(path.join(dir, "guideline_board.json"), JSON.stringify(board));

console.log(
  `orgs=${orgs.data.organList.length} pages=${Object.keys(pages).length} board=${Object.keys(board).length}쪽 ` +
    `totalCount=${pages[1].data.page.totalCount} detail=${html.length}B`
);
