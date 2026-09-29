// 내규 분야 사전: 같은 성격의 규정이 기관마다 다른 이름으로 올라오므로(예: 경영혁신규정·혁신경영 실행지침·
// 변화혁신위원회규정) 분야별로 제목 낱말을 묶는다. 낱말은 ALIO 공시 규정 3만 6천여 건의 제목 빈도를 보고 골랐다.
//   strong : 제목에 있으면 그 분야
//   weak   : 그 분야일 수도 있음(본문 비교로 가림)
//   exclude: weak 만 맞고 이 말이 있으면 다른 성격(예: 혁신도시·기술혁신 → 경영혁신 아님)
//   guidelines: 이 분야 규정을 검토할 때 볼 정부 지침(ALIO '공공기관 법령/지침' 게시판 제목 일부)
export const GROUPS = [
  {
    id: "혁신",
    name: "경영혁신",
    strong: ["경영혁신", "혁신경영", "열린경영혁신", "변화혁신", "혁신추진", "혁신계획", "혁신협의체", "조직문화개선"],
    // '혁신위원회'·'혁신활동'은 환자경험혁신위원회·안전보건 혁신활동처럼 다른 성격에도 쓰여 본문으로 가린다
    weak: ["혁신"],
    exclude: ["혁신도시", "기술혁신", "혁신성장", "혁신사업", "혁신센터", "혁신밸리", "혁신융합", "혁신클러스터", "혁신지구", "혁신금융", "혁신형", "혁신아이콘", "혁신스타트업", "혁신리딩", "혁신프리미어", "혁신기술", "혁신벤처", "교육혁신", "대학혁신", "구조혁신", "디지털혁신", "AX혁신", "혁신제안", "규제혁신", "혁신관리시스템", "혁신대회", "혁신적", "혁신역량", "혁신마일리지"],
    guidelines: ["공공기관의 혁신에 관한 지침"],
  },
  { id: "제안", name: "제안제도", strong: ["제안제도", "혁신제안", "창의제안", "업무개선제안", "제안심사", "혁신마일리지", "혁신역량마일리지"], weak: ["제안"], exclude: ["제안서", "제안요청"], guidelines: ["공공기관의 혁신에 관한 지침"] },
  { id: "규제", name: "규제혁신", strong: ["규제혁신", "규제입증", "규제개선", "규제심사"], weak: ["규제"], exclude: [], guidelines: ["공공기관의 혁신에 관한 지침"] },
  { id: "복무", name: "복무·근무", strong: ["복무", "취업규칙", "유연근무", "근무시간", "당직", "비상근무", "휴가", "휴직", "시차출퇴근", "재택근무", "원격근무"], weak: ["근무"], exclude: ["근무성적", "근무평정"], guidelines: ["경영에 관한 지침"] },
  { id: "보수", name: "보수·급여", strong: ["보수", "급여", "연봉", "임금", "수당", "성과급", "성과연봉", "퇴직금", "임금피크제", "퇴직급여"], weak: [], exclude: ["임원보수", "임원 보수"], guidelines: ["예산운용지침", "경영에 관한 지침"] },
  { id: "임원보수", name: "임원 보수", strong: ["임원보수", "임원의보수", "상임임원보수", "임원퇴직금", "기관장보수"], weak: [], exclude: [], guidelines: ["임원 보수지침"] },
  { id: "인사", name: "인사·채용", strong: ["인사", "채용", "임용", "승진", "근무성적평정", "근무평정", "인사위원회", "개방형직위", "공무직", "기간제", "무기계약", "계약직", "전보", "보직", "인사평가"], weak: ["직원", "직위"], exclude: ["인사말"], guidelines: ["경영에 관한 지침"] },
  { id: "상벌", name: "징계·포상", strong: ["징계", "문책", "포상", "상벌", "표창", "감경"], weak: [], exclude: [], guidelines: ["경영에 관한 지침"] },
  { id: "윤리", name: "윤리·청렴", strong: ["행동강령", "윤리강령", "윤리경영", "청렴", "이해충돌", "부정청탁", "부패", "직무청렴계약", "윤리헌장", "공익신고", "부패신고", "신고자보호", "외부강의", "금품"], weak: ["윤리"], exclude: ["연구윤리", "생명윤리"], guidelines: [] },
  { id: "인권", name: "인권·성희롱 예방", strong: ["성희롱", "성폭력", "괴롭힘", "스토킹", "인권경영", "인권", "고충처리"], weak: [], exclude: [], guidelines: [] },
  { id: "감사", name: "감사", strong: ["감사", "일상감사", "내부감사", "자체감사", "감사인", "감사위원회"], weak: [], exclude: ["청렴시민감사관", "감사관"], guidelines: ["감사 운영 규정"] },
  { id: "계약", name: "계약·구매", strong: ["계약사무", "계약업무", "계약심의", "구매", "조달", "물품", "수의계약", "입찰", "용역계약"], weak: ["계약"], exclude: ["직무청렴계약", "근로계약", "계약직"], guidelines: ["계약사무규칙", "계약사무 운영규정"] },
  { id: "회계", name: "회계·예산·자산", strong: ["회계", "예산", "결산", "자산", "고정자산", "자금운용", "법인카드", "업무추진비", "출자", "기부금"], weak: [], exclude: ["회계감사인"], guidelines: ["회계기준", "회계사무규칙", "예산운용지침"] },
  { id: "여비", name: "여비·출장", strong: ["여비", "출장", "국외출장", "국외여행", "항공마일리지"], weak: [], exclude: [], guidelines: ["예산운용지침"] },
  { id: "직제", name: "직제·조직", strong: ["직제", "업무분장", "위임전결", "전결", "임시조직", "해외사무소", "조직관리", "정원"], weak: ["조직"], exclude: ["조직문화"], guidelines: ["경영에 관한 지침"] },
  { id: "정관", name: "정관·이사회", strong: ["정관", "이사회", "임원추천위원회", "경영위원회"], weak: [], exclude: [], guidelines: ["경영에 관한 지침"] },
  { id: "안전", name: "안전·보건", strong: ["안전보건", "안전관리", "산업안전", "중대재해", "안전사고", "재난", "소방", "생물안전", "보건관리"], weak: ["안전"], exclude: ["정보보안", "안전보장"], guidelines: ["안전관리에 관한 지침", "안전관리등급제"] },
  { id: "보안", name: "보안·개인정보", strong: ["보안", "정보보안", "개인정보", "영상정보처리기기", "정보시스템", "사이버"], weak: [], exclude: [], guidelines: [] },
  { id: "공개", name: "정보공개·공시·기록", strong: ["정보공개", "경영공시", "공시", "기록물", "기록관", "문서관리", "인장", "직인", "공공데이터"], weak: ["문서"], exclude: [], guidelines: ["통합공시에 관한 기준"] },
  { id: "복지", name: "복리후생", strong: ["복리후생", "복지후생", "선택적복지", "사택", "관사", "동호회", "주택자금", "학자금"], weak: ["복지"], exclude: ["사회복지", "복지사업"], guidelines: ["예산운용지침", "경영에 관한 지침"] },
  { id: "노사", name: "노사관계", strong: ["노사협의회", "노동조합", "단체협약", "노사관계"], weak: [], exclude: [], guidelines: [] },
  { id: "교육", name: "교육훈련", strong: ["교육훈련", "연수", "공로연수", "직무교육", "학위과정"], weak: ["교육"], exclude: ["교육사업", "교육원"], guidelines: [] },
  { id: "적극행정", name: "적극행정·면책", strong: ["적극행정", "면책", "사전컨설팅"], weak: [], exclude: [], guidelines: [] },
  { id: "민원", name: "민원·청원", strong: ["민원", "청원", "고객만족", "고객의소리"], weak: [], exclude: [], guidelines: [] },
  { id: "연구", name: "연구관리", strong: ["연구윤리", "연구노트", "연구개발", "연구용역", "지식재산", "연구관리", "연구비"], weak: ["연구"], exclude: [], guidelines: [] },
  { id: "법무", name: "소송·법률자문", strong: ["소송", "법률자문", "고문변호사", "법무"], weak: [], exclude: [], guidelines: [] },
  { id: "사업관리", name: "사업관리·평가", strong: ["사업실명제", "성과평가", "성과관리", "경영평가", "내부평가", "총사업비", "예비타당성"], weak: ["평가"], exclude: [], guidelines: ["총사업비관리지침", "예비타당성조사"] },
];

