# DART 실시간 공시 알림 워커 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OpenDART를 장중 2.5초 주기로 폴링해 주가 영향이 큰 공시만 선별·요약하여 텔레그램으로 발송하는, 사람 개입 없이 굴러가는 상주 워커를 만든다.

**Architecture:** Hexagonal(Ports & Adapters) + Pipes & Filters. 도메인 코어(정규화·필터·정책)는 외부 의존이 전혀 없는 순수 함수로 두어 네트워크 없이 전량 테스트한다. 외부 연동(DART·Postgres·Telegram·LLM)은 전부 어댑터로 격리해 교체 가능하게 한다. 중복 발송과 발송 유실은 애플리케이션 로직이 아니라 DB 제약(UNIQUE + Transactional Outbox)으로 차단한다.

**Tech Stack:** Node.js 22 LTS · TypeScript · pnpm workspace · Vitest · Drizzle ORM + postgres.js · zod · grammY · pino · Docker

**Spec:** `docs/superpowers/specs/2026-09-19-realtime-disclosure-alert-design.md`

## Global Constraints

- **런타임**: Node.js 22 LTS. `fetch`는 내장 사용, `axios`/`node-fetch` 금지.
- **패키지 매니저**: pnpm 9 workspace. npm/yarn 혼용 금지.
- **의존성 방향**: `apps/worker/src/core/`는 **아무것도 import하지 않는다.** `adapters/`·`pipeline/`만 `core/`를 import한다. 역방향 import는 리뷰에서 거부한다.
- **순수성**: `core/` 아래 모든 함수는 순수 함수다. 네트워크·DB·파일·`Date.now()`·`Math.random()` 호출 금지. 현재 시각이 필요하면 **인자로 받는다**.
- **DART 응답 필드는 9개뿐이다**: `corp_cls`, `corp_name`, `corp_code`, `stock_code`, `report_nm`, `rcept_no`, `flr_nm`, `rcept_dt`, `rm`. `pblntf_ty`는 요청 파라미터이며 **응답에 없다.** 모든 유형 판별은 `report_nm` 문자열 패턴으로 한다.
- **API 한도**: OpenDART 일 20,000건. 초과 시 에러코드 `020`.
- **금지 사항**: 호재/악재 판단, 목표가, 매수·매도 의견을 생성하는 코드를 작성하지 않는다. LLM 프롬프트에도 포함하지 않는다.
- **비밀값**: API 키·봇 토큰은 전부 환경변수. 코드·테스트·fixture에 하드코딩 금지.
- **테스트**: 실제 네트워크를 호출하는 자동 테스트를 만들지 않는다. 외부 응답은 fixture로 고정한다.
- **커밋**: 각 Task 종료 시 1커밋. 메시지는 Conventional Commits.

---

## File Structure

```
claude-project/
├── package.json                      # pnpm workspace 루트
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── packages/
│   └── shared/src/event.ts           # NormalizedEvent, Verdict, Tier, Market
├── apps/worker/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── Dockerfile
│   ├── drizzle.config.ts
│   └── src/
│       ├── core/                     # 순수 — 외부 의존 0
│       │   ├── dart/normalize.ts     #   DART 응답 → NormalizedEvent
│       │   ├── dart/schema.ts        #   zod 스키마
│       │   ├── dart/rules.ts         #   게이트 1~7 → Verdict
│       │   ├── dart/keywords.ts      #   키워드 목록 (데이터)
│       │   ├── policy.ts             #   지연 상한·TTL·병합 임계
│       │   ├── schedule.ts           #   시간대별 폴링 주기
│       │   └── format.ts             #   텔레그램 메시지 포맷 + 이스케이프
│       ├── ports/
│       │   ├── source.ts  store.ts  notifier.ts  summarizer.ts  clock.ts
│       ├── adapters/
│       │   ├── sources/dart.ts
│       │   ├── store/schema.ts       #   Drizzle 테이블 정의
│       │   ├── store/postgres.ts
│       │   ├── notifier/telegram.ts
│       │   ├── notifier/rate-limiter.ts
│       │   └── summarizer/llm.ts
│       ├── pipeline/
│       │   ├── ingest.ts             #   폴링 1회분 처리
│       │   ├── dispatch.ts           #   outbox → 발송
│       │   ├── digest.ts             #   일일 다이제스트
│       │   └── health.ts             #   heartbeat · 서킷브레이커
│       ├── main.ts
│       └── __fixtures__/
│           ├── dart-list.json
│           └── golden.json
```

**분리 근거:** `keywords.ts`를 `rules.ts`에서 떼어낸 것은 키워드가 **가장 자주 바뀌는 데이터**이기 때문이다. 로직과 데이터를 같은 파일에 두면 튜닝할 때마다 로직 파일이 더럽혀지고 diff를 읽기 어려워진다. `format.ts`를 `core/`에 둔 것은 마크다운 이스케이프가 순수 문자열 변환이라 단위 테스트가 가능해서다 — 어댑터에 두면 테스트가 불가능해진다.

---

### Task 1: 모노레포 스캐폴딩과 공유 타입

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`
- Create: `packages/shared/package.json`, `packages/shared/src/event.ts`
- Create: `apps/worker/package.json`, `apps/worker/tsconfig.json`, `apps/worker/vitest.config.ts`
- Test: `packages/shared/src/event.test.ts`

**Interfaces:**
- Consumes: 없음 (첫 태스크)
- Produces: `NormalizedEvent`, `Verdict`, `Tier`, `Market`, `isPass()` — 이후 모든 태스크가 `@app/shared`로 import한다.

- [ ] **Step 1: 워크스페이스 파일 생성**

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

루트 `package.json`:
```json
{
  "name": "claude-project",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "declaration": true
  }
}
```

- [ ] **Step 2: 공유 타입 패키지 생성**

`packages/shared/package.json`:
```json
{
  "name": "@app/shared",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/event.ts",
  "exports": { ".": "./src/event.ts" },
  "scripts": { "test": "vitest run --passWithNoTests", "typecheck": "tsc --noEmit" },
  "devDependencies": { "typescript": "^5.6.0", "vitest": "^2.1.0" }
}
```

`packages/shared/src/event.ts`:
```ts
export type Market = 'Y' | 'K'
export type Tier = 'critical' | 'high' | 'normal'

export type EventSubject = {
  name: string
  ticker?: string
  market?: Market
}

export type NormalizedEvent = {
  sourceId: string
  externalId: string
  occurredAt: Date | null
  firstSeenAt: Date
  title: string
  url: string
  subject?: EventSubject
  raw: unknown
}

export type Verdict =
  | { action: 'drop'; reason: string }
  | { action: 'pass'; tier: Tier; rule: string }

export function isPass(v: Verdict): v is Extract<Verdict, { action: 'pass' }> {
  return v.action === 'pass'
}
```

- [ ] **Step 3: 실패하는 테스트 작성**

`packages/shared/src/event.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { isPass, type Verdict } from './event.js'

describe('isPass', () => {
  it('pass verdict를 좁힌다', () => {
    const v: Verdict = { action: 'pass', tier: 'critical', rule: '공급계약' }
    expect(isPass(v)).toBe(true)
    if (isPass(v)) expect(v.tier).toBe('critical')
  })

  it('drop verdict를 거른다', () => {
    const v: Verdict = { action: 'drop', reason: 'no-stock-code' }
    expect(isPass(v)).toBe(false)
  })
})
```

- [ ] **Step 4: 워커 패키지 골격 생성**

`apps/worker/package.json`:
```json
{
  "name": "@app/worker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "dev": "node --experimental-strip-types src/main.ts"
  },
  "dependencies": { "@app/shared": "workspace:*" },
  "devDependencies": { "typescript": "^5.6.0", "vitest": "^2.1.0", "@types/node": "^22.0.0" }
}
```

`apps/worker/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist", "types": ["node"] },
  "include": ["src"]
}
```

`apps/worker/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } })
```

- [ ] **Step 5: 설치하고 테스트 통과 확인**

`apps/worker/package.json`의 test 스크립트를 이 태스크에서만 `vitest run --passWithNoTests`로 두고, Task 2에서 첫 테스트를 추가할 때 `vitest run`으로 되돌린다.

Run: `pnpm install && pnpm test`
Expected: `@app/shared` 2 passed, `@app/worker` 0 tests (통과)

- [ ] **Step 6: 커밋**

```bash
git add -A
git commit -m "feat: pnpm 모노레포 스캐폴딩과 공유 이벤트 타입"
```

---

### Task 2: DART 응답 스키마와 정규화

**Files:**
- Create: `apps/worker/src/core/dart/schema.ts`
- Create: `apps/worker/src/core/dart/normalize.ts`
- Create: `apps/worker/src/__fixtures__/dart-list.json`
- Test: `apps/worker/src/core/dart/normalize.test.ts`

**Interfaces:**
- Consumes: `NormalizedEvent`, `Market` (Task 1)
- Produces:
  - `DartListResponse` (zod 타입), `parseDartResponse(json: unknown): DartListResponse`
  - `DartListItem` 타입
  - `normalizeDartItem(item: DartListItem, firstSeenAt: Date): NormalizedEvent`

- [ ] **Step 1: fixture 작성**

`apps/worker/src/__fixtures__/dart-list.json` — 실제 응답 형태를 그대로 고정한다:
```json
{
  "status": "000",
  "message": "정상",
  "page_no": 1,
  "page_count": 100,
  "total_count": 3,
  "total_page": 1,
  "list": [
    {
      "corp_cls": "Y",
      "corp_name": "샘플전자",
      "corp_code": "00126380",
      "stock_code": "005930",
      "report_nm": "단일판매·공급계약체결",
      "rcept_no": "20260919000123",
      "flr_nm": "샘플전자",
      "rcept_dt": "20260919",
      "rm": "유"
    },
    {
      "corp_cls": "K",
      "corp_name": "샘플바이오",
      "corp_code": "00234567",
      "stock_code": "",
      "report_nm": "사업보고서 (2025.12)",
      "rcept_no": "20260919000124",
      "flr_nm": "샘플바이오",
      "rcept_dt": "20260919",
      "rm": ""
    },
    {
      "corp_cls": "N",
      "corp_name": "샘플코넥스",
      "corp_code": "00345678",
      "stock_code": "900100",
      "report_nm": "무상증자결정",
      "rcept_no": "20260919000125",
      "flr_nm": "샘플코넥스",
      "rcept_dt": "20260919",
      "rm": "넥"
    }
  ]
}
```

- [ ] **Step 2: 실패하는 테스트 작성**

`apps/worker/src/core/dart/normalize.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import fixture from '../../__fixtures__/dart-list.json' with { type: 'json' }
import { parseDartResponse } from './schema.js'
import { normalizeDartItem } from './normalize.js'

const SEEN = new Date('2026-09-19T06:30:00.000Z')

describe('parseDartResponse', () => {
  it('정상 응답을 파싱한다', () => {
    const parsed = parseDartResponse(fixture)
    expect(parsed.status).toBe('000')
    expect(parsed.list).toHaveLength(3)
  })

  it('데이터 없음(013) 응답도 list 없이 파싱한다', () => {
    const parsed = parseDartResponse({ status: '013', message: '조회된 데이타가 없습니다.' })
    expect(parsed.list).toBeUndefined()
  })

  it('형태가 다르면 던진다', () => {
    expect(() => parseDartResponse({ foo: 'bar' })).toThrow()
  })
})

describe('normalizeDartItem', () => {
  it('상장사 항목을 NormalizedEvent로 변환한다', () => {
    const item = parseDartResponse(fixture).list![0]!
    const e = normalizeDartItem(item, SEEN)

    expect(e.sourceId).toBe('dart')
    expect(e.externalId).toBe('20260919000123')
    expect(e.title).toBe('단일판매·공급계약체결')
    expect(e.url).toBe('https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260919000123')
    expect(e.subject).toEqual({ name: '샘플전자', ticker: '005930', market: 'Y' })
    expect(e.firstSeenAt).toBe(SEEN)
  })

  it('빈 stock_code는 ticker를 비운다', () => {
    const item = parseDartResponse(fixture).list![1]!
    const e = normalizeDartItem(item, SEEN)
    expect(e.subject?.ticker).toBeUndefined()
  })

  it('코넥스(N)는 market을 비운다 — Market 타입은 Y|K뿐', () => {
    const item = parseDartResponse(fixture).list![2]!
    const e = normalizeDartItem(item, SEEN)
    expect(e.subject?.market).toBeUndefined()
  })

  it('rcept_dt를 날짜로 변환한다 (KST 자정 기준)', () => {
    const item = parseDartResponse(fixture).list![0]!
    const e = normalizeDartItem(item, SEEN)
    expect(e.occurredAt?.toISOString()).toBe('2026-09-18T15:00:00.000Z')
  })
})
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `pnpm --filter @app/worker test`
Expected: FAIL — `Cannot find module './schema.js'`

- [ ] **Step 4: zod 의존성 추가하고 스키마 구현**

```bash
pnpm --filter @app/worker add zod
```

`apps/worker/src/core/dart/schema.ts`:
```ts
import { z } from 'zod'

export const dartListItemSchema = z.object({
  corp_cls: z.string(),
  corp_name: z.string(),
  corp_code: z.string(),
  stock_code: z.string(),
  report_nm: z.string(),
  rcept_no: z.string(),
  flr_nm: z.string(),
  rcept_dt: z.string(),
  rm: z.string(),
})

export const dartListResponseSchema = z.object({
  status: z.string(),
  message: z.string(),
  list: z.array(dartListItemSchema).optional(),
})

export type DartListItem = z.infer<typeof dartListItemSchema>
export type DartListResponse = z.infer<typeof dartListResponseSchema>

export function parseDartResponse(json: unknown): DartListResponse {
  return dartListResponseSchema.parse(json)
}
```

