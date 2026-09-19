import { escapeMarkdownV2 } from './format.js'
import { DAILY_LIMIT } from './budget.js'
import { MAX_MERGED_CHARS } from './policy.js'

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

/** 후보를 앞에서 `shown` 건만 담아 다이제스트 한 통을 렌더한다. */
function render(d: DigestData, shown: number): string {
  const errors = Object.entries(d.errorCounts)
    .map(([k, v]) => `${escapeMarkdownV2(k)} ${v}`)
    .join(' · ') || '없음'

  const list = d.missedCandidates.slice(0, shown)

  const missed = list.length === 0
    ? (d.missedTotal === 0 ? '  없음' : '  \\(길이 제한으로 목록 생략\\)')
    : list
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
    d.missedTotal > list.length
      ? `미매칭 ${d.missedTotal}건 \\(상위 ${list.length}건 표시 · 룰 튜닝 후보\\)`
      : `미매칭 ${d.missedTotal}건 \\(룰 튜닝 후보\\)`,
    missed,
  ].join('\n')
}

/**
 * 텔레그램 sendMessage 본문 한도(4096자)를 넘으면 메시지가 통째로 거부된다.
 * 하필 과필터링이 가장 심한 날 — 다이제스트가 가장 길어지는 날 — 신호가 죽는다.
 * 병합 발송과 같은 방식으로, 상한에 들어가는 만큼만 담고 총계에 몇 건이
 * 표시됐는지를 그대로 적는다. 총계(missedTotal)는 절대 줄이지 않는다:
 * 표시 개수는 잘려도 심각도는 잘리면 안 된다.
 */
export function formatDigest(d: DigestData): string {
  let shown = d.missedCandidates.length
  let out = render(d, shown)
  while (shown > 0 && out.length > MAX_MERGED_CHARS) {
    shown -= 1
    out = render(d, shown)
  }
  return out
}
