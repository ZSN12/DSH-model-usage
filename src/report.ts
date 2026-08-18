/**
 * 模型用量 (Model Usage) — shared wire contracts.
 *
 * Pure type/value constants with zero runtime dependencies: safe to import
 * from both the Host half (index.ts) and the browser half (client/*). Keeping
 * the report shape here prevents the client bundle from pulling the host's
 * Node.js imports into the browser.
 */

/** 单价表(美元 / 百万 token),按模型名关键词匹配;仅供成本估算。 */
export const PRICE_IN: Record<string, number> = { deepseek: 0.27, 'gpt-4o': 2.5, 'gpt-4.1': 2.0, 'gpt-5': 1.25, 'gpt-5-mini': 0.25, claude: 3.0, gemini: 1.25, qwen: 0.4, glm: 0.8, kimi: 2.0, moonshot: 2.0, o1: 15.0, sonnet: 3.0, haiku: 1.0, opus: 15.0 }
export const PRICE_OUT: Record<string, number> = { deepseek: 1.1, 'gpt-4o': 10.0, 'gpt-4.1': 8.0, 'gpt-5': 10.0, 'gpt-5-mini': 1.2, claude: 15.0, gemini: 5.0, qwen: 1.2, glm: 2.0, kimi: 8.0, moonshot: 8.0, o1: 60.0, sonnet: 15.0, haiku: 5.0, opus: 75.0 }
export const DEF_IN = 1.0
export const DEF_OUT = 5.0

/** One recorded call. */
export interface UsageRecord {
  ts: number
  provider: string
  model: string
  inp: number
  out: number
  cr: number
  cw: number
  rsn: number
  dur: number
}

/** Per-model aggregate row. */
export interface ModelRow {
  provider: string
  model: string
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  firstAt: number
  lastAt: number
  peakTokens: number
  maxDur: number
  totalTokens: number
}

/** Daily token buckets, keyed `YYYY-MM-DD`. */
export type DailyMap = Record<string, { tokens: number; calls: number }>

/** Full report served to the browser half. */
export interface UsageReport {
  rows: ModelRow[]
  totals: {
    calls: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    reasoningTokens: number
  }
  daily: DailyMap
  summary: {
    totalTokens: number
    peakTokens: number
    maxDur: number
    currentStreak: number
    maxStreak: number
    requests: number
    costUsd: number
    cacheHitRate: number
    cacheReadTokens: number
    reasoningTokens: number
  }
  debug: { appliedAt: number; streamHits: number; usageHits: number; recorded: number; heap: number }
}