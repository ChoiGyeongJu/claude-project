import type { NormalizedEvent, Verdict } from '@app/shared'
import { NOISE_PATTERNS, PERIODIC_PATTERNS, PREFIX_RULES } from './keywords.js'

const PREFIX_RE = /^\[([^\]]+)\]\s*/

/** 제목에서 대괄호 접두어를 떼어낸다. */
export function splitPrefix(title: string): { prefix: string | null; body: string } {
  const m = PREFIX_RE.exec(title)
  if (!m) return { prefix: null, body: title }
  return { prefix: m[1]!, body: title.slice(m[0].length) }
}

export function evaluateDart(event: NormalizedEvent): Verdict {
  const { subject, title } = event

  // 게이트 1 — 비상장 제외
  if (!subject?.ticker) return { action: 'drop', reason: 'no-stock-code' }

  // 게이트 2 — 코넥스·기타 제외
  if (!subject.market) return { action: 'drop', reason: 'market-not-target' }

  const { prefix, body } = splitPrefix(title)

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

  // 게이트 6~7은 Task 4에서 이어 붙인다.
  return { action: 'drop', reason: 'no-keyword-match' }
}
