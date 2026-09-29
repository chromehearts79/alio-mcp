// 스냅샷 비교. 어느 한쪽에서라도 조회 실패한 기관의 규정은 신설/폐지로 판정하지 않고 보류한다.
// 규정 idx 는 명칭이 바뀌어도 유지되므로 제목이 아닌 idx 로 대조한다.
const key = (r) => `${r.apbaId}|${r.idx}`;

// v1 스냅샷은 hits 배열만 저장했고 기관당 첫 페이지(최대 10건)만 담겼다.
export function normalizeSnapshot(raw) {
  if (!Array.isArray(raw)) return { version: raw.version || 2, hits: raw.hits || [], failed: raw.failed || [], truncatedOrgs: [] };
  const perOrg = new Map();
  for (const r of raw) perOrg.set(r.org, (perOrg.get(r.org) || 0) + 1);
  const truncatedOrgs = [...perOrg].filter(([, n]) => n >= 10).map(([org]) => org);
  return { version: 1, hits: raw, failed: [], truncatedOrgs };
}

export function diffSnapshots(prev, curr) {
  const unsure = new Set([...prev.failed, ...curr.failed].map((f) => f.apbaId));
  const prevMap = new Map(prev.hits.map((r) => [key(r), r]));
  const currMap = new Map(curr.hits.map((r) => [key(r), r]));

  const added = curr.hits.filter((r) => !prevMap.has(key(r)) && !unsure.has(r.apbaId));
  const removed = prev.hits.filter((r) => !currMap.has(key(r)) && !unsure.has(r.apbaId));
  const revised = curr.hits
    .filter((r) => {
      const p = prevMap.get(key(r));
      return p && (p.enfDate !== r.enfDate || p.title !== r.title);
    })
    .map((r) => {
      const p = prevMap.get(key(r));
      return { ...r, prevEnfDate: p.enfDate, prevTitle: p.title !== r.title ? p.title : undefined };
    });

  return { added, removed, revised, unsureOrgs: [...unsure] };
}