- [ ] **Step 5: 정규화 구현**

`apps/worker/src/core/dart/normalize.ts`:
```ts
import type { Market, NormalizedEvent } from '@app/shared'
import type { DartListItem } from './schema.js'

const VIEWER_URL = 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo='
const KST_OFFSET_MS = 9 * 60 * 60 * 1000

/** "20260919" → KST 자정에 해당하는 Date. 형식이 다르면 null. */
export function parseRceptDate(rceptDt: string): Date | null {
  if (!/^\d{8}$/.test(rceptDt)) return null
  const y = Number(rceptDt.slice(0, 4))
  const m = Number(rceptDt.slice(4, 6))
  const d = Number(rceptDt.slice(6, 8))
  return new Date(Date.UTC(y, m - 1, d) - KST_OFFSET_MS)
}

function toMarket(corpCls: string): Market | undefined {
  return corpCls === 'Y' || corpCls === 'K' ? corpCls : undefined
}

export function normalizeDartItem(item: DartListItem, firstSeenAt: Date): NormalizedEvent {
  const ticker = item.stock_code.trim()
  return {
    sourceId: 'dart',
    externalId: item.rcept_no,
    occurredAt: parseRceptDate(item.rcept_dt),
    firstSeenAt,
    title: item.report_nm.trim(),
    url: `${VIEWER_URL}${item.rcept_no}`,
    subject: {
      name: item.corp_name,
      ...(ticker ? { ticker } : {}),
      ...(toMarket(item.corp_cls) ? { market: toMarket(item.corp_cls) } : {}),
    },
    raw: item,
  }
}
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `pnpm --filter @app/worker test`
Expected: PASS (7 tests)

- [ ] **Step 7: 커밋**

```bash
git add -A
git commit -m "feat(core): DART 응답 zod 스키마와 NormalizedEvent 정규화"
```

---

### Task 3: 룰 필터 — 구조적 게이트 (1~5)

**Files:**
- Create: `apps/worker/src/core/dart/keywords.ts`
- Create: `apps/worker/src/core/dart/rules.ts`
- Test: `apps/worker/src/core/dart/rules.test.ts`

**Interfaces:**
- Consumes: `NormalizedEvent`, `Verdict` (Task 1), `DartListItem` (Task 2)
- Produces: `evaluateDart(event: NormalizedEvent): Verdict` — Task 4에서 키워드 게이트를 이 함수에 이어 붙인다. `NOISE_PATTERNS`, `PERIODIC_PATTERNS`, `PREFIX_RULES`.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/worker/src/core/dart/rules.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import type { NormalizedEvent } from '@app/shared'
import { evaluateDart } from './rules.js'

const SEEN = new Date('2026-09-19T06:30:00.000Z')

function ev(title: string, opts: Partial<NormalizedEvent['subject']> = {}): NormalizedEvent {
  return {
    sourceId: 'dart',
    externalId: '20260919000001',
    occurredAt: SEEN,
    firstSeenAt: SEEN,
    title,
    url: 'https://example.test',
    subject: { name: '샘플', ticker: '005930', market: 'Y', ...opts },
    raw: {},
  }
}

describe('게이트 1 — 비상장 제외', () => {
  it('ticker가 없으면 drop', () => {
    const v = evaluateDart(ev('무상증자결정', { ticker: undefined }))
    expect(v).toEqual({ action: 'drop', reason: 'no-stock-code' })
  })
})

describe('게이트 2 — 시장 제외', () => {
  it('market이 Y/K가 아니면 drop', () => {
    const v = evaluateDart(ev('무상증자결정', { market: undefined }))
    expect(v).toEqual({ action: 'drop', reason: 'market-not-target' })
  })
})

describe('게이트 3 — 정기보고서 제외', () => {
  it.each(['사업보고서 (2025.12)', '반기보고서 (2025.06)', '분기보고서 (2025.03)'])(
    '%s 는 drop', (title) => {
      expect(evaluateDart(ev(title))).toEqual({ action: 'drop', reason: 'periodic-report' })
    })
})

describe('게이트 4 — 정정 접두어', () => {
  it('[기재정정]은 drop', () => {
    expect(evaluateDart(ev('[기재정정]무상증자결정')))
      .toEqual({ action: 'drop', reason: 'minor-correction' })
  })

  it('[발행조건확정]은 high로 통과', () => {
    const v = evaluateDart(ev('[발행조건확정]유상증자결정'))
    expect(v).toMatchObject({ action: 'pass', tier: 'high', rule: 'prefix:발행조건확정' })
  })

  it('[정정명령부과]는 critical로 통과', () => {
    const v = evaluateDart(ev('[정정명령부과]사업보고서'))
    expect(v).toMatchObject({ action: 'pass', tier: 'critical', rule: 'prefix:정정명령부과' })
  })
})

describe('게이트 5 — 노이즈 제외', () => {
  it('임원·주요주주 소유상황보고서는 drop', () => {
    expect(evaluateDart(ev('임원·주요주주특정증권등소유상황보고서')))
      .toEqual({ action: 'drop', reason: 'noise' })
  })

  it('IR개최는 drop', () => {
    expect(evaluateDart(ev('기업설명회(IR)개최(안내공시)')))
      .toEqual({ action: 'drop', reason: 'noise' })
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm --filter @app/worker test rules`
Expected: FAIL — `Cannot find module './rules.js'`

- [ ] **Step 3: 키워드 데이터 파일 작성**

`apps/worker/src/core/dart/keywords.ts`:
```ts
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
```

- [ ] **Step 4: 게이트 1~5 구현**

`apps/worker/src/core/dart/rules.ts`:
```ts
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
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm --filter @app/worker test rules`
Expected: PASS (10 tests)

- [ ] **Step 6: 커밋**

```bash
git add -A
git commit -m "feat(core): DART 룰 필터 구조적 게이트 1~5"
```

---

### Task 4: 룰 필터 — 키워드 티어링 (게이트 6~7)

**Files:**
- Modify: `apps/worker/src/core/dart/keywords.ts`
- Modify: `apps/worker/src/core/dart/rules.ts`
- Test: `apps/worker/src/core/dart/rules.test.ts` (테스트 추가)

**Interfaces:**
- Consumes: `evaluateDart` (Task 3)
- Produces: `CRITICAL_KEYWORDS`, `HIGH_KEYWORDS`, `matchKeyword(body: string): { tier: Tier; keyword: string } | null`

- [ ] **Step 1: 실패하는 테스트 추가**

`apps/worker/src/core/dart/rules.test.ts` 하단에 추가:
```ts
describe('게이트 6 — 키워드 티어링', () => {
  it.each([
    '단일판매·공급계약체결',
    '무상증자결정',
    '자기주식취득결정',
    '최대주주변경',
    '횡령·배임혐의발생',
  ])('%s 는 critical', (title) => {
    const v = evaluateDart(ev(title))
    expect(v).toMatchObject({ action: 'pass', tier: 'critical' })
  })

  it.each([
    '매출액또는손익구조30%(대규모법인은15%)이상변동',
    '타법인주식및출자증권취득결정',
    '현금·현물배당결정',
  ])('%s 는 high', (title) => {
    const v = evaluateDart(ev(title))
    expect(v).toMatchObject({ action: 'pass', tier: 'high' })
  })

  it('매칭된 키워드를 rule에 남긴다', () => {
    const v = evaluateDart(ev('무상증자결정'))
    expect(v).toMatchObject({ rule: 'keyword:무상증자결정' })
  })
})

describe('게이트 7 — 화이트리스트 미매칭', () => {
  it('목록에 없는 공시는 drop하고 사유를 남긴다', () => {
    expect(evaluateDart(ev('주주명부폐쇄기간또는기준일설정')))
      .toEqual({ action: 'drop', reason: 'no-keyword-match' })
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm --filter @app/worker test rules`
Expected: FAIL — critical/high 케이스가 전부 `no-keyword-match`로 drop됨

- [ ] **Step 3: 키워드 목록 추가**

`apps/worker/src/core/dart/keywords.ts` 하단에 추가:
```ts
/** 게이트 6 — 제목만으로 정보가 충분한 공시. LLM을 기다리지 않는다. */
export const CRITICAL_KEYWORDS: readonly string[] = [
  '단일판매·공급계약체결',
  '무상증자결정',
  '자기주식취득결정',
  '자기주식취득신탁계약체결결정',
  '유상증자결정',
  '전환사채권발행결정',
  '신주인수권부사채권발행결정',
  '최대주주변경',
  '주식분할결정',
  '주식병합결정',
  '감자결정',
  '회사합병결정',
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
```

- [ ] **Step 4: 게이트 6 구현**

`apps/worker/src/core/dart/rules.ts` 수정 — import에 키워드 추가:
```ts
import {
  CRITICAL_KEYWORDS, HIGH_KEYWORDS,
  NOISE_PATTERNS, PERIODIC_PATTERNS, PREFIX_RULES,
} from './keywords.js'
import type { Tier } from '@app/shared'
```

`splitPrefix` 아래에 추가:
```ts
/** 가장 먼저 매칭되는 키워드와 티어를 반환한다. critical이 high보다 우선한다. */
export function matchKeyword(body: string): { tier: Tier; keyword: string } | null {
  const critical = CRITICAL_KEYWORDS.find((k) => body.includes(k))
  if (critical) return { tier: 'critical', keyword: critical }

  const high = HIGH_KEYWORDS.find((k) => body.includes(k))
  if (high) return { tier: 'high', keyword: high }

  return null
}
```

`evaluateDart`의 마지막 `return` 을 교체:
```ts
  // 게이트 6 — 키워드 티어링
  const matched = matchKeyword(body)
  if (matched) {
    return { action: 'pass', tier: matched.tier, rule: `keyword:${matched.keyword}` }
  }

  // 게이트 7 — 화이트리스트 미매칭
  return { action: 'drop', reason: 'no-keyword-match' }
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm --filter @app/worker test rules`
Expected: PASS (20 tests)

- [ ] **Step 6: 커밋**

```bash
git add -A
git commit -m "feat(core): 키워드 기반 티어링 게이트 6~7"
```

---

### Task 5: 발송 정책과 폴링 스케줄

**Files:**
- Create: `apps/worker/src/core/policy.ts`
- Create: `apps/worker/src/core/schedule.ts`
- Test: `apps/worker/src/core/policy.test.ts`
- Test: `apps/worker/src/core/schedule.test.ts`

**Interfaces:**
- Consumes: `Tier` (Task 1)
- Produces:
  - `MAX_DELIVERY_AGE_MS`, `isTooOld(firstSeen: Date, now: Date): boolean`
  - `ttlFor(tier: Tier): number`, `expiresAt(tier: Tier, now: Date): Date`
  - `MERGE_THRESHOLD`
  - `pollIntervalMs(now: Date): number`

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/worker/src/core/policy.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { isTooOld, ttlFor, expiresAt, MAX_DELIVERY_AGE_MS, MERGE_THRESHOLD } from './policy.js'

const NOW = new Date('2026-09-19T06:30:00.000Z')

describe('isTooOld — 재기동 폭탄 방지', () => {
  it('10분 이내면 발송한다', () => {
    expect(isTooOld(new Date(NOW.getTime() - 9 * 60_000), NOW)).toBe(false)
  })

  it('10분을 넘으면 발송하지 않는다', () => {
    expect(isTooOld(new Date(NOW.getTime() - 11 * 60_000), NOW)).toBe(true)
  })

  it('상한은 정확히 10분이다', () => {
    expect(MAX_DELIVERY_AGE_MS).toBe(10 * 60_000)
  })
})

describe('ttlFor — 늦은 알림은 보내지 않는다', () => {
  it('critical은 5분', () => expect(ttlFor('critical')).toBe(5 * 60_000))
  it('high는 30분', () => expect(ttlFor('high')).toBe(30 * 60_000))
  it('normal은 2시간', () => expect(ttlFor('normal')).toBe(120 * 60_000))
})

describe('expiresAt', () => {
  it('now + ttl을 반환한다', () => {
    expect(expiresAt('critical', NOW).toISOString()).toBe('2026-09-19T06:35:00.000Z')
  })
})

describe('MERGE_THRESHOLD', () => {
  it('대기 3건 이상이면 병합한다', () => expect(MERGE_THRESHOLD).toBe(3))
})
```

`apps/worker/src/core/schedule.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { pollIntervalMs } from './schedule.js'

