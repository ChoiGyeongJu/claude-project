import { escapeMarkdownV2 } from './format.js'
import { MAX_MERGED_CHARS } from './policy.js'

/**
 * 다이제스트 따라잡기(catchUpDigests)가 같은 날짜를 재시도할 수 있는 최대 횟수.
 * outbox 의 MAX_ATTEMPTS(core/retry.ts)와 값을 맞춘다 — 잘못된 운영자 chat id 나
 * 길이 상한을 넘는 본문처럼 영원히 보낼 수 없는 다이제스트가 매 사이클(성수기
 * ~2.5초) 무한 재시도되며 운영자 채널의 레이트리밋 예산을 태우는 것을 막는다.
 */
export const MAX_DIGEST_ATTEMPTS = 5

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
  /**
   * 계정에 실제로 발급된 일일 한도(config.ts 의 DART_DAILY_LIMIT). budget.ts 의
   * DAILY_LIMIT 상수를 쓰면 안 된다 — 계정마다 한도가 다를 수 있고, 다이제스트는
   * 운영자가 매일 읽는 분모이므로 실제 한도와 어긋나면 안 된다.
   */
  dailyLimit: number
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
    `API    ${d.apiCalls} / ${d.dailyLimit}`,
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
