import type { NormalizedEvent, Verdict } from '@app/shared'
import { canonicalizeTitle } from './canonicalize.js'
import {
  CRITICAL_KEYWORDS, HIGH_KEYWORDS, MECHANICAL_HALT_MARKERS,
  NOISE_PATTERNS, NORMAL_KEYWORDS, PERIODIC_PATTERNS, PREFIX_RULES,
  TRADING_HALT_KEYWORD,
} from './keywords.js'
import type { Tier } from '@app/shared'

const PREFIX_RE = /^\[([^\]]+)\]\s*/

/** 제목에서 대괄호 접두어를 떼어낸다. title은 이미 canonicalizeTitle을 통과한 값이어야 한다. */
export function splitPrefix(title: string): { prefix: string | null; body: string } {
  const m = PREFIX_RE.exec(title)
  if (!m) return { prefix: null, body: title }
  return { prefix: m[1]!, body: title.slice(m[0].length) }
}

/**
 * 가장 먼저 매칭되는 키워드와 티어를 반환한다. critical이 high보다, high가 normal보다
 * 우선한다. body는 이미 canonicalizeTitle을 통과한 값이어야 한다 (keywords.js의
 * 각 리스트도 모듈 로드 시 같은 함수로 정규화되어 있다).
 */
export function matchKeyword(body: string): { tier: Tier; keyword: string } | null {
  const critical = CRITICAL_KEYWORDS.find((k) => body.includes(k))
  if (critical) {
    // 거래정지 중 액면병합/주식병합·분할 등 전자등록 변경에 따른 기계적 매매정지는
    // 시세에 영향이 없는 사무 처리다. 상장폐지·정리매매 사유는 마커에 없으므로
    // 아래 조건에 걸리지 않고 critical로 남는다 (keywords.ts의 MECHANICAL_HALT_MARKERS 참고).
    if (critical === TRADING_HALT_KEYWORD && MECHANICAL_HALT_MARKERS.some((m) => body.includes(m))) {
      return { tier: 'normal', keyword: critical }
    }
    return { tier: 'critical', keyword: critical }
  }

  const high = HIGH_KEYWORDS.find((k) => body.includes(k))
  if (high) return { tier: 'high', keyword: high }

  const normal = NORMAL_KEYWORDS.find((k) => body.includes(k))
  if (normal) return { tier: 'normal', keyword: normal }

  return null
}

export function evaluateDart(event: NormalizedEvent): Verdict {
  const { subject, title } = event

  // 게이트 1 — 비상장 제외
  if (!subject?.ticker) return { action: 'drop', reason: 'no-stock-code' }

  // 게이트 2 — 코넥스·기타 제외
  if (!subject.market) return { action: 'drop', reason: 'market-not-target' }

  // 가운뎃점 표기 통일 등 정규화는 여기서 한 번만 한다 (canonicalizeTitle 참고).
  // 이하 모든 게이트는 canonicalize된 title/body만 비교한다.
  const { prefix, body } = splitPrefix(canonicalizeTitle(title))

  // 게이트 4 — 정정 접두어 (정기보고서 판정보다 먼저: [정정명령부과]사업보고서를 살려야 함)
  if (prefix) {
    const rule = PREFIX_RULES.find((r) => r.prefix === prefix)
    if (rule) {
      if (rule.tier === null) return { action: 'drop', reason: 'minor-correction' }
      return { action: 'pass', tier: rule.tier, rule: `prefix:${rule.prefix}` }
    }
  }

  // 게이트 3 — 정기보고서 제외
  if (PERIODIC_PATTERNS.some((p) => body.startsWith(p))) {
    return { action: 'drop', reason: 'periodic-report' }
  }

  // 게이트 5 — 명시적 노이즈
  if (NOISE_PATTERNS.some((p) => body.includes(p))) {
    return { action: 'drop', reason: 'noise' }
  }

  // 게이트 6 — 키워드 티어링
  const matched = matchKeyword(body)
  if (matched) {
    return { action: 'pass', tier: matched.tier, rule: `keyword:${matched.keyword}` }
  }

  // 게이트 7 — 화이트리스트 미매칭
  return { action: 'drop', reason: 'no-keyword-match' }
}
