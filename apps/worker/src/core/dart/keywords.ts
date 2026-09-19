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