/** 인자는 UTC Date. KST = UTC+9 로 판정된다. */
describe('pollIntervalMs', () => {
  it('평일 장중(KST 10:00)은 2.5초', () => {
    expect(pollIntervalMs(new Date('2026-09-18T01:00:00Z'))).toBe(2_500)
  })

  it('평일 08:00 경계를 포함한다', () => {
    expect(pollIntervalMs(new Date('2026-09-17T23:00:00Z'))).toBe(2_500) // KST 금 08:00
  })

  it('평일 19:00 경계는 제외한다', () => {
    expect(pollIntervalMs(new Date('2026-09-18T10:00:00Z'))).toBe(30_000) // KST 금 19:00
  })

  it('평일 야간(KST 22:00)은 30초', () => {
    expect(pollIntervalMs(new Date('2026-09-18T13:00:00Z'))).toBe(30_000)
  })

  it('토요일은 5분', () => {
    expect(pollIntervalMs(new Date('2026-09-19T03:00:00Z'))).toBe(300_000) // KST 토 12:00
  })

  it('일요일은 5분', () => {
    expect(pollIntervalMs(new Date('2026-09-20T03:00:00Z'))).toBe(300_000)
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm --filter @app/worker test policy schedule`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: policy 구현**

`apps/worker/src/core/policy.ts`:
```ts
import type { Tier } from '@app/shared'

/** 접수 후 이 시간이 지난 공시는 발송하지 않는다 (장시간 다운 후 재기동 대비). */
export const MAX_DELIVERY_AGE_MS = 10 * 60_000

/** outbox 대기가 이 건수 이상이면 한 메시지로 병합한다. */
export const MERGE_THRESHOLD = 3

const TTL_MS: Record<Tier, number> = {
  critical: 5 * 60_000,
  high: 30 * 60_000,
  normal: 120 * 60_000,
}

export function isTooOld(firstSeen: Date, now: Date): boolean {
  return now.getTime() - firstSeen.getTime() > MAX_DELIVERY_AGE_MS
}

export function ttlFor(tier: Tier): number {
  return TTL_MS[tier]
}

export function expiresAt(tier: Tier, now: Date): Date {
  return new Date(now.getTime() + ttlFor(tier))
}
```

- [ ] **Step 4: schedule 구현**

`apps/worker/src/core/schedule.ts`:
```ts
const KST_OFFSET_MS = 9 * 60 * 60 * 1000

export const INTERVAL_ACTIVE_MS = 2_500
export const INTERVAL_OFFHOURS_MS = 30_000
export const INTERVAL_WEEKEND_MS = 300_000

/** UTC Date를 KST 기준 요일·시로 환산한다. */
export function toKst(now: Date): { day: number; hour: number } {
  const k = new Date(now.getTime() + KST_OFFSET_MS)
  return { day: k.getUTCDay(), hour: k.getUTCHours() }
}

/**
 * 시간대별 폴링 주기.
 * 평일 08:00~18:59 KST = 2.5초, 그 외 평일 = 30초, 주말 = 5분.
 * 공휴일은 판별하지 않는다 (공휴일에도 30초는 예산상 문제없다).
 */
export function pollIntervalMs(now: Date): number {
  const { day, hour } = toKst(now)
  if (day === 0 || day === 6) return INTERVAL_WEEKEND_MS
  if (hour >= 8 && hour < 19) return INTERVAL_ACTIVE_MS
  return INTERVAL_OFFHOURS_MS
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm --filter @app/worker test policy schedule`
Expected: PASS (14 tests)

- [ ] **Step 6: 커밋**

```bash
git add -A
git commit -m "feat(core): 발송 정책(TTL·지연상한)과 시간대별 폴링 주기"
```

---

### Task 6: 텔레그램 메시지 포맷과 이스케이프

**Files:**
- Create: `apps/worker/src/core/format.ts`
- Test: `apps/worker/src/core/format.test.ts`

**Interfaces:**
- Consumes: `NormalizedEvent`, `Tier` (Task 1)
- Produces: `escapeMarkdownV2(s: string): string`, `formatEvent(e, tier, summary?): string`, `formatMerged(items): string`, `DISCLAIMER`

**왜 core에 두는가:** 마크다운 이스케이프는 순수 문자열 변환이다. 어댑터에 두면 단위 테스트가 불가능해지는데, 이스케이프 실패는 메시지 전체를 깨뜨리는 실제 장애 원인이다.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/worker/src/core/format.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import type { NormalizedEvent } from '@app/shared'
import { escapeMarkdownV2, formatEvent, formatMerged, DISCLAIMER } from './format.js'

const e: NormalizedEvent = {
  sourceId: 'dart',
  externalId: '20260919000123',
  occurredAt: new Date('2026-09-18T15:00:00Z'),
  firstSeenAt: new Date('2026-09-19T06:30:00Z'),
  title: '단일판매·공급계약체결',
  url: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260919000123',
  subject: { name: '샘플_전자', ticker: '005930', market: 'Y' },
  raw: {},
}

describe('escapeMarkdownV2', () => {
  it('MarkdownV2 예약문자를 전부 이스케이프한다', () => {
    expect(escapeMarkdownV2('a_b*c[d]e(f)g~h`i>j#k+l-m=n|o{p}q.r!s'))
      .toBe('a\\_b\\*c\\[d\\]e\\(f\\)g\\~h\\`i\\>j\\#k\\+l\\-m\\=n\\|o\\{p\\}q\\.r\\!s')
  })

  it('회사명의 밑줄을 깨뜨리지 않는다', () => {
    expect(escapeMarkdownV2('샘플_전자')).toBe('샘플\\_전자')
  })
})

describe('formatEvent', () => {
  it('종목명·티커·제목·링크·고지를 담는다', () => {
    const msg = formatEvent(e, 'critical')
    expect(msg).toContain('샘플\\_전자')
    expect(msg).toContain('005930')
    expect(msg).toContain('단일판매')
    expect(msg).toContain(e.url)
    expect(msg).toContain(DISCLAIMER)
  })

  it('요약이 있으면 포함한다', () => {
    expect(formatEvent(e, 'high', '계약금액 500억원')).toContain('계약금액 500억원')
  })

  it('고지 문구는 항상 붙는다', () => {
    expect(formatEvent(e, 'normal')).toContain('투자 권유가 아닙니다')
  })
})

describe('formatMerged', () => {
  it('여러 건을 한 메시지로 묶는다', () => {
    const msg = formatMerged([
      { event: e, tier: 'high' },
      { event: { ...e, externalId: '2', title: '무상증자결정' }, tier: 'high' },
    ])
    expect(msg).toContain('공시 2건')
    expect(msg).toContain('단일판매')
    expect(msg).toContain('무상증자결정')
    expect(msg).toContain(DISCLAIMER)
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm --filter @app/worker test format`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`apps/worker/src/core/format.ts`:
```ts
import type { NormalizedEvent, Tier } from '@app/shared'

export const DISCLAIMER = '_정보 제공 목적이며 투자 권유가 아닙니다_'

const TIER_ICON: Record<Tier, string> = {
  critical: '🔴',
  high: '🟠',
  normal: '⚪',
}

/** 텔레그램 MarkdownV2 예약문자 전체. 하나라도 빠지면 메시지가 깨진다. */
const RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/g

export function escapeMarkdownV2(s: string): string {
  return s.replace(RESERVED, (c) => `\\${c}`)
}

function subjectLine(e: NormalizedEvent): string {
  const name = escapeMarkdownV2(e.subject?.name ?? '알 수 없음')
  const ticker = e.subject?.ticker
  return ticker ? `*${name}* \\(${escapeMarkdownV2(ticker)}\\)` : `*${name}*`
}

export function formatEvent(e: NormalizedEvent, tier: Tier, summary?: string): string {
  const lines = [
    `${TIER_ICON[tier]} ${subjectLine(e)}`,
    escapeMarkdownV2(e.title),
  ]
  if (summary) lines.push('', escapeMarkdownV2(summary))
  lines.push('', escapeMarkdownV2(e.url), '', DISCLAIMER)
  return lines.join('\n')
}

export function formatMerged(
  items: ReadonlyArray<{ event: NormalizedEvent; tier: Tier }>,
): string {
  const head = `📢 공시 ${items.length}건`
  const body = items.map(({ event, tier }) =>
    `${TIER_ICON[tier]} ${subjectLine(event)} — ${escapeMarkdownV2(event.title)}\n${escapeMarkdownV2(event.url)}`,
  )
  return [head, '', ...body, '', DISCLAIMER].join('\n')
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm --filter @app/worker test format`
Expected: PASS (6 tests)

- [ ] **Step 5: 커밋**

```bash
git add -A
git commit -m "feat(core): 텔레그램 MarkdownV2 포맷과 이스케이프"
```

---

### Task 7: 포트 정의와 DB 스키마

**Files:**
- Create: `apps/worker/src/ports/source.ts`, `store.ts`, `notifier.ts`, `summarizer.ts`, `clock.ts`
- Create: `apps/worker/src/adapters/store/schema.ts`
- Create: `apps/worker/drizzle.config.ts`
- Test: `apps/worker/src/adapters/store/schema.test.ts`

**Interfaces:**
- Consumes: `NormalizedEvent`, `Verdict`, `Tier` (Task 1)
- Produces: 포트 인터페이스 `EventSource`, `EventStore`, `Notifier`, `Summarizer`, `Clock`; Drizzle 테이블 `events`, `outbox`, `apiUsage`; 타입 `OutboxRow`, `PendingOutbox`

- [ ] **Step 1: 포트 정의**

`apps/worker/src/ports/clock.ts`:
```ts
export type Clock = { now(): Date }
export const systemClock: Clock = { now: () => new Date() }
```

`apps/worker/src/ports/source.ts`:
```ts
import type { NormalizedEvent } from '@app/shared'

export type EventSource = {
  readonly id: string
  /** 최신 이벤트를 가져온다. 호출 1회 = API 호출 1회. */
  fetchLatest(now: Date): Promise<NormalizedEvent[]>
}
```

`apps/worker/src/ports/store.ts`:
```ts
import type { NormalizedEvent, Tier, Verdict } from '@app/shared'

export type PendingOutbox = {
  id: number
  eventId: number
  tier: Tier
  event: NormalizedEvent
  attempts: number
  expiresAt: Date
}

export type EventStore = {
  /**
   * 이벤트를 기록하고, pass면 같은 트랜잭션에서 outbox도 예약한다.
   * 이미 존재하는 externalId면 아무것도 하지 않고 false를 반환한다.
   */
  recordEvent(
    event: NormalizedEvent,
    verdict: Verdict,
    opts: { enqueue: boolean; expiresAt: Date | null },
  ): Promise<boolean>

  claimPending(now: Date, limit: number): Promise<PendingOutbox[]>
  markSent(outboxId: number): Promise<void>
  markFailed(outboxId: number, error: string, nextAttemptAt: Date): Promise<void>
  markDead(outboxId: number, error: string): Promise<void>

  incrementApiUsage(sourceId: string, kstDate: string): Promise<number>
  getApiUsage(sourceId: string, kstDate: string): Promise<number>
}
```

`apps/worker/src/ports/notifier.ts`:
```ts
export type SendResult =
  | { ok: true }
  | { ok: false; retryAfterMs: number | null; error: string }

export type Notifier = {
  send(markdownV2: string): Promise<SendResult>
}
```

`apps/worker/src/ports/summarizer.ts`:
```ts
import type { NormalizedEvent } from '@app/shared'

export type Summarizer = {
  /** 실패하면 null. 요약 실패가 발송을 막아서는 안 된다. */
  summarize(event: NormalizedEvent): Promise<string | null>
}
```

- [ ] **Step 2: 실패하는 테스트 작성**

`apps/worker/src/adapters/store/schema.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { events, outbox, apiUsage } from './schema.js'
import { getTableConfig } from 'drizzle-orm/pg-core'

describe('events 테이블', () => {
  it('(source_id, external_id) 유니크 제약을 가진다 — 중복 발송 차단의 근거', () => {
    const cfg = getTableConfig(events)
    const cols = cfg.uniqueConstraints.flatMap((u) => u.columns.map((c) => c.name))
    expect(cols).toEqual(expect.arrayContaining(['source_id', 'external_id']))
  })

  it('drop된 이벤트도 사유를 남길 수 있도록 rule이 not null이다', () => {
    const cfg = getTableConfig(events)
    const rule = cfg.columns.find((c) => c.name === 'rule')
    expect(rule?.notNull).toBe(true)
  })
})

describe('outbox 테이블', () => {
  it('expires_at을 가진다 — 늦은 알림 포기의 근거', () => {
    const cfg = getTableConfig(outbox)
    expect(cfg.columns.map((c) => c.name)).toContain('expires_at')
  })
})

describe('api_usage 테이블', () => {
  it('(usage_date, source_id) 복합 PK를 가진다', () => {
    const cfg = getTableConfig(apiUsage)
    const pk = cfg.primaryKeys[0]
    expect(pk?.columns.map((c) => c.name)).toEqual(['usage_date', 'source_id'])
  })
})
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `pnpm --filter @app/worker test schema`
Expected: FAIL — drizzle 미설치

- [ ] **Step 4: 의존성 설치와 스키마 구현**

```bash
pnpm --filter @app/worker add drizzle-orm postgres
pnpm --filter @app/worker add -D drizzle-kit
```

`apps/worker/src/adapters/store/schema.ts`:
```ts
import {
  bigint, bigserial, date, integer, jsonb, pgTable,
  primaryKey, text, timestamp, unique,
} from 'drizzle-orm/pg-core'

export const events = pgTable('events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  sourceId: text('source_id').notNull(),
  externalId: text('external_id').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
  title: text('title').notNull(),
  url: text('url').notNull(),
  corpName: text('corp_name'),
  ticker: text('ticker'),
  market: text('market'),
  verdict: text('verdict').notNull(),
  tier: text('tier'),
  rule: text('rule').notNull(),
  raw: jsonb('raw').notNull(),
}, (t) => ({
  uq: unique('events_source_external_uq').on(t.sourceId, t.externalId),
}))

export const outbox = pgTable('outbox', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  eventId: bigint('event_id', { mode: 'number' }).notNull().references(() => events.id),
  tier: text('tier').notNull(),
  payload: jsonb('payload').notNull(),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastError: text('last_error'),
})

export const apiUsage = pgTable('api_usage', {
  usageDate: date('usage_date').notNull(),
  sourceId: text('source_id').notNull(),
  callCount: integer('call_count').notNull().default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.usageDate, t.sourceId] }),
}))
```

`apps/worker/drizzle.config.ts`:
```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/adapters/store/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
})
```

- [ ] **Step 5: 테스트 통과 확인 + 마이그레이션 생성**

Run: `pnpm --filter @app/worker test schema`
Expected: PASS (4 tests)

Run: `pnpm --filter @app/worker exec drizzle-kit generate`
Expected: `drizzle/0000_*.sql` 생성

- [ ] **Step 6: 커밋**

```bash
git add -A
git commit -m "feat: 포트 인터페이스와 Drizzle 스키마, 초기 마이그레이션"
```

---

### Task 8: Postgres 스토어 어댑터

**Files:**
- Create: `apps/worker/src/adapters/store/postgres.ts`
- Test: `apps/worker/src/adapters/store/postgres.test.ts`

**Interfaces:**
- Consumes: `EventStore`, `PendingOutbox` (Task 7), 스키마 테이블 (Task 7)
- Produces: `createPostgresStore(db: Db): EventStore`, `type Db`

**테스트 전략:** 실제 DB 없이 검증한다. `recordEvent`가 **단일 트랜잭션 안에서** events와 outbox를 함께 쓰는지가 핵심 계약이므로, 트랜잭션 콜백을 가로채는 fake db로 호출 순서를 확인한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/worker/src/adapters/store/postgres.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import type { NormalizedEvent } from '@app/shared'
import { createPostgresStore, type Db } from './postgres.js'

const event: NormalizedEvent = {
  sourceId: 'dart',
  externalId: '20260919000123',
  occurredAt: new Date('2026-09-18T15:00:00Z'),
  firstSeenAt: new Date('2026-09-19T06:30:00Z'),
  title: '무상증자결정',
  url: 'https://example.test',
  subject: { name: '샘플', ticker: '005930', market: 'Y' },
  raw: {},
}

/** 트랜잭션 호출을 기록하는 fake. */
function fakeDb(insertedEventId: number | null) {
  const calls: string[] = []
  const tx = {
    insert: (table: unknown) => {
      const name = (table as { _: { name: string } })._.name
      calls.push(name)
      return {
        values: () => ({
          onConflictDoNothing: () => ({
            returning: async () => (insertedEventId === null ? [] : [{ id: insertedEventId }]),
          }),
          returning: async () => [{ id: 1 }],
        }),
      }
    },
  }
  const db = { transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) }
  return { db: db as unknown as Db, calls }
}

describe('recordEvent', () => {
  it('pass면 events와 outbox를 같은 트랜잭션에서 쓴다', async () => {
    const { db, calls } = fakeDb(42)
    const store = createPostgresStore(db)

    const inserted = await store.recordEvent(
      event,
      { action: 'pass', tier: 'critical', rule: 'keyword:무상증자결정' },
      { enqueue: true, expiresAt: new Date('2026-09-19T06:35:00Z') },
    )

    expect(inserted).toBe(true)
    expect(calls).toEqual(['events', 'outbox'])
  })

  it('중복이면 outbox를 쓰지 않고 false를 반환한다', async () => {
    const { db, calls } = fakeDb(null)
    const store = createPostgresStore(db)

    const inserted = await store.recordEvent(
      event,
      { action: 'pass', tier: 'critical', rule: 'keyword:무상증자결정' },
      { enqueue: true, expiresAt: new Date('2026-09-19T06:35:00Z') },
    )

    expect(inserted).toBe(false)
    expect(calls).toEqual(['events'])
  })

  it('drop이면 events만 쓴다 — 사유 추적을 위해 기록은 남긴다', async () => {
    const { db, calls } = fakeDb(43)
    const store = createPostgresStore(db)

    const inserted = await store.recordEvent(
      event,
      { action: 'drop', reason: 'no-keyword-match' },
      { enqueue: false, expiresAt: null },
    )

    expect(inserted).toBe(true)
    expect(calls).toEqual(['events'])
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm --filter @app/worker test postgres`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`apps/worker/src/adapters/store/postgres.ts`:
```ts
import { and, asc, eq, lte, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { NormalizedEvent, Tier, Verdict } from '@app/shared'
import type { EventStore, PendingOutbox } from '../../ports/store.js'
import { apiUsage, events, outbox } from './schema.js'

export type Db = PostgresJsDatabase<Record<string, never>>

export function createPostgresStore(db: Db): EventStore {
  return {
    async recordEvent(event, verdict, opts) {
      return db.transaction(async (tx) => {
        const rows = await tx.insert(events).values({
          sourceId: event.sourceId,
          externalId: event.externalId,
          occurredAt: event.occurredAt,
          firstSeenAt: event.firstSeenAt,
          title: event.title,
          url: event.url,
          corpName: event.subject?.name ?? null,
          ticker: event.subject?.ticker ?? null,
          market: event.subject?.market ?? null,
          verdict: verdict.action,
          tier: verdict.action === 'pass' ? verdict.tier : null,
          rule: verdict.action === 'pass' ? verdict.rule : verdict.reason,
          raw: event.raw,
        }).onConflictDoNothing().returning({ id: events.id })

        const inserted = rows[0]
        if (!inserted) return false   // 중복 — outbox를 건드리지 않는다

        if (opts.enqueue && verdict.action === 'pass' && opts.expiresAt) {
          await tx.insert(outbox).values({
            eventId: inserted.id,
            tier: verdict.tier,
            payload: event as unknown as Record<string, unknown>,
            status: 'pending',
            attempts: 0,
            nextAttemptAt: event.firstSeenAt,
            expiresAt: opts.expiresAt,
          }).returning({ id: outbox.id })
        }
        return true
      })
    },

    async claimPending(now, limit) {
      const rows = await db.select().from(outbox)
        .where(and(eq(outbox.status, 'pending'), lte(outbox.nextAttemptAt, now)))
        .orderBy(asc(outbox.nextAttemptAt))
        .limit(limit)

      return rows.map((r): PendingOutbox => ({
        id: r.id,
        eventId: r.eventId,
        tier: r.tier as Tier,
        event: r.payload as unknown as NormalizedEvent,
        attempts: r.attempts,
        expiresAt: r.expiresAt,
      }))
    },

    async markSent(id) {
      await db.update(outbox).set({ status: 'sent' }).where(eq(outbox.id, id))
    },

    async markFailed(id, error, nextAttemptAt) {
      await db.update(outbox)
        .set({ attempts: sql`${outbox.attempts} + 1`, lastError: error, nextAttemptAt })
        .where(eq(outbox.id, id))
    },

    async markDead(id, error) {
      await db.update(outbox).set({ status: 'dead', lastError: error }).where(eq(outbox.id, id))
    },

    async incrementApiUsage(sourceId, kstDate) {
      const rows = await db.insert(apiUsage)
        .values({ usageDate: kstDate, sourceId, callCount: 1 })
        .onConflictDoUpdate({
          target: [apiUsage.usageDate, apiUsage.sourceId],
          set: { callCount: sql`${apiUsage.callCount} + 1` },
        })
        .returning({ callCount: apiUsage.callCount })
      return rows[0]?.callCount ?? 0
    },

    async getApiUsage(sourceId, kstDate) {
      const rows = await db.select({ c: apiUsage.callCount }).from(apiUsage)
        .where(and(eq(apiUsage.usageDate, kstDate), eq(apiUsage.sourceId, sourceId)))
      return rows[0]?.c ?? 0
    },
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm --filter @app/worker test postgres`
Expected: PASS (3 tests)

- [ ] **Step 5: 커밋**

```bash
git add -A
git commit -m "feat(adapters): Transactional Outbox를 보장하는 Postgres 스토어"
```

---

### Task 9: DART 소스 어댑터와 API 예산 가드

**Files:**
- Create: `apps/worker/src/core/budget.ts`
- Create: `apps/worker/src/adapters/sources/dart.ts`
- Test: `apps/worker/src/core/budget.test.ts`
- Test: `apps/worker/src/adapters/sources/dart.test.ts`

**Interfaces:**
- Consumes: `EventSource` (Task 7), `parseDartResponse`/`normalizeDartItem` (Task 2), `pollIntervalMs` (Task 5)
- Produces: `DAILY_LIMIT`, `kstDateString(now: Date): string`, `budgetGuard(used, base): number`; `createDartSource(cfg): EventSource`, `DartApiError`

- [ ] **Step 1: 예산 가드 테스트 작성**

`apps/worker/src/core/budget.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { DAILY_LIMIT, kstDateString, budgetGuard } from './budget.js'

describe('DAILY_LIMIT', () => {
  it('OpenDART 한도는 일 20,000건이다', () => expect(DAILY_LIMIT).toBe(20_000))
})

describe('kstDateString', () => {
  it('UTC 자정 직전도 KST 기준 다음날로 계산한다', () => {
    expect(kstDateString(new Date('2026-09-19T15:30:00Z'))).toBe('2026-09-20')
  })
  it('UTC 아침은 같은 날', () => {
    expect(kstDateString(new Date('2026-09-19T06:30:00Z'))).toBe('2026-09-19')
  })
})

describe('budgetGuard — 한도 초과로 서비스가 멈추는 것이 최악이다', () => {
  it('여유가 있으면 기본 주기를 유지한다', () => {
    expect(budgetGuard(5_000, 2_500)).toBe(2_500)
  })
  it('80%를 넘으면 2배로 늘린다', () => {
    expect(budgetGuard(16_500, 2_500)).toBe(5_000)
  })
  it('95%를 넘으면 10배로 늘린다', () => {
    expect(budgetGuard(19_100, 2_500)).toBe(25_000)
  })
  it('한도에 도달하면 5분으로 고정한다', () => {
    expect(budgetGuard(20_000, 2_500)).toBe(300_000)
  })
})
```

- [ ] **Step 2: 예산 가드 구현**

`apps/worker/src/core/budget.ts`:
```ts
const KST_OFFSET_MS = 9 * 60 * 60 * 1000

export const DAILY_LIMIT = 20_000

/** KST 기준 YYYY-MM-DD. 자정 리셋의 기준이다. */
export function kstDateString(now: Date): string {
  return new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10)
}

/**
 * 남은 예산에 따라 폴링 주기를 늘린다.
 * 한도 초과로 020 에러를 맞아 서비스가 통째로 멈추는 것이 최악의 실패이므로 보수적으로 잡는다.
 */
export function budgetGuard(used: number, baseIntervalMs: number): number {
  if (used >= DAILY_LIMIT) return 300_000
  const ratio = used / DAILY_LIMIT
  if (ratio > 0.95) return baseIntervalMs * 10
  if (ratio > 0.80) return baseIntervalMs * 2
  return baseIntervalMs
}
```

- [ ] **Step 3: 소스 어댑터 테스트 작성**

`apps/worker/src/adapters/sources/dart.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import fixture from '../../__fixtures__/dart-list.json' with { type: 'json' }
import { createDartSource, DartApiError } from './dart.js'

const NOW = new Date('2026-09-19T06:30:00Z')

function sourceWith(json: unknown, ok = true) {
  const fetchImpl = vi.fn(async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => json,
  })) as unknown as typeof fetch
  const src = createDartSource({ apiKey: 'test-key', fetchImpl })
  return { src, fetchImpl }
}

describe('createDartSource', () => {
  it('list.json을 page_count=100, 최신순으로 호출한다', async () => {
    const { src, fetchImpl } = sourceWith(fixture)
    await src.fetchLatest(NOW)

    const url = String((fetchImpl as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0])
    expect(url).toContain('/api/list.json')
    expect(url).toContain('page_count=100')
    expect(url).toContain('sort=date')
    expect(url).toContain('sort_mth=desc')
  })

  it('API 키를 URL에 담되 로그에 남기지 않도록 반환값에는 포함하지 않는다', async () => {
    const { src } = sourceWith(fixture)
    const events = await src.fetchLatest(NOW)
    expect(JSON.stringify(events)).not.toContain('test-key')
  })

  it('정상 응답을 NormalizedEvent 배열로 변환한다', async () => {
    const { src } = sourceWith(fixture)
    const events = await src.fetchLatest(NOW)
    expect(events).toHaveLength(3)
    expect(events[0]!.externalId).toBe('20260919000123')
    expect(events[0]!.firstSeenAt).toBe(NOW)
  })

  it('013(데이터 없음)은 빈 배열을 반환한다', async () => {
    const { src } = sourceWith({ status: '013', message: '조회된 데이타가 없습니다.' })
    expect(await src.fetchLatest(NOW)).toEqual([])
  })

  it('020(한도 초과)은 DartApiError를 던진다', async () => {
    const { src } = sourceWith({ status: '020', message: '요청 제한을 초과하였습니다.' })
    await expect(src.fetchLatest(NOW)).rejects.toThrow(DartApiError)
  })

  it('800(점검중)은 DartApiError를 던진다', async () => {
    const { src } = sourceWith({ status: '800', message: '시스템 점검' })
    await expect(src.fetchLatest(NOW)).rejects.toMatchObject({ status: '800' })
  })

  it('HTTP 실패는 던진다', async () => {
    const { src } = sourceWith({}, false)
    await expect(src.fetchLatest(NOW)).rejects.toThrow()
  })
})
```

- [ ] **Step 4: 테스트 실패 확인**

Run: `pnpm --filter @app/worker test dart budget`
Expected: FAIL — 모듈 없음

- [ ] **Step 5: 소스 어댑터 구현**

`apps/worker/src/adapters/sources/dart.ts`:
```ts
import type { NormalizedEvent } from '@app/shared'
import type { EventSource } from '../../ports/source.js'
import { normalizeDartItem } from '../../core/dart/normalize.js'
import { parseDartResponse } from '../../core/dart/schema.js'

const ENDPOINT = 'https://opendart.fss.or.kr/api/list.json'

export class DartApiError extends Error {
  constructor(readonly status: string, message: string) {
    super(`DART ${status}: ${message}`)
    this.name = 'DartApiError'
  }
}

export type DartSourceConfig = {
  apiKey: string
  fetchImpl?: typeof fetch
}

export function createDartSource(cfg: DartSourceConfig): EventSource {
  const doFetch = cfg.fetchImpl ?? fetch

  return {
    id: 'dart',

    async fetchLatest(now: Date): Promise<NormalizedEvent[]> {
      const url = new URL(ENDPOINT)
      url.searchParams.set('crtfc_key', cfg.apiKey)
      url.searchParams.set('page_count', '100')
      url.searchParams.set('sort', 'date')
      url.searchParams.set('sort_mth', 'desc')

      const res = await doFetch(url.toString())
      if (!res.ok) throw new Error(`DART HTTP ${res.status}`)

      const parsed = parseDartResponse(await res.json())

      if (parsed.status === '013') return []            // 데이터 없음 — 정상
      if (parsed.status !== '000') {
        throw new DartApiError(parsed.status, parsed.message)
      }

      return (parsed.list ?? []).map((item) => normalizeDartItem(item, now))
    },
  }
}
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `pnpm --filter @app/worker test dart budget`
Expected: PASS (13 tests)

- [ ] **Step 7: 커밋**

```bash
git add -A
git commit -m "feat(adapters): DART 소스 어댑터와 API 예산 가드"
```

---

### Task 10: 텔레그램 notifier와 rate limiter

**Files:**
- Create: `apps/worker/src/adapters/notifier/rate-limiter.ts`
- Create: `apps/worker/src/adapters/notifier/telegram.ts`
- Test: `apps/worker/src/adapters/notifier/rate-limiter.test.ts`
- Test: `apps/worker/src/adapters/notifier/telegram.test.ts`

**Interfaces:**
- Consumes: `Notifier`, `SendResult` (Task 7)
- Produces: `createTokenBucket(opts): TokenBucket` (`tryTake(now): boolean`), `createTelegramNotifier(cfg): Notifier`

- [ ] **Step 1: rate limiter 테스트 작성**

`apps/worker/src/adapters/notifier/rate-limiter.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { createTokenBucket, MESSAGES_PER_MINUTE } from './rate-limiter.js'

const T0 = new Date('2026-09-19T06:30:00Z')
const at = (ms: number) => new Date(T0.getTime() + ms)

describe('MESSAGES_PER_MINUTE', () => {
  it('텔레그램 한도(분당 20)보다 낮은 15로 스스로 제한한다', () => {
    expect(MESSAGES_PER_MINUTE).toBe(15)
  })
})

describe('createTokenBucket', () => {
  it('용량만큼은 즉시 통과시킨다', () => {
    const b = createTokenBucket({ capacity: 3, refillPerMinute: 15 })
    expect(b.tryTake(T0)).toBe(true)
    expect(b.tryTake(T0)).toBe(true)
    expect(b.tryTake(T0)).toBe(true)
  })

  it('용량을 넘으면 거절한다', () => {
    const b = createTokenBucket({ capacity: 2, refillPerMinute: 15 })
    b.tryTake(T0); b.tryTake(T0)
    expect(b.tryTake(T0)).toBe(false)
  })

  it('시간이 지나면 토큰이 회복된다', () => {
    const b = createTokenBucket({ capacity: 2, refillPerMinute: 15 })
    b.tryTake(T0); b.tryTake(T0)
    expect(b.tryTake(at(4_000))).toBe(true)   // 15/분 = 4초당 1개
  })

  it('회복은 용량을 넘지 않는다', () => {
    const b = createTokenBucket({ capacity: 2, refillPerMinute: 15 })
    b.tryTake(T0)
    b.tryTake(at(600_000))
    b.tryTake(at(600_000))
    expect(b.tryTake(at(600_000))).toBe(false)
  })
})
```

- [ ] **Step 2: rate limiter 구현**

`apps/worker/src/adapters/notifier/rate-limiter.ts`:
```ts
/** 텔레그램 같은 채팅 한도는 분당 약 20건. 429를 맞기 전에 우리가 먼저 조인다. */
export const MESSAGES_PER_MINUTE = 15

export type TokenBucket = { tryTake(now: Date): boolean }

export function createTokenBucket(opts: {
  capacity: number
  refillPerMinute: number
}): TokenBucket {
  let tokens = opts.capacity
  let lastRefill: number | null = null
  const refillIntervalMs = 60_000 / opts.refillPerMinute

  return {
    tryTake(now: Date): boolean {
      const t = now.getTime()
      if (lastRefill === null) lastRefill = t

      const gained = Math.floor((t - lastRefill) / refillIntervalMs)
      if (gained > 0) {
        tokens = Math.min(opts.capacity, tokens + gained)
        lastRefill += gained * refillIntervalMs
      }

      if (tokens <= 0) return false
      tokens -= 1
      return true
    },
  }
}
```

- [ ] **Step 3: telegram 테스트 작성**

`apps/worker/src/adapters/notifier/telegram.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { createTelegramNotifier } from './telegram.js'

function notifierWith(body: unknown, httpOk = true, httpStatus = 200) {
  const fetchImpl = vi.fn(async () => ({
    ok: httpOk,
    status: httpStatus,
    json: async () => body,
  })) as unknown as typeof fetch
  const n = createTelegramNotifier({ token: 'bot-token', chatId: '-100', fetchImpl })
  return { n, fetchImpl }
}

describe('createTelegramNotifier', () => {
  it('성공하면 ok를 반환한다', async () => {
    const { n } = notifierWith({ ok: true })
    expect(await n.send('hello')).toEqual({ ok: true })
  })

  it('MarkdownV2로 보낸다', async () => {
    const { n, fetchImpl } = notifierWith({ ok: true })
    await n.send('hello')
    const init = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls[0]![1]
    expect(String(init.body)).toContain('MarkdownV2')
  })

  it('429면 retry_after를 밀리초로 환산해 반환한다', async () => {
    const { n } = notifierWith(
      { ok: false, error_code: 429, parameters: { retry_after: 7 } }, false, 429,
    )
    expect(await n.send('x')).toMatchObject({ ok: false, retryAfterMs: 7_000 })
  })

  it('그 외 실패는 retryAfterMs가 null이다', async () => {
    const { n } = notifierWith({ ok: false, description: 'Bad Request' }, false, 400)
    expect(await n.send('x')).toMatchObject({ ok: false, retryAfterMs: null })
  })

  it('토큰을 에러 메시지에 노출하지 않는다', async () => {
    const { n } = notifierWith({ ok: false, description: 'Unauthorized' }, false, 401)
    const r = await n.send('x')
    expect(JSON.stringify(r)).not.toContain('bot-token')
  })

  it('자체 rate limit에 걸리면 API를 호출하지 않고 재시도를 요청한다', async () => {
    const t = new Date('2026-09-19T06:30:00Z')
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ ok: true }),
    })) as unknown as typeof fetch
    const n = createTelegramNotifier({
      token: 'bot-token', chatId: '-100', fetchImpl, now: () => t,
    })

    for (let i = 0; i < 5; i += 1) expect((await n.send('x')).ok).toBe(true)

    expect(await n.send('x')).toMatchObject({
      ok: false, retryAfterMs: 4_000, error: 'local-rate-limit',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(5)   // 6번째는 호출되지 않았다
  })
})
```

- [ ] **Step 4: 테스트 실패 확인**

Run: `pnpm --filter @app/worker test rate-limiter telegram`
Expected: FAIL — telegram 모듈 없음

- [ ] **Step 5: telegram 구현**

`apps/worker/src/adapters/notifier/telegram.ts`:
```ts
import type { Notifier, SendResult } from '../../ports/notifier.js'
import { createTokenBucket, MESSAGES_PER_MINUTE } from './rate-limiter.js'

export type TelegramConfig = {
  token: string
  chatId: string
  fetchImpl?: typeof fetch
  /** 테스트에서 시간을 고정하기 위한 주입점. 어댑터이므로 순수성 제약은 없다. */
  now?: () => Date
}

/** 짧은 순간의 몰림은 흡수하되, 평균은 MESSAGES_PER_MINUTE로 수렴시킨다. */
const BUCKET_CAPACITY = 5

/** 15건/분 = 4초당 토큰 1개. 토큰이 없으면 이만큼 뒤에 재시도한다. */
const REFILL_WAIT_MS = 4_000

type TelegramResponse = {
  ok: boolean
  description?: string
  parameters?: { retry_after?: number }
}

export function createTelegramNotifier(cfg: TelegramConfig): Notifier {
  const doFetch = cfg.fetchImpl ?? fetch
  const now = cfg.now ?? (() => new Date())
  const bucket = createTokenBucket({
    capacity: BUCKET_CAPACITY,
    refillPerMinute: MESSAGES_PER_MINUTE,
  })
  const url = `https://api.telegram.org/bot${cfg.token}/sendMessage`

  return {
    async send(markdownV2: string): Promise<SendResult> {
      // 429를 맞기 전에 우리가 먼저 조인다.
      // 실패로 반환하면 dispatch의 기존 재시도 경로가 그대로 처리한다.
      if (!bucket.tryTake(now())) {
        return { ok: false, retryAfterMs: REFILL_WAIT_MS, error: 'local-rate-limit' }
      }

      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: cfg.chatId,
          text: markdownV2,
          parse_mode: 'MarkdownV2',
          disable_web_page_preview: true,
        }),
      })

      const body = (await res.json()) as TelegramResponse
      if (res.ok && body.ok) return { ok: true }

      const retryAfter = body.parameters?.retry_after
      return {
        ok: false,
        retryAfterMs: typeof retryAfter === 'number' ? retryAfter * 1_000 : null,
        // 토큰이 담긴 url은 절대 포함하지 않는다
        error: body.description ?? `HTTP ${res.status}`,
      }
    },
  }
}
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `pnpm --filter @app/worker test rate-limiter telegram`
Expected: PASS (11 tests)

- [ ] **Step 7: 커밋**

```bash
git add -A
git commit -m "feat(adapters): 텔레그램 notifier와 토큰버킷 rate limiter"
```

---

### Task 11: 수집 파이프라인

**Files:**
- Create: `apps/worker/src/pipeline/ingest.ts`
- Test: `apps/worker/src/pipeline/ingest.test.ts`

**Interfaces:**
- Consumes: `EventSource`, `EventStore` (Task 7), `evaluateDart` (Task 4), `isTooOld`/`expiresAt` (Task 5)
- Produces: `runIngest(deps, now): Promise<IngestStats>`; `type IngestStats = { fetched: number; recorded: number; enqueued: number; duplicated: number }`

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/worker/src/pipeline/ingest.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import type { NormalizedEvent } from '@app/shared'
import type { EventSource } from '../ports/source.js'
import type { EventStore } from '../ports/store.js'
import { runIngest } from './ingest.js'

const NOW = new Date('2026-09-19T06:30:00Z')

function mkEvent(over: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    sourceId: 'dart',
    externalId: '1',
    occurredAt: NOW,
    firstSeenAt: NOW,
    title: '무상증자결정',
    url: 'https://example.test',
    subject: { name: '샘플', ticker: '005930', market: 'Y' },
    raw: {},
    ...over,
  }
}

function fakeStore(recordReturns = true) {
  const recordEvent = vi.fn(async () => recordReturns)
  const store = { recordEvent } as unknown as EventStore
  return { store, recordEvent }
}

function fakeSource(events: NormalizedEvent[]): EventSource {
  return { id: 'dart', fetchLatest: async () => events }
}

describe('runIngest', () => {
  it('pass 이벤트는 enqueue=true로 기록한다', async () => {
    const { store, recordEvent } = fakeStore()
    const stats = await runIngest({ source: fakeSource([mkEvent()]), store }, NOW)

    expect(stats).toMatchObject({ fetched: 1, recorded: 1, enqueued: 1 })
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: '1' }),
      expect.objectContaining({ action: 'pass', tier: 'critical' }),
      expect.objectContaining({ enqueue: true }),
    )
  })

  it('drop 이벤트도 사유와 함께 기록하되 enqueue하지 않는다', async () => {
    const { store, recordEvent } = fakeStore()
    const stats = await runIngest(
      { source: fakeSource([mkEvent({ title: '주주명부폐쇄기간또는기준일설정' })]), store },
      NOW,
    )

    expect(stats).toMatchObject({ recorded: 1, enqueued: 0 })
    expect(recordEvent).toHaveBeenCalledWith(
      expect.anything(),
      { action: 'drop', reason: 'no-keyword-match' },
      { enqueue: false, expiresAt: null },
    )
  })

  it('10분 넘은 공시는 기록만 하고 발송하지 않는다 — 재기동 폭탄 방지', async () => {
    const { store, recordEvent } = fakeStore()
    const old = mkEvent({ firstSeenAt: new Date(NOW.getTime() - 11 * 60_000) })
    const stats = await runIngest({ source: fakeSource([old]), store }, NOW)

    expect(stats.enqueued).toBe(0)
    expect(recordEvent).toHaveBeenCalledWith(
      expect.anything(),
      { action: 'drop', reason: 'too-old' },
      { enqueue: false, expiresAt: null },
    )
  })

  it('중복은 duplicated로 집계한다', async () => {
    const { store } = fakeStore(false)
    const stats = await runIngest({ source: fakeSource([mkEvent()]), store }, NOW)
    expect(stats).toMatchObject({ recorded: 0, duplicated: 1 })
  })

  it('빈 응답도 안전하게 처리한다', async () => {
    const { store } = fakeStore()
    expect(await runIngest({ source: fakeSource([]), store }, NOW))
      .toEqual({ fetched: 0, recorded: 0, enqueued: 0, duplicated: 0 })
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm --filter @app/worker test ingest`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`apps/worker/src/pipeline/ingest.ts`:
```ts
import type { Verdict } from '@app/shared'
import { evaluateDart } from '../core/dart/rules.js'
import { expiresAt, isTooOld } from '../core/policy.js'
import type { EventSource } from '../ports/source.js'
import type { EventStore } from '../ports/store.js'

export type IngestDeps = { source: EventSource; store: EventStore }

export type IngestStats = {
  fetched: number
  recorded: number
  enqueued: number
  duplicated: number
}

export async function runIngest(deps: IngestDeps, now: Date): Promise<IngestStats> {
  const events = await deps.source.fetchLatest(now)
  const stats: IngestStats = { fetched: events.length, recorded: 0, enqueued: 0, duplicated: 0 }

  for (const event of events) {
    let verdict: Verdict = evaluateDart(event)

    // 게이트 8 — 오래된 공시는 통과했더라도 발송하지 않는다
    if (verdict.action === 'pass' && isTooOld(event.firstSeenAt, now)) {
      verdict = { action: 'drop', reason: 'too-old' }
    }

    const enqueue = verdict.action === 'pass'
    const inserted = await deps.store.recordEvent(event, verdict, {
      enqueue,
      expiresAt: verdict.action === 'pass' ? expiresAt(verdict.tier, now) : null,
    })

    if (!inserted) { stats.duplicated += 1; continue }
    stats.recorded += 1
    if (enqueue) stats.enqueued += 1
  }

  return stats
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm --filter @app/worker test ingest`
Expected: PASS (5 tests)

- [ ] **Step 5: 커밋**

```bash
git add -A
git commit -m "feat(pipeline): 수집·필터·기록 파이프라인"
```

---

### Task 12: LLM 요약 어댑터

**Files:**
- Create: `apps/worker/src/adapters/summarizer/llm.ts`
- Create: `apps/worker/src/adapters/summarizer/noop.ts`
- Test: `apps/worker/src/adapters/summarizer/llm.test.ts`

**Interfaces:**
- Consumes: `Summarizer` (Task 7), `NormalizedEvent` (Task 1)
- Produces: `createLlmSummarizer(cfg): Summarizer`, `noopSummarizer: Summarizer`, `SUMMARY_SYSTEM_PROMPT`

**규제 제약:** 프롬프트에 호재/악재·목표가·투자의견을 요구하는 문구를 넣지 않는다. 사실 요약과 수치 추출만 요청한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/worker/src/adapters/summarizer/llm.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import type { NormalizedEvent } from '@app/shared'
import { createLlmSummarizer, SUMMARY_SYSTEM_PROMPT } from './llm.js'
import { noopSummarizer } from './noop.js'

const event: NormalizedEvent = {
  sourceId: 'dart', externalId: '1',
  occurredAt: null, firstSeenAt: new Date('2026-09-19T06:30:00Z'),
  title: '타법인주식및출자증권취득결정',
  url: 'https://example.test',
  subject: { name: '샘플', ticker: '005930', market: 'Y' },
  raw: {},
}

function summarizerWith(impl: () => Promise<unknown>) {
  const fetchImpl = vi.fn(impl) as unknown as typeof fetch
  return createLlmSummarizer({ apiKey: 'k', model: 'm', endpoint: 'https://llm.test', fetchImpl })
}

describe('SUMMARY_SYSTEM_PROMPT — 규제선', () => {
  it.each(['호재', '악재', '목표가', '매수', '매도', '투자의견'])(
    '"%s"를 요구하지 않는다', (word) => {
      expect(SUMMARY_SYSTEM_PROMPT).not.toContain(word)
    })

  it('사실 요약과 수치 추출을 지시한다', () => {
    expect(SUMMARY_SYSTEM_PROMPT).toContain('사실')
    expect(SUMMARY_SYSTEM_PROMPT).toContain('금액')
  })
})

describe('createLlmSummarizer', () => {
  it('요약 텍스트를 반환한다', async () => {
    const s = summarizerWith(async () => ({
      ok: true, status: 200,
      json: async () => ({ content: [{ type: 'text', text: '계약금액 500억원' }] }),
    }))
    expect(await s.summarize(event)).toBe('계약금액 500억원')
  })

  it('HTTP 실패 시 null을 반환한다 — 요약 실패가 발송을 막으면 안 된다', async () => {
    const s = summarizerWith(async () => ({ ok: false, status: 500, json: async () => ({}) }))
    expect(await s.summarize(event)).toBeNull()
  })

  it('예외가 나도 null을 반환한다', async () => {
    const s = summarizerWith(async () => { throw new Error('network down') })
    expect(await s.summarize(event)).toBeNull()
  })

  it('응답 형태가 다르면 null을 반환한다', async () => {
    const s = summarizerWith(async () => ({ ok: true, status: 200, json: async () => ({ foo: 1 }) }))
    expect(await s.summarize(event)).toBeNull()
  })
})

describe('noopSummarizer', () => {
  it('항상 null — critical 경로에서 LLM을 건너뛰는 데 쓴다', async () => {
    expect(await noopSummarizer.summarize(event)).toBeNull()
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm --filter @app/worker test llm`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 구현**

`apps/worker/src/adapters/summarizer/noop.ts`:
```ts
import type { Summarizer } from '../../ports/summarizer.js'

/** critical 티어는 LLM을 기다리지 않는다. 그 경로에 주입한다. */
export const noopSummarizer: Summarizer = {
  summarize: async () => null,
}
```

`apps/worker/src/adapters/summarizer/llm.ts`:
```ts
import type { NormalizedEvent } from '@app/shared'
import type { Summarizer } from '../../ports/summarizer.js'

/**
 * 규제 제약: 투자 판단을 생성하지 않는다.
 * 사실 요약과 수치 추출만 수행한다.
 */
export const SUMMARY_SYSTEM_PROMPT = [
  '너는 한국 기업 공시를 요약하는 도구다.',
  '공시에 적힌 사실만 2~3줄로 요약하라.',
  '금액, 비율, 지분율, 기간 같은 수치가 있으면 반드시 포함하라.',
  '공시에 없는 내용을 추측하거나 덧붙이지 마라.',
  '평가, 전망, 권유에 해당하는 표현을 쓰지 마라.',
].join('\n')

export type LlmConfig = {
  apiKey: string
  model: string
  endpoint: string
  fetchImpl?: typeof fetch
}

type LlmResponse = { content?: Array<{ type: string; text?: string }> }

export function createLlmSummarizer(cfg: LlmConfig): Summarizer {
  const doFetch = cfg.fetchImpl ?? fetch

  return {
    async summarize(event: NormalizedEvent): Promise<string | null> {
      try {
        const res = await doFetch(cfg.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': cfg.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: cfg.model,
            max_tokens: 300,
            system: SUMMARY_SYSTEM_PROMPT,
            messages: [{
              role: 'user',
              content: `회사: ${event.subject?.name ?? '미상'}\n공시명: ${event.title}`,
            }],
          }),
        })

        if (!res.ok) return null

        const body = (await res.json()) as LlmResponse
        const text = body.content?.find((c) => c.type === 'text')?.text
        return text?.trim() || null
      } catch {
        return null   // 요약 실패가 발송을 막아서는 안 된다
      }
    },
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm --filter @app/worker test llm`
Expected: PASS (11 tests)

- [ ] **Step 5: 커밋**

```bash
git add -A
git commit -m "feat(adapters): LLM 요약기 — 투자판단 생성 없이 사실 요약만"
```

---

### Task 13: 발송 파이프라인 (재시도·TTL·병합)

**Files:**
- Create: `apps/worker/src/core/retry.ts`
- Create: `apps/worker/src/pipeline/dispatch.ts`
- Test: `apps/worker/src/core/retry.test.ts`
- Test: `apps/worker/src/pipeline/dispatch.test.ts`

**Interfaces:**
- Consumes: `EventStore`/`PendingOutbox`/`Notifier`/`Summarizer` (Task 7), `formatEvent`/`formatMerged` (Task 6), `MERGE_THRESHOLD` (Task 5), `createTokenBucket` (Task 10)
- Produces: `MAX_ATTEMPTS`, `backoffMs(attempts): number`, `nextAttemptAt(attempts, now): Date`; `runDispatch(deps, now): Promise<DispatchStats>`

- [ ] **Step 1: 재시도 테스트 작성**

`apps/worker/src/core/retry.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { MAX_ATTEMPTS, backoffMs, nextAttemptAt } from './retry.js'

const NOW = new Date('2026-09-19T06:30:00Z')

describe('backoffMs — 지수 백오프', () => {
  it.each([
    [0, 5_000],
    [1, 15_000],
    [2, 60_000],
    [3, 300_000],
    [4, 1_800_000],
  ])('시도 %i회 후 대기 %ims', (attempts, expected) => {
    expect(backoffMs(attempts)).toBe(expected)
  })

  it('범위를 넘으면 마지막 값을 유지한다', () => {
    expect(backoffMs(99)).toBe(1_800_000)
  })
})

describe('MAX_ATTEMPTS', () => {
  it('5회 실패하면 포기한다', () => expect(MAX_ATTEMPTS).toBe(5))
})

describe('nextAttemptAt', () => {
  it('now + backoff', () => {
    expect(nextAttemptAt(0, NOW).toISOString()).toBe('2026-09-19T06:30:05.000Z')
  })
})
```

- [ ] **Step 2: 재시도 구현**

`apps/worker/src/core/retry.ts`:
```ts
export const MAX_ATTEMPTS = 5

const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000, 1_800_000] as const

export function backoffMs(attempts: number): number {
  const i = Math.min(Math.max(attempts, 0), BACKOFF_MS.length - 1)
  return BACKOFF_MS[i]!
}

export function nextAttemptAt(attempts: number, now: Date): Date {
  return new Date(now.getTime() + backoffMs(attempts))
}
```

- [ ] **Step 3: 발송 테스트 작성**

`apps/worker/src/pipeline/dispatch.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import type { NormalizedEvent } from '@app/shared'
import type { EventStore, PendingOutbox } from '../ports/store.js'
import type { Notifier } from '../ports/notifier.js'
import { noopSummarizer } from '../adapters/summarizer/noop.js'
import { runDispatch } from './dispatch.js'

const NOW = new Date('2026-09-19T06:30:00Z')

const event: NormalizedEvent = {
  sourceId: 'dart', externalId: '1', occurredAt: null, firstSeenAt: NOW,
  title: '무상증자결정', url: 'https://example.test',
  subject: { name: '샘플', ticker: '005930', market: 'Y' }, raw: {},
}

function pending(over: Partial<PendingOutbox> = {}): PendingOutbox {
  return {
    id: 1, eventId: 10, tier: 'critical', event,
    attempts: 0, expiresAt: new Date(NOW.getTime() + 300_000), ...over,
  }
}

function deps(items: PendingOutbox[], send: Notifier['send']) {
  const markSent = vi.fn(async () => {})
  const markFailed = vi.fn(async () => {})
  const markDead = vi.fn(async () => {})
  const store = {
    claimPending: async () => items,
    markSent, markFailed, markDead,
  } as unknown as EventStore
  return {
    deps: { store, notifier: { send }, summarizer: noopSummarizer },
    markSent, markFailed, markDead,
  }
}

describe('runDispatch', () => {
  it('성공하면 sent로 표시한다', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    const { deps: d, markSent } = deps([pending()], send)

    const stats = await runDispatch(d, NOW)
    expect(stats.sent).toBe(1)
    expect(markSent).toHaveBeenCalledWith(1)
  })

  it('만료된 항목은 보내지 않고 dead 처리한다', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    const expired = pending({ expiresAt: new Date(NOW.getTime() - 1_000) })
    const { deps: d, markDead } = deps([expired], send)

    const stats = await runDispatch(d, NOW)
    expect(send).not.toHaveBeenCalled()
    expect(stats.expired).toBe(1)
    expect(markDead).toHaveBeenCalledWith(1, 'expired')
  })

  it('실패하면 백오프를 적용해 재시도를 예약한다', async () => {
    const send = vi.fn(async () => ({ ok: false as const, retryAfterMs: null, error: 'boom' }))
    const { deps: d, markFailed } = deps([pending()], send)

    await runDispatch(d, NOW)
    expect(markFailed).toHaveBeenCalledWith(1, 'boom', new Date(NOW.getTime() + 5_000))
  })

  it('429는 retry_after를 그대로 존중한다', async () => {
    const send = vi.fn(async () => ({ ok: false as const, retryAfterMs: 7_000, error: '429' }))
    const { deps: d, markFailed } = deps([pending()], send)

    await runDispatch(d, NOW)
    expect(markFailed).toHaveBeenCalledWith(1, '429', new Date(NOW.getTime() + 7_000))
  })

  it('최대 시도를 소진하면 dead 처리한다', async () => {
    const send = vi.fn(async () => ({ ok: false as const, retryAfterMs: null, error: 'boom' }))
    const { deps: d, markDead } = deps([pending({ attempts: 4 })], send)

    await runDispatch(d, NOW)
    expect(markDead).toHaveBeenCalledWith(1, 'boom')
  })

  it('critical은 병합하지 않고 개별 발송한다', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    const items = [pending({ id: 1 }), pending({ id: 2 }), pending({ id: 3 })]
    const { deps: d } = deps(items, send)

    await runDispatch(d, NOW)
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('non-critical이 임계 이상이면 한 메시지로 병합한다', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    const items = [
      pending({ id: 1, tier: 'high' }),
      pending({ id: 2, tier: 'high' }),
      pending({ id: 3, tier: 'normal' }),
    ]
    const { deps: d, markSent } = deps(items, send)

    const stats = await runDispatch(d, NOW)
    expect(send).toHaveBeenCalledTimes(1)
    expect(String(send.mock.calls[0]![0])).toContain('공시 3건')
    expect(stats.sent).toBe(3)
    expect(markSent).toHaveBeenCalledTimes(3)
  })
})
```

- [ ] **Step 4: 테스트 실패 확인**

Run: `pnpm --filter @app/worker test retry dispatch`
Expected: FAIL — dispatch 모듈 없음

- [ ] **Step 5: 구현**

`apps/worker/src/pipeline/dispatch.ts`:
```ts
import { formatEvent, formatMerged } from '../core/format.js'
import { MERGE_THRESHOLD } from '../core/policy.js'
import { MAX_ATTEMPTS, nextAttemptAt } from '../core/retry.js'
import type { Notifier } from '../ports/notifier.js'
import type { EventStore, PendingOutbox } from '../ports/store.js'
import type { Summarizer } from '../ports/summarizer.js'

export type DispatchDeps = {
  store: EventStore
  notifier: Notifier
  summarizer: Summarizer
}

export type DispatchStats = { sent: number; failed: number; dead: number; expired: number }

const CLAIM_LIMIT = 20

export async function runDispatch(deps: DispatchDeps, now: Date): Promise<DispatchStats> {
  const stats: DispatchStats = { sent: 0, failed: 0, dead: 0, expired: 0 }
  const claimed = await deps.store.claimPending(now, CLAIM_LIMIT)
  if (claimed.length === 0) return stats

  // 만료 먼저 걷어낸다 — 늦은 알림은 보내지 않는다
  const live: PendingOutbox[] = []
  for (const item of claimed) {
    if (item.expiresAt.getTime() <= now.getTime()) {
      await deps.store.markDead(item.id, 'expired')
      stats.expired += 1
    } else {
      live.push(item)
    }
  }

  const criticals = live.filter((i) => i.tier === 'critical')
  const others = live.filter((i) => i.tier !== 'critical')

  // critical — 속도가 목적이므로 병합하지 않는다
  for (const item of criticals) {
    await sendOne(deps, item, formatEvent(item.event, item.tier), now, stats)
  }

  // 그 외 — 임계 이상이면 한 메시지로 묶어 rate limit 압박을 줄인다
  if (others.length >= MERGE_THRESHOLD) {
    const text = formatMerged(others.map((i) => ({ event: i.event, tier: i.tier })))
    const res = await deps.notifier.send(text)
    for (const item of others) await applyResult(deps, item, res, now, stats)
  } else {
    for (const item of others) {
      const summary = await deps.summarizer.summarize(item.event)
      const text = formatEvent(item.event, item.tier, summary ?? undefined)
      await sendOne(deps, item, text, now, stats)
    }
  }

  return stats
}

async function sendOne(
  deps: DispatchDeps, item: PendingOutbox, text: string, now: Date, stats: DispatchStats,
): Promise<void> {
  const res = await deps.notifier.send(text)
  await applyResult(deps, item, res, now, stats)
}

async function applyResult(
  deps: DispatchDeps,
  item: PendingOutbox,
  res: Awaited<ReturnType<Notifier['send']>>,
  now: Date,
  stats: DispatchStats,
): Promise<void> {
  if (res.ok) {
    await deps.store.markSent(item.id)
    stats.sent += 1
    return
  }

  const attempts = item.attempts + 1
  if (attempts >= MAX_ATTEMPTS) {
    await deps.store.markDead(item.id, res.error)
    stats.dead += 1
    return
  }

  // 429의 retry_after는 추측하지 않고 그대로 따른다
  const next = res.retryAfterMs !== null
    ? new Date(now.getTime() + res.retryAfterMs)
    : nextAttemptAt(item.attempts, now)

  await deps.store.markFailed(item.id, res.error, next)
  stats.failed += 1
}
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `pnpm --filter @app/worker test retry dispatch`
Expected: PASS (17 tests)

- [ ] **Step 7: 커밋**

```bash
git add -A
git commit -m "feat(pipeline): 발송 파이프라인 — 백오프 재시도·TTL 만료·병합 발송"
```

---

### Task 14: 자가치유 (서킷 브레이커 · heartbeat)

**Files:**
- Create: `apps/worker/src/core/circuit.ts`
- Create: `apps/worker/src/pipeline/health.ts`
- Test: `apps/worker/src/core/circuit.test.ts`
- Test: `apps/worker/src/pipeline/health.test.ts`

**Interfaces:**
- Consumes: 없음 (순수 로직 + fetch)
- Produces: `createCircuit(opts): Circuit` (`recordSuccess()`, `recordFailure()`, `intervalMultiplier()`, `consecutiveFailures()`); `createHeartbeat(cfg): Heartbeat` (`ping(): Promise<void>`)

- [ ] **Step 1: 서킷 브레이커 테스트 작성**

`apps/worker/src/core/circuit.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { createCircuit, ALERT_THRESHOLD } from './circuit.js'

describe('createCircuit — 안 되는 API를 계속 두드려 예산을 태우지 않는다', () => {
  it('성공 상태에서는 배수가 1이다', () => {
    const c = createCircuit()
    c.recordSuccess()
    expect(c.intervalMultiplier()).toBe(1)
  })

  it('연속 실패가 늘수록 주기를 늘린다', () => {
    const c = createCircuit()
    c.recordFailure()
    expect(c.intervalMultiplier()).toBe(2)
    c.recordFailure()
    expect(c.intervalMultiplier()).toBe(4)
    c.recordFailure()
    expect(c.intervalMultiplier()).toBe(8)
  })

  it('배수에는 상한이 있다', () => {
    const c = createCircuit()
    for (let i = 0; i < 20; i += 1) c.recordFailure()
    expect(c.intervalMultiplier()).toBe(32)
  })

  it('성공하면 즉시 회복된다', () => {
    const c = createCircuit()
    c.recordFailure(); c.recordFailure()
    c.recordSuccess()
    expect(c.intervalMultiplier()).toBe(1)
    expect(c.consecutiveFailures()).toBe(0)
  })

  it('연속 실패 수를 노출한다 — 알림 판단에 쓴다', () => {
    const c = createCircuit()
    c.recordFailure(); c.recordFailure()
    expect(c.consecutiveFailures()).toBe(2)
  })

  it('알림 임계는 5회다', () => expect(ALERT_THRESHOLD).toBe(5))
})
```

- [ ] **Step 2: 서킷 브레이커 구현**

`apps/worker/src/core/circuit.ts`:
```ts
/** 연속 실패가 이 횟수를 넘으면 운영자에게 알린다. */
export const ALERT_THRESHOLD = 5

const MAX_MULTIPLIER = 32

export type Circuit = {
  recordSuccess(): void
  recordFailure(): void
  intervalMultiplier(): number
  consecutiveFailures(): number
}

export function createCircuit(): Circuit {
  let failures = 0
  return {
    recordSuccess() { failures = 0 },
    recordFailure() { failures += 1 },
    consecutiveFailures() { return failures },
    intervalMultiplier() {
      if (failures === 0) return 1
      return Math.min(2 ** failures, MAX_MULTIPLIER)
    },
  }
}
```

- [ ] **Step 3: heartbeat 테스트 작성**

`apps/worker/src/pipeline/health.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { createHeartbeat } from './health.js'

describe('createHeartbeat — VM이 통째로 죽는 경우를 잡는 유일한 수단', () => {
  it('설정된 URL로 핑을 보낸다', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch
    const hb = createHeartbeat({ url: 'https://hc.test/abc', fetchImpl })

    await hb.ping()
    expect((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0])
      .toBe('https://hc.test/abc')
  })

  it('URL이 없으면 아무것도 하지 않는다 — 로컬 개발에서 방해되면 안 된다', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const hb = createHeartbeat({ url: null, fetchImpl })

    await hb.ping()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('핑 실패가 워커를 죽이지 않는다', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('down') }) as unknown as typeof fetch
    const hb = createHeartbeat({ url: 'https://hc.test/abc', fetchImpl })

    await expect(hb.ping()).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 4: 테스트 실패 확인**

Run: `pnpm --filter @app/worker test circuit health`
Expected: FAIL — health 모듈 없음

- [ ] **Step 5: heartbeat 구현**

`apps/worker/src/pipeline/health.ts`:
```ts
export type Heartbeat = { ping(): Promise<void> }

export type HeartbeatConfig = {
  url: string | null
  fetchImpl?: typeof fetch
}

/**
 * 외부 감시 서비스에 생존 신호를 보낸다.
 * 반드시 워커 외부의 서비스를 가리켜야 한다 — 같은 VM에 두면 VM이 죽을 때 감시도 같이 죽는다.
 */
export function createHeartbeat(cfg: HeartbeatConfig): Heartbeat {
  const doFetch = cfg.fetchImpl ?? fetch
  return {
    async ping(): Promise<void> {
      if (!cfg.url) return
      try {
        await doFetch(cfg.url)
      } catch {
        // 감시 서비스 장애가 워커를 멈추게 해서는 안 된다
      }
    },
  }
}
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `pnpm --filter @app/worker test circuit health`
Expected: PASS (9 tests)

- [ ] **Step 7: 커밋**

```bash
git add -A
git commit -m "feat: 서킷 브레이커와 외부 heartbeat"
```

---

### Task 15: 일일 다이제스트

**Files:**
- Modify: `apps/worker/src/ports/store.ts` (메서드 추가)
- Modify: `apps/worker/src/adapters/store/postgres.ts` (구현 추가)
- Create: `apps/worker/src/core/digest.ts`
- Create: `apps/worker/src/pipeline/digest.ts`
- Test: `apps/worker/src/core/digest.test.ts`

**Interfaces:**
- Consumes: `EventStore` (Task 7), `Notifier` (Task 7), `escapeMarkdownV2` (Task 6), `DAILY_LIMIT` (Task 9)
- Produces: `DigestData` 타입, `formatDigest(data): string`, `runDigest(deps, kstDate): Promise<void>`; `EventStore.digestFor(kstDate): Promise<DigestData>`

**핵심:** 발송된 것만 보면 `pass`만 보이고 **놓친 공시는 영원히 보이지 않는다.** 초기 룰셋의 가장 흔한 실패는 과필터링이므로, `no-keyword-match`로 버려진 상장사 공시를 매일 확인할 수 있어야 한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/worker/src/core/digest.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { formatDigest, type DigestData } from './digest.js'

const data: DigestData = {
  kstDate: '2026-09-19',
  sent: { critical: 4, high: 12, normal: 8 },
  dead: 1,
  apiCalls: 8_432,
  missedCandidates: [
    { title: '주주명부폐쇄기간또는기준일설정', corpName: '샘플_전자', ticker: '005930' },
    { title: '특허권취득', corpName: '샘플바이오', ticker: '123456' },
  ],
  errorCounts: { 'dart-timeout': 3, 'telegram-429': 1 },
}

describe('formatDigest', () => {
  it('티어별 발송 건수를 담는다', () => {
    const s = formatDigest(data)
    expect(s).toContain('critical 4')
    expect(s).toContain('high 12')
    expect(s).toContain('normal 8')
  })

  it('API 사용량을 한도와 함께 보여준다', () => {
    expect(formatDigest(data)).toContain('8432 / 20000')
  })

  it('과필터링 후보를 나열한다 — 룰 튜닝의 유일한 단서', () => {
    const s = formatDigest(data)
    expect(s).toContain('미매칭 2건')
    expect(s).toContain('주주명부폐쇄기간또는기준일설정')
  })

  it('회사명의 마크다운 예약문자를 이스케이프한다', () => {
    expect(formatDigest(data)).toContain('샘플\\_전자')
  })

  it('에러 집계를 담는다', () => {
    const s = formatDigest(data)
    expect(s).toContain('dart\\-timeout')
    expect(s).toContain('3')
  })

  it('미매칭이 없으면 그 사실을 표시한다', () => {
    const s = formatDigest({ ...data, missedCandidates: [] })
    expect(s).toContain('미매칭 0건')
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm --filter @app/worker test digest`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 포맷 구현**

`apps/worker/src/core/digest.ts`:
```ts
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
    `미매칭 ${d.missedCandidates.length}건 \\(룰 튜닝 후보\\)`,
    missed,
  ].join('\n')
}
```

- [ ] **Step 4: 스토어 포트에 집계 메서드 추가**

`apps/worker/src/ports/store.ts`의 `EventStore` 타입에 추가:
```ts
  /** 일일 다이제스트용 집계. kstDate는 YYYY-MM-DD. */
  digestFor(kstDate: string): Promise<{
    sent: { critical: number; high: number; normal: number }
    dead: number
    missedCandidates: Array<{ title: string; corpName: string | null; ticker: string | null }>
  }>
```

파일 상단 import에 추가할 것은 없다 (기존 타입만 사용).

- [ ] **Step 5: Postgres 구현 추가**

`apps/worker/src/adapters/store/postgres.ts`의 반환 객체에 추가:
```ts
    async digestFor(kstDate) {
      const dayStart = new Date(`${kstDate}T00:00:00+09:00`)
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60_000)

      const sentRows = await db.select({ tier: outbox.tier, n: sql<number>`count(*)::int` })
        .from(outbox)
        .innerJoin(events, eq(outbox.eventId, events.id))
        .where(and(
          eq(outbox.status, 'sent'),
          gte(events.firstSeenAt, dayStart),
          lt(events.firstSeenAt, dayEnd),
        ))
        .groupBy(outbox.tier)

      const sent = { critical: 0, high: 0, normal: 0 }
      for (const r of sentRows) {
        if (r.tier === 'critical' || r.tier === 'high' || r.tier === 'normal') sent[r.tier] = r.n
      }

      const deadRows = await db.select({ n: sql<number>`count(*)::int` })
        .from(outbox)
        .innerJoin(events, eq(outbox.eventId, events.id))
        .where(and(
          eq(outbox.status, 'dead'),
          gte(events.firstSeenAt, dayStart),
          lt(events.firstSeenAt, dayEnd),
        ))

      const missed = await db.select({
        title: events.title, corpName: events.corpName, ticker: events.ticker,
      }).from(events).where(and(
        eq(events.verdict, 'drop'),
        eq(events.rule, 'no-keyword-match'),
        gte(events.firstSeenAt, dayStart),
        lt(events.firstSeenAt, dayEnd),
      )).limit(50)

      return { sent, dead: deadRows[0]?.n ?? 0, missedCandidates: missed }
    },
```

import 문에 `gte`, `lt` 추가:
```ts
import { and, asc, eq, gte, lt, lte, sql } from 'drizzle-orm'
```

- [ ] **Step 6: 다이제스트 파이프라인 작성**

`apps/worker/src/pipeline/digest.ts`:
```ts
import { formatDigest } from '../core/digest.js'
import type { Notifier } from '../ports/notifier.js'
import type { EventStore } from '../ports/store.js'

export type DigestDeps = {
  store: EventStore
  notifier: Notifier
  sourceId: string
}

export async function runDigest(deps: DigestDeps, kstDate: string): Promise<void> {
  const agg = await deps.store.digestFor(kstDate)
  const apiCalls = await deps.store.getApiUsage(deps.sourceId, kstDate)

  await deps.notifier.send(formatDigest({
    kstDate,
    sent: agg.sent,
    dead: agg.dead,
    apiCalls,
    missedCandidates: agg.missedCandidates,
    errorCounts: {},
  }))
}
```

- [ ] **Step 7: 테스트 통과 확인**

Run: `pnpm --filter @app/worker test digest && pnpm --filter @app/worker typecheck`
Expected: PASS (6 tests), 타입 오류 없음

- [ ] **Step 8: 커밋**

```bash
git add -A
git commit -m "feat: 일일 다이제스트 — 과필터링 후보 노출"
```

---

### Task 16: 메인 루프 조립

**Files:**
- Create: `apps/worker/src/config.ts`
- Create: `apps/worker/src/main.ts`
- Create: `apps/worker/.env.example`
- Test: `apps/worker/src/config.test.ts`

**Interfaces:**
- Consumes: 앞선 모든 태스크
- Produces: `loadConfig(env): Config`, `main()`

- [ ] **Step 1: 설정 테스트 작성**

`apps/worker/src/config.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { loadConfig } from './config.js'

const valid = {
  DATABASE_URL: 'postgres://localhost/app',
  DART_API_KEY: 'k'.repeat(40),
  TELEGRAM_BOT_TOKEN: 't',
  TELEGRAM_CHAT_ID: '-100',
  LLM_API_KEY: 'l',
}

describe('loadConfig', () => {
  it('필수 값이 모두 있으면 파싱한다', () => {
    const c = loadConfig(valid)
    expect(c.dartApiKey).toBe('k'.repeat(40))
    expect(c.telegram.chatId).toBe('-100')
  })

  it('필수 값이 빠지면 어떤 키인지 알려주며 던진다', () => {
    const { DART_API_KEY, ...rest } = valid
    expect(() => loadConfig(rest)).toThrow(/DART_API_KEY/)
  })

  it('DART 키는 40자여야 한다', () => {
    expect(() => loadConfig({ ...valid, DART_API_KEY: 'short' })).toThrow(/DART_API_KEY/)
  })

  it('heartbeat URL은 선택이며 없으면 null이다', () => {
    expect(loadConfig(valid).heartbeatUrl).toBeNull()
  })

  it('heartbeat URL이 있으면 담는다', () => {
    expect(loadConfig({ ...valid, HEARTBEAT_URL: 'https://hc.test/x' }).heartbeatUrl)
      .toBe('https://hc.test/x')
  })
})
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm --filter @app/worker test config`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: 설정 구현**

`apps/worker/src/config.ts`:
```ts
import { z } from 'zod'

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DART_API_KEY: z.string().length(40, 'DART_API_KEY는 40자여야 합니다'),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().min(1),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  LLM_ENDPOINT: z.string().default('https://api.anthropic.com/v1/messages'),
  HEARTBEAT_URL: z.string().optional(),
})

export type Config = {
  databaseUrl: string
  dartApiKey: string
  telegram: { token: string; chatId: string }
  llm: { apiKey: string; model: string; endpoint: string }
  heartbeatUrl: string | null
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = envSchema.parse(env)
  return {
    databaseUrl: parsed.DATABASE_URL,
    dartApiKey: parsed.DART_API_KEY,
    telegram: { token: parsed.TELEGRAM_BOT_TOKEN, chatId: parsed.TELEGRAM_CHAT_ID },
    llm: { apiKey: parsed.LLM_API_KEY, model: parsed.LLM_MODEL, endpoint: parsed.LLM_ENDPOINT },
    heartbeatUrl: parsed.HEARTBEAT_URL ?? null,
  }
}
```

`apps/worker/.env.example`:
```
DATABASE_URL=postgres://user:pass@host:5432/db
DART_API_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
LLM_API_KEY=
HEARTBEAT_URL=
```

- [ ] **Step 4: 메인 루프 구현**

```bash
pnpm --filter @app/worker add pino
```

`apps/worker/src/main.ts`:
```ts
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import pino from 'pino'
import { budgetGuard, kstDateString } from './core/budget.js'
import { ALERT_THRESHOLD, createCircuit } from './core/circuit.js'
import { pollIntervalMs } from './core/schedule.js'
import { loadConfig } from './config.js'
import { createDartSource } from './adapters/sources/dart.js'
import { createPostgresStore, type Db } from './adapters/store/postgres.js'
import { createTelegramNotifier } from './adapters/notifier/telegram.js'
import { createLlmSummarizer } from './adapters/summarizer/llm.js'
import { runIngest } from './pipeline/ingest.js'
import { runDispatch } from './pipeline/dispatch.js'
import { runDigest } from './pipeline/digest.js'
import { createHeartbeat } from './pipeline/health.js'

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' })

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const cfg = loadConfig(process.env)

  const sql = postgres(cfg.databaseUrl)
  const db = drizzle(sql) as unknown as Db
  const store = createPostgresStore(db)
  const source = createDartSource({ apiKey: cfg.dartApiKey })
  const notifier = createTelegramNotifier(cfg.telegram)
  const summarizer = createLlmSummarizer(cfg.llm)
  const heartbeat = createHeartbeat({ url: cfg.heartbeatUrl })
  const circuit = createCircuit()

  let lastDigestDate = kstDateString(new Date())
  log.info('worker started')

  for (;;) {
    const now = new Date()
    const kstDate = kstDateString(now)

    try {
      const used = await store.incrementApiUsage(source.id, kstDate)
      const ingest = await runIngest({ source, store }, now)
      const dispatch = await runDispatch({ store, notifier, summarizer }, now)

      circuit.recordSuccess()
      if (ingest.recorded > 0 || dispatch.sent > 0) {
        log.info({ ingest, dispatch, used }, 'cycle')
      }

      // 자정이 지나면 전날 다이제스트를 보낸다
      if (kstDate !== lastDigestDate) {
        await runDigest({ store, notifier, sourceId: source.id }, lastDigestDate)
        lastDigestDate = kstDate
      }

      await heartbeat.ping()

      const base = budgetGuard(used, pollIntervalMs(now))
      await sleep(base)
    } catch (err) {
      circuit.recordFailure()
      const failures = circuit.consecutiveFailures()
      log.error({ err, failures }, 'cycle failed')

      if (failures === ALERT_THRESHOLD) {
        await notifier.send(`⚠️ 워커 연속 실패 ${failures}회`).catch(() => {})
      }

      await sleep(pollIntervalMs(new Date()) * circuit.intervalMultiplier())
    }
  }
}

// crash-only: 예외를 삼키고 도는 것보다 죽고 재시작하는 편이 안전하다
process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'uncaught exception — exiting')
  process.exit(1)
})
process.on('unhandledRejection', (err) => {
  log.fatal({ err }, 'unhandled rejection — exiting')
  process.exit(1)
})

main().catch((err) => {
  log.fatal({ err }, 'startup failed')
  process.exit(1)
})
```

- [ ] **Step 5: 전체 테스트와 타입체크 통과 확인**

Run: `pnpm test && pnpm typecheck`
Expected: 전부 PASS

- [ ] **Step 6: 커밋**

```bash
git add -A
git commit -m "feat: 설정 로더와 메인 루프 조립"
```

---

### Task 17: Docker 이미지와 배포 문서

**Files:**
- Create: `apps/worker/Dockerfile`
- Create: `apps/worker/.dockerignore`
- Create: `docs/deploy-oci.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 16의 `main.ts`
- Produces: 실행 가능한 Docker 이미지, OCI 배포 절차 문서

- [ ] **Step 1: Dockerfile 작성**

`apps/worker/Dockerfile` (레포 루트를 빌드 컨텍스트로 사용):
```dockerfile
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/worker apps/worker
RUN pnpm --filter @app/worker exec tsc -p tsconfig.json

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/
USER node
CMD ["node", "apps/worker/dist/main.js"]
```

`apps/worker/.dockerignore`:
```
node_modules
dist
.env
*.log
```

- [ ] **Step 2: 로컬 빌드 확인**

Run: `docker build -f apps/worker/Dockerfile -t dart-worker .`
Expected: 빌드 성공

- [ ] **Step 3: 배포 문서 작성**

`docs/deploy-oci.md`:
```markdown
# OCI 배포 절차

## 1. 계정 준비

**PAYG(종량제)로 업그레이드한다.** Always Free 계정의 유휴 인스턴스는 회수 대상이며,
저부하 폴링 워커는 정확히 그 프로필에 해당한다. PAYG 전환 후에도 Always Free 한도
안에서만 쓰면 청구액은 $0이다.

## 2. 인스턴스

- 이미지: Ubuntu 22.04 LTS
- Shape: `VM.Standard.E2.1.Micro` (Always Free, 1GB)
  - ARM(Ampere A1)은 용량 부족이 상습적이므로 기다리지 않는다. 나중에 잡히면 이전한다.
- 인바운드 포트: **SSH(22)만 연다.** 워커는 전부 아웃바운드라 다른 포트가 필요 없다.

## 3. Docker 설치와 실행

```bash
sudo apt-get update && sudo apt-get install -y docker.io
sudo usermod -aG docker "$USER" && newgrp docker

docker run -d --name dart-worker \
  --restart always \
  --env-file /home/ubuntu/worker.env \
  dart-worker
```

`--restart always`가 crash-only 설계의 한쪽 축이다. 프로세스가 죽으면 Docker가 되살린다.

## 4. 외부 감시 (필수)

Healthchecks.io 류에서 ping URL을 발급받아 `HEARTBEAT_URL`에 넣는다.
**반드시 OCI 외부 서비스여야 한다** — 같은 VM에 두면 VM이 죽을 때 감시도 같이 죽는다.

주기는 폴링 주기보다 넉넉히 잡는다 (예: grace period 10분).

## 5. 로그 확인

```bash
docker logs -f --tail 100 dart-worker
```
```

- [ ] **Step 4: README 작성**

`README.md`:
```markdown
# 실시간 공시 알림 워커

DART 전자공시를 장중 2.5초 주기로 폴링해 주가 영향이 큰 공시만 선별·요약하여
텔레그램으로 전달하는 상주 워커.

- 설계: [`docs/superpowers/specs/2026-09-19-realtime-disclosure-alert-design.md`](docs/superpowers/specs/2026-09-19-realtime-disclosure-alert-design.md)
- 구현 계획: [`docs/superpowers/plans/2026-09-19-dart-alert-worker.md`](docs/superpowers/plans/2026-09-19-dart-alert-worker.md)
- 배포: [`docs/deploy-oci.md`](docs/deploy-oci.md)

## 개발

```bash
pnpm install
pnpm test
pnpm typecheck
```

## 고지

본 서비스는 정보 제공 목적이며 투자 권유가 아닙니다.
호재/악재 판단, 목표가, 매매 의견을 생성하지 않습니다.
```

- [ ] **Step 5: 커밋**

```bash
git add -A
git commit -m "feat: Docker 이미지와 OCI 배포 문서"
```

---

## 실행 후 할 일 (코드 밖 작업)

계획 실행이 끝나면 다음을 수동으로 진행한다. 이것들은 코드가 아니라 운영 절차다.

1. **OpenDART 인증키 발급** — https://opendart.fss.or.kr 회원가입 후 발급 (40자)
2. **텔레그램 봇 생성** — @BotFather에서 봇 생성 → 비공개 채널 개설 → 봇을 관리자로 추가 → chat_id 확인
3. **Supabase 프로젝트 생성** — 서울 리전(ap-northeast-2) 선택, `DATABASE_URL` 확보
4. **마이그레이션 적용** — `pnpm --filter @app/worker exec drizzle-kit migrate`
5. **비공개 채널 단계 시작** — 최소 1주 운영하며 스펙 §14의 미확인 항목을 실측한다:
   - DART 접수 → API 노출 지연
   - 텔레그램 rate limit 실제 수치
   - LLM 건당 실제 비용
6. **키워드 커버리지 보강 (Task 4 리뷰에서 제기된 갭)** — 다이제스트의 `no-keyword-match` 목록에서 아래 유형의 **실제 `report_nm` 문자열을 정확히 확인해** `CRITICAL_KEYWORDS`/`HIGH_KEYWORDS`에 추가한다. 추측으로 미리 넣지 않는 이유는, 실제 제목과 한 글자라도 다르면 매칭되지 않는 죽은 문자열이 되어 "커버된 것처럼 보이는" 더 위험한 상태가 되기 때문이다.
   - **취득/처분 비대칭 해소**: 현재 목록은 `자기주식취득결정`·`타법인주식및출자증권취득결정`만 잡고 **처분·소각 쪽을 전부 놓친다**. `자기주식처분결정`, `자기주식소각결정`, `타법인주식및출자증권처분결정` 계열 확인 필요. (자사주 소각은 강한 주가 재료다.)
   - 그 외 후보: `유형자산 양수/양도 결정`, `소송 등의 제기` 계열
7. **골든셋 구축** — 수집된 실제 공시에서 대표 100건을 `golden.json`으로 고정하고 회귀 테스트를 추가한다
8. **공개 채널 전환** — 룰이 납득되고 rate limit 대응이 검증된 뒤에만
