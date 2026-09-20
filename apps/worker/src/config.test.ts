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

describe('loadConfig — DART_DAILY_LIMIT (계정마다 발급된 한도가 다를 수 있다)', () => {
  it('설정하지 않으면 OpenDART 문서상 기본값(20,000)을 쓴다', () => {
    expect(loadConfig(valid).dartDailyLimit).toBe(20_000)
  })

  it('설정하면 그 값을 숫자로 담는다', () => {
    expect(loadConfig({ ...valid, DART_DAILY_LIMIT: '40000' }).dartDailyLimit).toBe(40_000)
  })

  it('0은 거부한다', () => {
    expect(() => loadConfig({ ...valid, DART_DAILY_LIMIT: '0' })).toThrow(/DART_DAILY_LIMIT/)
  })

  it('음수는 거부한다', () => {
    expect(() => loadConfig({ ...valid, DART_DAILY_LIMIT: '-1' })).toThrow(/DART_DAILY_LIMIT/)
  })

  it('숫자가 아니면 거부한다', () => {
    expect(() => loadConfig({ ...valid, DART_DAILY_LIMIT: 'abc' })).toThrow(/DART_DAILY_LIMIT/)
  })
})

describe('loadConfig — 운영자 채널', () => {
  it('설정하지 않으면 null이다 — 오늘의 동작(단일 채널)이 그대로 유지된다', () => {
    expect(loadConfig(valid).operatorChatId).toBeNull()
  })

  it('설정하면 담는다 — 다이제스트와 장애 알림이 이쪽으로 빠진다', () => {
    expect(loadConfig({ ...valid, TELEGRAM_OPERATOR_CHAT_ID: '-200' }).operatorChatId)
      .toBe('-200')
  })

  it('구독자 채널과 별개의 값이다 — 같은 값으로 합쳐지지 않는다', () => {
    const c = loadConfig({ ...valid, TELEGRAM_OPERATOR_CHAT_ID: '-200' })
    expect(c.telegram.chatId).toBe('-100')
    expect(c.operatorChatId).toBe('-200')
  })

  it('빈 문자열은 거부한다 — 빈 chat_id 로 발송하면 매번 실패한다', () => {
    expect(() => loadConfig({ ...valid, TELEGRAM_OPERATOR_CHAT_ID: '' }))
      .toThrow(/TELEGRAM_OPERATOR_CHAT_ID/)
  })
})
