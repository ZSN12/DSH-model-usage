/**
 * 模型用量 (Model Usage) — Host half.
 *
 * Wraps the `llm/stream` waterfall to collect per-call token usage, persists
 * every completed call to `~/.dsh/storages/model-usage.jsonl` (append-only,
 * replayed on boot so statistics survive restarts), and serves aggregates to
 * the browser half over two HTTP endpoints registered on the webServer
 * service (`/api/model-usage`, `/api/model-usage/reset`).
 *
 * This is a composition (static) plugin: `apply(ctx)` receives the real
 * Cordis context. Services are reached through `ctx.inject([...], cb)` —
 * a synchronous `ctx.get()` at apply time is undefined until the service
 * activates — and stream events through `ctx.on('llm/stream', ...)`.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
// Pulls the `Context.webServer` augmentation from the host webserver package.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { DEF_PRICE, PRICES, peakHour, type DailyMap, type ModelPrice, type ModelRow, type UsageRecord, type UsageReport } from './report.ts'

const STORE_DIR = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, 'storages')
  : join(homedir(), '.dsh', 'storages')
const STORE_FILE = join(STORE_DIR, 'model-usage.jsonl')
const MAX_CALLS = 50_000

/** Resolve the price entry for a model (longest key wins to keep exact matches). */
function priceFor(model: string): ModelPrice {
  const m = String(model || '').toLowerCase()
  let best = ''
  for (const k of Object.keys(PRICES)) {
    if (m.includes(k) && k.length > best.length) best = k
  }
  return best ? PRICES[best]! : DEF_PRICE
}

/** Effective price for one call, applying DeepSeek-style peak-hour surcharge. */
function effectivePrice(model: string, ts: number): ModelPrice {
  const p = priceFor(model)
  if (!peakHour(new Date(ts))) return p
  const peak = p.peak
  if (peak === undefined) return p
  return { in: peak.in ?? p.in, out: peak.out ?? p.out, cache: peak.cache ?? p.cache }
}

