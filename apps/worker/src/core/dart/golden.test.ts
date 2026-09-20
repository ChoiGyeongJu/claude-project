import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { normalizeDartItem } from './normalize.js'
import { evaluateDart } from './rules.js'
import type { DartListItem } from './schema.js'
import type { Verdict } from '@app/shared'

/**
 * 골든 회귀 세트. apps/worker/src/core/dart/__fixtures__/golden.json에서 로드한다.
 * 픽스처의 모든 필드는 실제 DART 응답(filings.json, 20영업일 · 15,477건)에서 그대로
 * 복사한 값이다 — 손으로 옮겨 적지 않는다. 이유는 __fixtures__/README.md 참고.
 *
 * expected는 "지금 필터가 실제로 내리는 판정"을 실측 데이터에 박아 넣은 것이다.
 * 향후 키워드를 고치다가 이 중 하나라도 바뀌면 이 테스트가 실패해야 한다 — 그것이
 * 이 파일의 유일한 목적이다.
 */

const FIXTURE_PATH = fileURLToPath(new URL('./__fixtures__/golden.json', import.meta.url))

type GoldenItem = {
  report_nm: string
  corp_cls: string
  stock_code: string
  corp_name: string
  rcept_no: string
  rcept_dt: string
  flr_nm: string
  rm: string
}

type GoldenEntry = {
  note: string
  item: GoldenItem
  expected: Verdict
}

// evaluateDart는 title/subject만 보고 occurredAt·firstSeenAt은 보지 않는다 (rules.ts 참고).
// 값 자체는 임의의 고정 시각이면 충분하다.
const SEEN = new Date('2026-09-19T06:30:00.000Z')

// 픽스처는 DartListItem이 요구하는 필드 중 corp_code를 담지 않는다 — evaluateDart가
// 읽는 필드가 아니기 때문이다(과제 명세 §1). 실행에 필요한 자리채움만 여기서 더한다.
function toDartListItem(item: GoldenItem): DartListItem {
  return { corp_code: '00000000', ...item }
}

function loadFixture(): GoldenEntry[] {
  const raw: unknown = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
  if (!Array.isArray(raw)) throw new Error('golden.json은 배열이어야 한다')
  return raw as GoldenEntry[]
}

const fixture = loadFixture()

/**
 * evaluateDart가 실측 데이터(filings.json, 15,477건)에서 실제로 내는 rule 전체
 * (키워드 38종 + 접두어 3종 = 41종). CRITICAL_KEYWORDS의 '주식분할결정'과 '부도발생'은
 * 이 20영업일 표본에 단 한 건도 없어 여기서 제외한다 — keywords.ts의 전체 목록이
 * 아니라 실측 데이터에서 직접 센 값이어야, 목록에서 셌다면 보이지 않았을 "도달 불가능한
 * 키워드"가 이 목록에서 빠짐으로써 드러난다 (README 참고).
 */
const EXPECTED_RULES: readonly string[] = [
  'keyword:단일판매·공급계약체결',
  'keyword:무상증자결정',
  'keyword:자기주식취득결정',
  'keyword:자기주식취득신탁계약체결결정',
  'keyword:자기주식처분결정',
  'keyword:주식소각결정',
  'keyword:자기주식취득신탁계약해지결정',
  'keyword:유상증자결정',
  'keyword:전환사채권발행결정',
  'keyword:신주인수권부사채권발행결정',
  'keyword:최대주주변경',
  'keyword:주식병합결정',
  'keyword:감자결정',
  'keyword:회사합병결정',
  'keyword:회사분할결정',
  'keyword:타법인주식및출자증권처분결정',
  'keyword:횡령·배임',
  'keyword:상장폐지',
  'keyword:관리종목지정',
  'keyword:거래정지',
  'keyword:실질심사',
  'keyword:회생절차개시신청',
  'keyword:영업정지',
  'keyword:매출액또는손익구조30%(대규모법인은15%)이상변동',
  'keyword:타법인주식및출자증권취득결정',
  'keyword:영업양수도',
  'keyword:현금·현물배당결정',
  'keyword:조회공시요구',
  'keyword:소송등의제기',
  'keyword:소송등의판결',
  'keyword:풍문또는보도에대한해명',
  'keyword:전환가액의조정',
  'keyword:대표이사변경',
  'keyword:금전대여결정',
  'keyword:투자판단관련주요경영사항',
  'keyword:자기전환사채만기전취득결정',
  'keyword:전환사채(해외전환사채포함)발행후만기전사채취득',
  'keyword:자기전환사채매도결정',
  'prefix:발행조건확정',
  'prefix:정정명령부과',
  'prefix:정정제출요구',
]

/** evaluateDart가 실측 데이터에서 실제로 내는 drop reason 전체 (6종). */
const EXPECTED_DROP_REASONS: readonly string[] = [
  'no-stock-code',
  'market-not-target',
  'periodic-report',
  'minor-correction',
  'noise',
  'no-keyword-match',
]

describe('골든 회귀 세트 — 실측 DART 데이터 (filings.json, 20영업일 · 15,477건)', () => {
  const cases = fixture.map((entry) => {
    const label = `${entry.item.corp_name} — ${entry.item.report_nm.trim()} (rcept_no=${entry.item.rcept_no})`
    return [label, entry] as const
  })

  it.each(cases)('%s', (_label, entry) => {
    const event = normalizeDartItem(toDartListItem(entry.item), SEEN)
    const actual = evaluateDart(event)
    const diagnostic =
      `필링: "${entry.item.report_nm.trim()}" (${entry.item.corp_name}, rcept_no=${entry.item.rcept_no})\n` +
      `핀 노트: ${entry.note}\n` +
      `expected=${JSON.stringify(entry.expected)}\n` +
      `actual=${JSON.stringify(actual)}`
    expect(actual, diagnostic).toEqual(entry.expected)
  })

  it('픽스처에 rcept_no 중복이 없다', () => {
    const rceptNos = fixture.map((e) => e.item.rcept_no)
    expect(new Set(rceptNos).size).toBe(rceptNos.length)
  })

  describe('커버리지 — 회귀 없이 편집되었는지 감시', () => {
    it('실측 데이터에서 fire하는 rule 41종을 전부 포함한다', () => {
      const covered = new Set(
        fixture
          .map((e) => e.expected)
          .filter((v): v is Extract<Verdict, { action: 'pass' }> => v.action === 'pass')
          .map((v) => v.rule),
      )
      const missing = EXPECTED_RULES.filter((rule) => !covered.has(rule))
      expect(missing, `golden.json에서 빠진 rule: ${missing.join(', ')}`).toEqual([])
    })

    it('drop reason 6종을 전부 포함한다', () => {
      const covered = new Set(
        fixture
          .map((e) => e.expected)
          .filter((v): v is Extract<Verdict, { action: 'drop' }> => v.action === 'drop')
          .map((v) => v.reason),
      )
      const missing = EXPECTED_DROP_REASONS.filter((reason) => !covered.has(reason))
      expect(missing, `golden.json에서 빠진 drop reason: ${missing.join(', ')}`).toEqual([])
    })
  })
})
