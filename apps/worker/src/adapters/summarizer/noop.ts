import type { Summarizer } from '../../ports/summarizer.js'

/** critical 티어는 LLM을 기다리지 않는다. 그 경로에 주입한다. */
export const noopSummarizer: Summarizer = {
  summarize: async () => null,
}