// 비교용 정규화: 공백·가운뎃점·괄호 내용·앞 번호를 없앤다("4-61 혁신제안제도 운영지침(2025년 개정)" → "혁신제안제도운영지침")
export function normTitle(t) {
  return String(t || "")
    .replace(/\([^)]*\)|\[[^\]]*\]|<[^>]*>|（[^）]*）/g, "")
    .replace(/^[\d\s.\-_]+/, "")
    .replace(/[\s·ㆍ・.,/]+/g, "");
}

// 규정 종류를 나타내는 꼬리말 — 비교에서 뺀다
const TAIL = /(에관한|에대한|관련|운영|관리|시행|업무처리|처리|규정|세칙|지침|규칙|요령|기준|내규|요강|편람|매뉴얼|방법서?|절차|예규|원규|사규|및|등)+$/;
export const coreTitle = (t) => normTitle(t).replace(TAIL, "");

const hasAny = (s, words) => words.filter((w) => s.includes(w.replace(/\s/g, "")));

// 분야 하나와 제목 맞추기. 제외 말은 제목에서 먼저 지운다("규제혁신위원회" → "위원회" → 경영혁신 아님)
function matchGroup(g, t) {
  let rest = t;
  for (const x of g.exclude) rest = rest.split(x.replace(/\s/g, "")).join("|");
  const strong = hasAny(rest, g.strong);
  if (strong.length) return { level: "strong", words: strong };
  const weak = hasAny(rest, g.weak);
  if (weak.length) return { level: "weak", words: weak };
  return null;
}

