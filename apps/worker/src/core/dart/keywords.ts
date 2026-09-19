import type { Tier } from '@app/shared'

/** 게이트 3 — 정기보고서 */
export const PERIODIC_PATTERNS: readonly string[] = [
  '사업보고서', '반기보고서', '분기보고서',
]

/** 게이트 4 — 정정 접두어. tier가 null이면 drop. */
export const PREFIX_RULES: ReadonlyArray<{ prefix: string; tier: Tier | null }> = [
  { prefix: '기재정정', tier: null },
  { prefix: '첨부정정', tier: null },
  { prefix: '첨부추가', tier: null },
  { prefix: '발행조건확정', tier: 'high' },
  { prefix: '정정명령부과', tier: 'critical' },
  { prefix: '정정제출요구', tier: 'critical' },
]

/** 게이트 5 — 명시적 노이즈 */
export const NOISE_PATTERNS: readonly string[] = [
  '임원·주요주주특정증권등소유상황보고서',
  '기업설명회(IR)개최',
  '정기주주총회소집공고',
  '결산실적공시예고',
]

/** 게이트 6 — 제목만으로 정보가 충분한 공시. LLM을 기다리지 않는다. */
export const CRITICAL_KEYWORDS: readonly string[] = [
  '단일판매·공급계약체결',
  '무상증자결정',
  '자기주식취득결정',
  '자기주식취득신탁계약체결결정',
  // 취득만 있고 처분·소각이 없었다. 자사주 소각은 시장에서 가장 강한 촉매 중
  // 하나인데 no-keyword-match 로 조용히 버려지고 있었다.
  '자기주식처분결정',
  '자기주식소각결정',
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
  '거래정지',
  '부도발생',
  '회생절차개시신청',
  '영업정지',
]

/** 본문 수치가 있어야 의미가 생기는 공시. LLM 요약을 붙인다. */
export const HIGH_KEYWORDS: readonly string[] = [
  '매출액또는손익구조30%(대규모법인은15%)이상변동',
  '타법인주식및출자증권취득결정',
  '영업양수도',
  '현금·현물배당결정',
  '조회공시요구(풍문또는보도)에대한답변',
]
