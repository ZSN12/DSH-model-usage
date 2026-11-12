/**
 * 模型用量 (Model Usage) — Host half.
 *
 * Wraps the `llm/stream` waterfall to collect per-call token usage, persists
 * every completed call to `~/.dsh/storages/model-usage.jsonl` (rolling
 * 50,000-call history, replayed on boot so statistics survive restarts), and serves aggregates to
 * the browser half over two HTTP endpoints registered on the webServer
 * service (`/api/model-usage`, `/api/model-usage/reset`).
 *
 * The Host routes require the current web connection trust fence; route and
 * stream registrations are disposed with this plugin's Cordis fiber.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
const COMPACT_AFTER = 5_000

/** Services this Host half needs before it can register protected routes. */
export const inject = ['webServer', 'connection']

interface ConnectionTrust {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/** The web connection service owns the Host/Origin fence and login-token check. */
function connectionOf(ctx: Context): ConnectionTrust {
  return Reflect.get(ctx, 'connection') as ConnectionTrust
}

function isUsageRecord(value: unknown): value is UsageRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Partial<UsageRecord>
  return Number.isSafeInteger(record.ts) && record.ts! > 0
    && typeof record.provider === 'string'
    && typeof record.model === 'string'
    && [record.inp, record.out, record.cr, record.cw, record.rsn, record.dur]
      .every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)
}

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
  let persistedRecords = 0

  function rewriteStore(): void {
    mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 })
    const contents = calls.length ? calls.map((record) => JSON.stringify(record)).join('\n') + '\n' : ''
    writeFileSync(STORE_FILE, contents, { encoding: 'utf8', mode: 0o600 })
    chmodSync(STORE_FILE, 0o600)
    persistedRecords = calls.length
  }

  function loadPersisted(): void {
    try {
      if (!existsSync(STORE_FILE)) return
      chmodSync(STORE_FILE, 0o600)
      const raw = readFileSync(STORE_FILE, 'utf8')
      const latest: UsageRecord[] = []
      let first = 0
      let validRecords = 0
      let malformedRecords = false
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const value: unknown = JSON.parse(line)
          if (!isUsageRecord(value)) {
            malformedRecords = true
            continue
          }
          validRecords += 1
          if (latest.length < MAX_CALLS) latest.push(value)
          else {
            latest[first] = value
            first = (first + 1) % MAX_CALLS
          }
        } catch {
          // skip malformed line
          malformedRecords = true
        }
      }
      calls.push(...(validRecords > MAX_CALLS ? [...latest.slice(first), ...latest.slice(0, first)] : latest))
      persistedRecords = validRecords
      // Keep the latest window, discard corrupt rows, and prevent the JSONL
      // file from growing beyond the same retention policy as memory.
      if (validRecords > MAX_CALLS || malformedRecords) rewriteStore()
    } catch (error) {
      console.error(`[model-usage] failed to read ${STORE_FILE}: ${String(error)}`)
    }
  }

  function persist(record: UsageRecord): void {
    try {
      mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 })
      appendFileSync(STORE_FILE, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 })
      persistedRecords += 1
      if (persistedRecords > MAX_CALLS + COMPACT_AFTER) rewriteStore()
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

  /** 供前端界面显示,用于确认运行的 host 是否已更新(见 debug.version)。 */
  const HOST_VERSION = '2026-11-12-dsh-0.2-v1'

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
    // 时间窗口:优先绝对起止 start/end(毫秒时间戳,来自前端时间选择器);
    // 否则回退相对 days(近30/90天、6个月、1年)。作用于用量明细(明细 KPI、
    // 模型列表、每日数据),与热力图一致;顶部统计栏 overview 始终为全量历史。
    const startRaw = Number(query.start)
    const endRaw = Number(query.end)
    const hasStart = Number.isFinite(startRaw) && startRaw > 0
    const hasEnd = Number.isFinite(endRaw) && endRaw > 0
    const daysRaw = Number(query.days)
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : 0

    // 全量历史(受模型筛选影响,不受时间窗口影响)——顶部统计栏。
    const fullList = modelFilter ? calls.filter((c) => (c.provider + '/' + c.model) === modelFilter) : calls
    // 窗口内(同时受模型筛选与时间窗口影响)——用量明细面板。
    let list = fullList
    if (hasStart || hasEnd) {
      list = fullList.filter((c) => (hasStart ? c.ts >= startRaw : true) && (hasEnd ? c.ts <= endRaw : true))
    } else if (days > 0) {
      const cutoff = Date.now() - days * 86_400_000
      list = fullList.filter((c) => c.ts >= cutoff)
    }

    const agg = aggregate(list)
    const rows = [...agg.per.values()].sort((a, b) => b.lastAt - a.lastAt)
    // 热力图:使用全量历史(受模型筛选影响,不受明细时间窗口影响),
    // 使时间选择器只作用于用量明细,不改变 Token 活动热力图。
    const heatAgg = aggregate(fullList)
    const daily = heatAgg.daily

    const totals = [...agg.per.values()].reduce((acc, r) => {
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
    const costCny = list.reduce((s, c) => {
      const p = effectivePrice(c.model, c.ts)
      return s
        + (c.inp + c.cw) / 1_000_000 * p.in
        + c.cr / 1_000_000 * p.cache
        + c.out / 1_000_000 * p.out
    }, 0)
    const billedIn = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
    const cacheHitRate = billedIn + totals.outputTokens > 0 ? totals.cacheReadTokens / (billedIn + totals.outputTokens) : 0

    // 顶部统计栏:全量历史(模型筛选仍生效,时间窗口不生效)
    const fullAgg = aggregate(fullList)
    const fullTotals = [...fullAgg.per.values()].reduce((acc, r) => {
      acc.inputTokens += r.inputTokens
      acc.outputTokens += r.outputTokens
      acc.cacheReadTokens += r.cacheReadTokens
      acc.cacheWriteTokens += r.cacheWriteTokens
      return acc
    }, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
    const fullStreak = streaks(fullList)
    const overview = {
      totalTokens: fullTotals.inputTokens + fullTotals.outputTokens + fullTotals.cacheReadTokens + fullTotals.cacheWriteTokens,
      peakTokens: fullList.reduce((m, c) => Math.max(m, c.inp + c.out + c.cr + c.cw), 0),
      maxDur: fullList.reduce((m, c) => Math.max(m, c.dur), 0),
      currentStreak: fullStreak.currentStreak,
      maxStreak: fullStreak.maxStreak,
    }

    return {
      rows,
      totals,
      daily,
      overview,
      summary: {
        totalTokens,
        peakTokens,
        maxDur,
        currentStreak: st.currentStreak,
        maxStreak: st.maxStreak,
        requests: list.length,
        costCny,
        // Keep the old wire key for clients that have not refreshed yet.
        costUsd: costCny,
        cacheHitRate,
        cacheReadTokens: totals.cacheReadTokens,
        reasoningTokens: totals.reasoningTokens,
      },
      debug: { appliedAt, streamHits, usageHits, recorded, heap: calls.length, version: HOST_VERSION },
    }
  }

  // ── HTTP 端点 ──
  const connection = connectionOf(ctx)
  const rejectUntrustedRequest = (req: IncomingMessage, res: ServerResponse): boolean => {
    const status = connection.requestRejection(req)
    if (status === undefined) return false
    res.writeHead(status)
    res.end()
    return true
  }

  ctx.effect(() => {
    const disposeReport = ctx.webServer.register({
      kind: 'exact',
      path: '/api/model-usage',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (rejectUntrustedRequest(req, res)) return
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET' })
          res.end()
          return
        }
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          const query: Record<string, string> = {}
          url.searchParams.forEach((value, key) => { query[key] = value })
          const body = JSON.stringify(buildReport(query))
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          })
          res.end(body)
        } catch (error) {
          console.error('[model-usage] report request failed', error)
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: 'model-usage error' }))
        }
      },
    })
    const disposeReset = ctx.webServer.register({
      kind: 'exact',
      path: '/api/model-usage/reset',
      handler: async (req, res) => {
        if (rejectUntrustedRequest(req, res)) return
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' })
          res.end()
          return
        }
        try {
          mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 })
          writeFileSync(STORE_FILE, '', { encoding: 'utf8', mode: 0o600 })
          chmodSync(STORE_FILE, 0o600)
          calls.length = 0
          recorded = 0
          persistedRecords = 0
        } catch (error) {
          console.error(`[model-usage] reset failed: ${String(error)}`)
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: false }))
          return
        }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        res.end(JSON.stringify({ ok: true }))
      },
    })
    console.log('[model-usage] HTTP endpoints registered at /api/model-usage')
    return () => {
      disposeReset()
      disposeReport()
    }
  }, 'model-usage: protected HTTP routes')
}
