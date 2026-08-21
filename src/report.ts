/**
 * 模型用量 (Model Usage) — shared wire contracts.
 *
 * Pure type/value constants with zero runtime dependencies: safe to import
 * from both the Host half (index.ts) and the browser half (client/*). Keeping
 * the report shape here prevents the client bundle from pulling the host's
 * Node.js imports into the browser.
 */

/**
 * 单价表(人民币 ¥ / 百万 token),按模型名关键词匹配;仅供成本估算。
 *
 * 汇率:2026-08-19 央行中间价 1 USD = ¥6.7854。
 * 官方来源:
 * - DeepSeek 官方调价(2026-08-17 生效,峰谷计价,高峰 9:00-14:00):V4-Flash
 *   空闲 输入¥1.5/缓存命中¥0.05/输出¥4.5,高峰翻倍;V4-Pro 空闲
 *   输入¥4.5/缓存命中¥0.15/输出¥13.5,高峰翻倍。
 * - Kimi 官方定价(K2.7 Code):输入¥6.5/缓存命中¥1.3/输出¥27。
 * - grok-4.5(mai 中转 standard 档):输入 $0.6/输出 $1.8/缓存读取 $0.15
 *   × 6.7854 ≈ ¥4.07/¥12.21/¥1.02。
 */
export interface ModelPrice {
  /** 输入(缓存未命中),¥/M tokens */
  in: number
  /** 输出,¥/M tokens */
  out: number
  /** 缓存读取(命中),¥/M tokens */
  cache: number
  /** 高峰时段价格(DeepSeek 峰谷计价;未提供则与 `in/out/cache` 相同) */
  peak?: Partial<ModelPrice>
}

export const PRICES: Record<string, ModelPrice> = {
  // DeepSeek V4 系列(2026-08-17 官方峰谷调价)
  'deepseek-v4-pro': { in: 4.5, out: 13.5, cache: 0.15, peak: { in: 9.0, out: 27.0, cache: 0.30 } },
  'deepseek-v4': { in: 1.5, out: 4.5, cache: 0.05, peak: { in: 3.0, out: 9.0, cache: 0.10 } },
  deepseek: { in: 1.5, out: 4.5, cache: 0.05, peak: { in: 3.0, out: 9.0, cache: 0.10 } },
  // Kimi 官方(2026-08 定价表)
  'k3': { in: 20.0, out: 100.0, cache: 2.0 },
  'kimi-k2.7': { in: 6.5, out: 27.0, cache: 1.3 },
  moonshot: { in: 6.5, out: 27.0, cache: 1.3 },
  kimi: { in: 6.5, out: 27.0, cache: 1.3 },
  // grok(mai 中转 standard 档,$×6.7854)
  grok: { in: 4.07, out: 12.21, cache: 1.02 },
  // 其余模型沿用人民币换算后的通用档(汇率 6.7854)
  'gpt-4o': { in: 16.96, out: 67.85, cache: 8.48 },
  'gpt-4.1': { in: 13.57, out: 54.28, cache: 6.79 },
  'gpt-5-mini': { in: 1.7, out: 8.14, cache: 0.85 },
  'gpt-5': { in: 8.48, out: 67.85, cache: 4.24 },
  claude: { in: 20.36, out: 101.78, cache: 10.18 },
  sonnet: { in: 20.36, out: 101.78, cache: 10.18 },
  haiku: { in: 6.79, out: 33.93, cache: 3.39 },
  opus: { in: 101.78, out: 508.91, cache: 50.89 },
  gemini: { in: 8.48, out: 33.93, cache: 4.24 },
  qwen: { in: 2.71, out: 8.14, cache: 1.36 },
  glm: { in: 5.43, out: 13.57, cache: 2.71 },
  o1: { in: 101.78, out: 407.12, cache: 50.89 },
}
export const DEF_PRICE: ModelPrice = { in: 6.79, out: 33.93, cache: 3.39 }

/** DeepSeek 高峰时段(本地时间 9:00-14:00),价格翻倍。 */
export function peakHour(date = new Date()): boolean {
  const h = date.getHours()
  return h >= 9 && h < 14
}

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
  /**
   * 顶部统计栏:全量历史(不受时间范围 days 影响;受模型筛选影响)。
   */
  overview: {
    totalTokens: number
    peakTokens: number
    maxDur: number
    currentStreak: number
    maxStreak: number
  }
  /**
   * 用量明细面板:按所选时间范围(days)与模型筛选计算,与热力图/模型列表一致。
   */
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