// 제목이 어느 분야에 얼마나 맞는지: [{ group, level: "strong"|"weak", words }]
export function classifyTitle(title) {
  const t = normTitle(title);
  return GROUPS.map((g) => ({ group: g, ...matchGroup(g, t) })).filter((m) => m.level);
}

// 후보 제목이 기준 제목과 얼마나 같은 성격인지(0~1)와 이유.
//   1.0 기준 제목과 같은 분야 낱말(예: 기준 '유연근무' ↔ 후보 '유연근무')
//   0.9 기준 제목의 핵심 말이 그대로 들어 있음
//   0.8 같은 분야의 다른 강한 낱말(예: 기준 '유연근무' ↔ 후보 '복무')
//   0.5 약한 낱말만(본문으로 가림)
export function titleScore(candTitle, matched, core) {
  const t = normTitle(candTitle);
  let best = { score: 0, why: "" };
  const take = (score, why) => {
    if (score > best.score) best = { score, why };
  };
  for (const { group: g, words: baseWords = [] } of matched) {
    const m = matchGroup(g, t);
    if (m?.level === "strong") {
      const same = m.words.find((w) => baseWords.includes(w));
      take(same ? 1 : 0.8, `제목 '${same || m.words[0]}'(${g.name})`);
    } else if (m?.level === "weak") take(0.5, `제목 '${m.words[0]}'(${g.name}, 본문으로 확인 필요)`);
  }
  if (core && core.length >= 2 && t.includes(core)) take(0.9, `제목에 '${core}'`);
  return best;
}
