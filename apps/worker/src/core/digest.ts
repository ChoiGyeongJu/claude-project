import { escapeMarkdownV2 } from './format.js'
import { DAILY_LIMIT } from './budget.js'

export type MissedCandidate = {
  title: string
  corpName: string | null
  ticker: string | null
}

export type DigestData = {
  kstDate: string
  sent: { critical: number; high: number; normal: number }
  dead: number
  apiCalls: number
  missedCandidates: MissedCandidate[]
  errorCounts: Record<string, number>
  /** 잘리지 않은 총계. missedCandidates.length 를 실제 건수로 쓰면 심각도를 과소 표시한다. */
  missedTotal: number
}

export function formatDigest(d: DigestData): string {
  const errors = Object.entries(d.errorCounts)
    .map(([k, v]) => `${escapeMarkdownV2(k)} ${v}`)
    .join(' · ') || '없음'

  const missed = d.missedCandidates.length === 0
    ? '  없음'
    : d.missedCandidates
        .map((m) => `  • ${escapeMarkdownV2(m.corpName ?? '미상')} — ${escapeMarkdownV2(m.title)}`)
        .join('\n')

  return [
    `📊 ${escapeMarkdownV2(d.kstDate)} 리포트`,
    '',
    `발송   critical ${d.sent.critical} · high ${d.sent.high} · normal ${d.sent.normal}`,
    `dead   ${d.dead}`,
    `API    ${d.apiCalls} / ${DAILY_LIMIT}`,
    `에러   ${errors}`,
    '',
    d.missedTotal > d.missedCandidates.length
      ? `미매칭 ${d.missedTotal}건 \\(상위 ${d.missedCandidates.length}건 표시 · 룰 튜닝 후보\\)`
      : `미매칭 ${d.missedTotal}건 \\(룰 튜닝 후보\\)`,
    missed,
  ].join('\n')
}