/** Host plugin registration. */
export function apply(ctx: Context): void {
  const calls: UsageRecord[] = []
  const appliedAt = Date.now()
  let streamHits = 0
  let usageHits = 0
  let recorded = 0

  function loadPersisted(): void {
    try {
      if (!existsSync(STORE_FILE)) return
      const raw = readFileSync(STORE_FILE, 'utf8')
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          calls.push(JSON.parse(line) as UsageRecord)
        } catch {
          // skip malformed line
        }
        if (calls.length >= MAX_CALLS) break
      }
    } catch (error) {
      console.error(`[model-usage] failed to read ${STORE_FILE}: ${String(error)}`)
    }
  }

  function persist(record: UsageRecord): void {
    try {
      mkdirSync(STORE_DIR, { recursive: true })
      writeFileSync(STORE_FILE, JSON.stringify(record) + '\n', { flag: 'a' })
    } catch (error) {
      console.error(`[model-usage] failed to append ${STORE_FILE}: ${String(error)}`)
    }
  }

  loadPersisted()
  recorded = calls.length
  console.log(`[model-usage] replayed ${calls.length} persisted call(s) from ${STORE_FILE}`)

  // ── 采集:llm/stream waterfall ──
  // `next()` returns an AsyncIterable, so this listener must be an async
  // generator consumed with `for await` (a sync `for...of` cannot traverse it).
  ctx.on('llm/stream', async function* (options: { provider?: string; model?: string }, next: () => AsyncIterable<StreamChunk>) {
    streamHits += 1
    const provider = String(options.provider ?? '')
    const model = String(options.model ?? '')
    const upstream = next()
    let captured: StreamChunk & { type: 'usage' } | null = null
    const started = Date.now()
    for await (const chunk of upstream) {
      if (chunk && chunk.type === 'usage' && chunk.usage) {
        captured = chunk as StreamChunk & { type: 'usage' }
        usageHits += 1
      }
      yield chunk
    }
    const usage = captured?.usage
    const record: UsageRecord = {
      ts: started,
      provider,
      model,
      inp: usage?.inputTokens ?? 0,
      out: usage?.outputTokens ?? 0,
      cr: usage?.cacheReadTokens ?? 0,
      cw: usage?.cacheWriteTokens ?? 0,
      rsn: usage?.reasoningTokens ?? 0,
      dur: Date.now() - started,
    }
    calls.push(record)
    recorded += 1
    if (calls.length > MAX_CALLS) calls.splice(0, calls.length - MAX_CALLS)
    persist(record)
  })

  function aggregate(list: readonly UsageRecord[]): { per: Map<string, ModelRow>; daily: DailyMap } {
    const per = new Map<string, ModelRow>()
    const daily: DailyMap = {}
    for (const c of list) {
      const key = c.provider + '/' + c.model
      let r = per.get(key)
      if (!r) {
        r = { provider: c.provider, model: c.model, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, firstAt: c.ts, lastAt: c.ts, peakTokens: 0, maxDur: 0, totalTokens: 0 }
        per.set(key, r)
      }
      r.calls += 1
      r.inputTokens += c.inp
      r.outputTokens += c.out
      r.cacheReadTokens += c.cr
      r.cacheWriteTokens += c.cw
      r.reasoningTokens += c.rsn
      const t = c.inp + c.out + c.cr + c.cw
      r.totalTokens += t
      if (t > r.peakTokens) r.peakTokens = t
      if (c.dur > r.maxDur) r.maxDur = c.dur
      if (c.ts < r.firstAt) r.firstAt = c.ts
      if (c.ts > r.lastAt) r.lastAt = c.ts
      const d = new Date(c.ts)
      const dk = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
      const bucket = daily[dk] ?? (daily[dk] = { tokens: 0, calls: 0 })
      bucket.tokens += t
      bucket.calls += 1
    }
    return { per, daily }
  }

  function streaks(list: readonly UsageRecord[]): { currentStreak: number; maxStreak: number } {
    const set = new Set<number>()
    for (const c of list) set.add(Math.floor(c.ts / 86_400_000))
    if (set.size === 0) return { currentStreak: 0, maxStreak: 0 }
    const sorted = [...set].sort((a, b) => a - b)
    let current = 0
    let cursor = Math.floor(Date.now() / 86_400_000)
    if (!set.has(cursor)) cursor -= 1
    while (set.has(cursor)) { current += 1; cursor -= 1 }
    let max = 0
    let run = 0
    let prev = -1e9
    for (const d of sorted) {
      run = d === prev + 1 ? run + 1 : 1
      if (run > max) max = run
      prev = d
    }
    return { currentStreak: current, maxStreak: max }
  }

  function buildReport(query: Record<string, string>): UsageReport {
    const modelFilter = query.model ? String(query.model) : ''
    // 统计/每日数据基于全部历史(不受时间范围影响);时间窗口(近30/90天、6个月、1年)
    // 只由浏览器端按需截取热力图显示范围。
    void query.days
    // 模型筛选只影响汇总统计;模型列表 rows 永远返回全部模型,
    // 否则前端筛选下拉在选中一项后会丢失其他选项。
    const all = aggregate(calls)
    const rows = [...all.per.values()].sort((a, b) => b.lastAt - a.lastAt)
    const list = modelFilter ? calls.filter((c) => (c.provider + '/' + c.model) === modelFilter) : calls
    const { daily } = modelFilter ? aggregate(list) : all
    // totals 基于当前筛选(list),与 KPI 卡一致;rows 保持全量供下拉使用。
    const listAgg = aggregate(list).per
    const totals = [...listAgg.values()].reduce((acc, r) => {
      acc.calls += r.calls
      acc.inputTokens += r.inputTokens
      acc.outputTokens += r.outputTokens
      acc.cacheReadTokens += r.cacheReadTokens
      acc.cacheWriteTokens += r.cacheWriteTokens
      acc.reasoningTokens += r.reasoningTokens
      return acc
    }, { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 })
    const totalTokens = totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
    const peakTokens = list.reduce((m, c) => Math.max(m, c.inp + c.out + c.cr + c.cw), 0)
    const maxDur = list.reduce((m, c) => Math.max(m, c.dur), 0)
    const st = streaks(list)
    const costUsd = list.reduce((s, c) => {
      const p = effectivePrice(c.model, c.ts)
      return s
        + (c.inp + c.cw) / 1_000_000 * p.in
        + c.cr / 1_000_000 * p.cache
        + c.out / 1_000_000 * p.out
    }, 0)
    const billedIn = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
    const cacheHitRate = billedIn + totals.outputTokens > 0 ? totals.cacheReadTokens / (billedIn + totals.outputTokens) : 0
    return {
      rows,
      totals,
      daily,
      summary: {
        totalTokens,
        peakTokens,
        maxDur,
        currentStreak: st.currentStreak,
        maxStreak: st.maxStreak,
        requests: list.length,
        costUsd,
        cacheHitRate,
        cacheReadTokens: totals.cacheReadTokens,
        reasoningTokens: totals.reasoningTokens,
      },
      debug: { appliedAt, streamHits, usageHits, recorded, heap: calls.length },
    }
  }

  // ── HTTP 端点 ──
  // webServer activates asynchronously; ctx.inject fires the callback when
  // the service is online (a bare ctx.get at apply time is undefined here).
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer
    webServer.register({
      kind: 'exact',
      path: '/api/model-usage',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          const query: Record<string, string> = {}
          url.searchParams.forEach((value, key) => { query[key] = value })
          const body = JSON.stringify(buildReport(query))
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(body)
        } catch (error) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('model-usage error: ' + String(error))
        }
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/api/model-usage/reset',
      handler: async (_req, res) => {
        calls.length = 0
        recorded = 0
        try {
          writeFileSync(STORE_FILE, '', 'utf8')
        } catch (error) {
          console.error(`[model-usage] reset failed: ${String(error)}`)
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true }))
      },
    })
    console.log('[model-usage] HTTP endpoints registered at /api/model-usage')
  })
}
