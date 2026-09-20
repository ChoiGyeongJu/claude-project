import { z } from 'zod'

const DART_DAILY_LIMIT_MSG = 'DART_DAILY_LIMIT는 양의 정수여야 합니다'

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DART_API_KEY: z.string().length(40, 'DART_API_KEY는 40자여야 합니다'),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().min(1),
  TELEGRAM_OPERATOR_CHAT_ID: z.string().min(1).optional(),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  LLM_ENDPOINT: z.string().default('https://api.anthropic.com/v1/messages'),
  HEARTBEAT_URL: z.string().optional(),
  // OpenDART 문서상 기본 한도는 계정당 20,000건/일이지만, 발급받은 한도가 이와
  // 다른 계정도 있다(OpenDART 에러 문서: "요청 제한이 다르게 설정된 경우에는
  // 이에 준하여 발생됩니다"). 기본값은 문서상 한도로 두고, 다르게 발급받은
  // 계정만 이 값을 채우면 된다.
  DART_DAILY_LIMIT: z.coerce
    .number({ error: DART_DAILY_LIMIT_MSG })
    .int(DART_DAILY_LIMIT_MSG)
    .positive(DART_DAILY_LIMIT_MSG)
    .default(20_000),
})

export type Config = {
  databaseUrl: string
  dartApiKey: string
  telegram: { token: string; chatId: string }
  /**
   * 설정되면 운영자 전용 채널. 일일 다이제스트(버려진 공시 목록·내부 카운터)와
   * 연속 실패 알림이 이쪽으로만 간다. 없으면 기존처럼 메인 채널로 간다 —
   * 비공개 채널 단계에서는 구독자가 운영자뿐이라 구분할 이유가 없기 때문이다.
   * 공개 전환 시 반드시 설정해야 한다.
   */
  operatorChatId: string | null
  llm: { apiKey: string; model: string; endpoint: string }
  heartbeatUrl: string | null
  /** 계정에 발급된 일일 호출 한도. 미설정 시 OpenDART 문서상 기본값(20,000). */
  dartDailyLimit: number
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = envSchema.parse(env)
  return {
    databaseUrl: parsed.DATABASE_URL,
    dartApiKey: parsed.DART_API_KEY,
    telegram: { token: parsed.TELEGRAM_BOT_TOKEN, chatId: parsed.TELEGRAM_CHAT_ID },
    operatorChatId: parsed.TELEGRAM_OPERATOR_CHAT_ID ?? null,
    llm: { apiKey: parsed.LLM_API_KEY, model: parsed.LLM_MODEL, endpoint: parsed.LLM_ENDPOINT },
    heartbeatUrl: parsed.HEARTBEAT_URL ?? null,
    dartDailyLimit: parsed.DART_DAILY_LIMIT,
  }
}
