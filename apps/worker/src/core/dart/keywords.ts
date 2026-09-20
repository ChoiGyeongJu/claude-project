import type { Tier } from '@app/shared'
import { canonicalizeTitle } from './canonicalize.js'

/**
 * 아래 모든 리스트는 원본(사람이 읽는 한글 표기)으로 작성하고, 모듈 로드 시
 * 한 번만 canonicalizeTitle을 통과시켜 내보낸다. 매칭 루프가 2.5초마다 도는데
 * 그때마다 정규화를 다시 하지 않기 위함이다 — 비교 대상(이벤트 제목)도 같은
 * 함수로 정규화된 뒤 이 리스트들과 비교되어야 한다 (rules.ts 참고).
 */
function canon(list: readonly string[]): readonly string[] {
  return list.map(canonicalizeTitle)
}

const TRADING_HALT_KEYWORD_SOURCE = '거래정지'
/** matchKeyword에서 거래정지 특례(파일 하단 MECHANICAL_HALT_MARKERS 참고)를 식별하기 위한 정규화된 키워드. */
export const TRADING_HALT_KEYWORD: string = canonicalizeTitle(TRADING_HALT_KEYWORD_SOURCE)

/** 게이트 3 — 정기보고서 */
export const PERIODIC_PATTERNS: readonly string[] = canon([
  '사업보고서', '반기보고서', '분기보고서',
])

/** 게이트 4 — 정정 접두어. tier가 null이면 drop. */
const PREFIX_RULES_SOURCE: ReadonlyArray<{ prefix: string; tier: Tier | null }> = [
  { prefix: '기재정정', tier: null },
  { prefix: '첨부정정', tier: null },
  { prefix: '첨부추가', tier: null },
  { prefix: '발행조건확정', tier: 'high' },
  { prefix: '정정명령부과', tier: 'critical' },
  { prefix: '정정제출요구', tier: 'critical' },
]
export const PREFIX_RULES: ReadonlyArray<{ prefix: string; tier: Tier | null }> =
  PREFIX_RULES_SOURCE.map((r) => ({ ...r, prefix: canonicalizeTitle(r.prefix) }))

/** 게이트 5 — 명시적 노이즈 */
export const NOISE_PATTERNS: readonly string[] = canon([
  '임원·주요주주특정증권등소유상황보고서',
  '기업설명회(IR)개최',
  // 정기주주총회소집공고 → 0건. DART 실제 표기는 '정기' 없이 '주주총회소집공고'다
  // (실데이터 검증: 정기주주총회소집공고 0건, 주주총회소집공고 146건 — 과제 설명의
  // "115건"보다 실측치가 더 높았다. 실측을 신뢰한다).
  '주주총회소집공고',
  '결산실적공시예고',
])

/** 게이트 6 — 제목만으로 정보가 충분한 공시. LLM을 기다리지 않는다. */
export const CRITICAL_KEYWORDS: readonly string[] = canon([
  '단일판매·공급계약체결',
  '무상증자결정',
  '자기주식취득결정',
  '자기주식취득신탁계약체결결정',
  // 취득만 있고 처분·소각이 없었다. 자사주 소각은 시장에서 가장 강한 촉매 중
  // 하나인데 no-keyword-match 로 조용히 버려지고 있었다.
  '자기주식처분결정',
  // 자기주식소각결정 → 0건. DART 실제 표기는 '자기' 없이 '주식소각결정'이다
  // (실데이터 검증: 자기주식소각결정 0건, 주식소각결정 44건).
  '주식소각결정',
  '자기주식취득신탁계약해지결정',
  '유상증자결정',
  '전환사채권발행결정',
  '신주인수권부사채권발행결정',
  '최대주주변경',
  '주식분할결정',
  '주식병합결정',
  '감자결정',
  '회사합병결정',
  '타법인주식및출자증권처분결정',
  '횡령·배임',
  '상장폐지',
  '관리종목지정',
  TRADING_HALT_KEYWORD_SOURCE,
  '부도발생',
  '회생절차개시신청',
  '영업정지',
])

/** 본문 수치가 있어야 의미가 생기는 공시. LLM 요약을 붙인다. */
export const HIGH_KEYWORDS: readonly string[] = canon([
  '매출액또는손익구조30%(대규모법인은15%)이상변동',
  '타법인주식및출자증권취득결정',
  '영업양수도',
  '현금·현물배당결정',
  '조회공시요구(풍문또는보도)에대한답변',
  // 소송등의제기ㆍ신청, 소송등의판결ㆍ결정 은 경영권·손해배상 관련 소송 발생 신호이지만
  // 중요도(청구금액, 승소·패소 여부)는 본문을 봐야 판단되므로 critical이 아니라 high.
  '소송등의제기',
  '소송등의판결',
  '풍문또는보도에대한해명',
])

/**
 * 경계값이 명확하지 않아 LLM 요약도 필요 없지만, 그렇다고 노이즈로 버리기엔
 * 시세에 영향을 줄 수 있는 공시. normal 티어는 타입에는 있었지만 이 목록이
 * 비어 있어서 아무것도 흘러들어오지 않고 있었다.
 *
 * 타인에대한채무보증결정(실측 132건)은 의도적으로 제외한다 — 대부분이 자회사에
 * 대한 통상적 채무보증이고 중요성은 금액을 봐야 판단할 수 있는데, 지금은 목록
 * 조회 API만 쓰고 있어 본문(금액)을 볼 수 없다. 본문을 가져오는 후속 작업이
 * 붙기 전까지는 넣지 않는다.
 */
export const NORMAL_KEYWORDS: readonly string[] = canon([
  '전환가액의조정',
])

/**
 * '거래정지' 매칭 118~122건 중 다수가 액면병합/주식병합·분할 등 전자등록 변경에 따른
 * 기계적 매매정지였다 (실측: 액면병합 변경상장 36건, 주식의 병합·분할 등 전자등록
 * 변경·말소 21건 — 하루 몇 건씩 critical로 울리면 알림 피로만 남긴다). 반면
 * 상장폐지/정리매매 사유의 거래정지는 진짜 이벤트이므로 critical을 유지해야 한다.
 * 아래 마커 중 하나라도 제목에 있으면 normal로 낮춘다 (rules.ts 참고).
 */
export const MECHANICAL_HALT_MARKERS: readonly string[] = canon([
  '액면병합', '주식의 병합', '분할', '전자등록', '변경상장',
])
