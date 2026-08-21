/**
 * 模型用量 dashboard — the settings section body.
 *
 * Mirrors the openai/codex usage dashboard: a horizontal five-metric stat
 * bar, a GitHub-style daily activity heatmap (近6个月默认,顶部统计为全量
 * 历史), and a usage detail panel (KPI cards, cache-hit rate, per-model rows).
 */

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { ModelRow, UsageReport } from '../report.ts'
import styles from './UsageSection.module.css'

export interface UsageSectionProps {
  close?: () => void
}

/**
 * 热力等级 → CSS 类:色值在 UsageSection.module.css 里按
 * body[data-ds-dark-theme] 提供深色分支,浅/深主题自动切换。
 */
const cellClass = (level: number): string => 'cell' + level

/** 将整数缩写为中文习惯(3.7亿 / 4164.4万)。 */
function fc(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n >= 1e8) return trim(n / 1e8) + '亿'
  if (n >= 1e4) return trim(n / 1e4) + '万'
  return String(Math.round(n))
}

function trim(x: number): string {
  return (Math.round(x * 10) / 10).toString()
}

/** 格式化时间戳为 MM月DD日 HH:mm,供时间范围指示器展示。 */
function fmtDT(ms: number | null): string {
  if (ms == null) return '—'
  const d = new Date(ms)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 耗时格式化:26分48秒 / 1小时5分。 */
function fdur(ms: number | null | undefined): string {
  if (ms == null) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return s + ' 秒'
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m < 60) return m + '分' + (r ? String(r).padStart(2, '0') + '秒' : '')
  const h = Math.floor(m / 60)
  return h + '小时' + (m % 60 ? (m % 60) + '分' : '')
}

/** 热力等级:0 → 0,>0 按 1/4 分位取 1..4。 */
function lvl(v: number, max: number): number {
  if (v <= 0) return 0
  const r = v / (max || 1)
  return r > 0.75 ? 4 : r > 0.5 ? 3 : r > 0.25 ? 2 : 1
}

/**
 * 合并"同名同源"的模型行:同一 provider 下、模型名去掉来源前缀后相同
 * 的行视为同一个模型(例如 workbuddy-ocx 下的 `deepseek-v4-flash` 与
 * `workbuddy/deepseek-v4-flash` 只是改过名),数值字段累加合并。
 * 顺序取首次出现的位置。
 */
function mergeRows(rows: ModelRow[]): ModelRow[] {
  const map = new Map<string, ModelRow>()
  const order: string[] = []
  for (const r of rows) {
    const base = r.provider.split('-')[0] || r.provider
    let model = r.model
    if (base && model.startsWith(base + '/')) model = model.slice(base.length + 1)
    const key = r.provider + '\u0000' + model
    const existing = map.get(key)
    if (!existing) {
      order.push(key)
      map.set(key, { ...r, model })
    } else {
      existing.calls += r.calls
      existing.inputTokens += r.inputTokens
      existing.outputTokens += r.outputTokens
      existing.cacheReadTokens += r.cacheReadTokens
      existing.cacheWriteTokens += r.cacheWriteTokens
      existing.reasoningTokens += r.reasoningTokens
      existing.totalTokens += r.totalTokens
      existing.firstAt = Math.min(existing.firstAt, r.firstAt)
      existing.lastAt = Math.max(existing.lastAt, r.lastAt)
      existing.peakTokens = Math.max(existing.peakTokens, r.peakTokens)
      existing.maxDur = Math.max(existing.maxDur, r.maxDur)
    }
  }
  return order.map((k) => map.get(k)!)
}

/** 时间范围:start/end 为毫秒时间戳,null 表示不限(端点开放)。 */
export interface TimeRange {
  start: number | null
  end: number | null
  /** 界面显示标签,如"近 6 个月" / "自定义"。 */
  label: string
  /** 热力图展示天数(预设定值或按自定义范围估算)。 */
  days: number
}

const DAY = 86_400_000

/** 预置档:全部 / 当天 / 1d / 7d / 14d / 30d / 6个月。 */
const PRESETS: { key: string; label: string; make: (now: number) => TimeRange }[] = [
  { key: 'all', label: '全部', make: () => ({ start: null, end: null, label: '全部', days: 365 }) },
  {
    key: 'today', label: '当天',
    make: (now) => {
      const d = new Date(now); d.setHours(0, 0, 0, 0)
      return { start: d.getTime(), end: null, label: '当天', days: 7 }
    },
  },
  { key: '1d', label: '1d', make: (now) => ({ start: now - DAY, end: null, label: '近 1 天', days: 7 }) },
  { key: '7d', label: '7d', make: (now) => ({ start: now - 7 * DAY, end: null, label: '近 7 天', days: 7 }) },
  { key: '14d', label: '14d', make: (now) => ({ start: now - 14 * DAY, end: null, label: '近 14 天', days: 14 }) },
  { key: '30d', label: '30d', make: (now) => ({ start: now - 30 * DAY, end: null, label: '近 30 天', days: 30 }) },
  { key: '6m', label: '6 个月', make: (now) => ({ start: now - 182 * DAY, end: null, label: '近 6 个月', days: 182 }) },
]

/** 判断两个时间范围是否等价(用于选中态高亮)。 */
function sameRange(a: TimeRange, b: TimeRange): boolean {
  return a.start === b.start && a.end === b.end
}

/** 自定义范围构造(跟随当前时刻时 end 置 null)。 */
function customRange(startMs: number, endMs: number | null): TimeRange {
  const days = Math.max(7, Math.round(((endMs ?? Date.now()) - startMs) / DAY))
  return { start: startMs, end: endMs, label: '自定义', days }
}

export function UsageSection(_props: UsageSectionProps): ReactNode {
  const [report, setReport] = useState<UsageReport | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [model, setModel] = useState('')
  const [range, setRange] = useState<TimeRange>(() => PRESETS.find((p) => p.key === '7d')!.make(Date.now()))
  const [auto, setAuto] = useState(true)
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null)
  const [rev, setRev] = useState(0)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  // 热力图自己的时间范围(独立于用量明细的时间选择器)。
  const [heatZoom, setHeatZoom] = useState(182)

  const load = useCallback(async (): Promise<void> => {
    try {
      // start/end 作为时间范围传给 host:作用于用量明细(KPI/列表/每日),顶部统计全量。
      const q = new URLSearchParams({ model })
      if (range.start != null) q.set('start', String(range.start))
      if (range.end != null) q.set('end', String(range.end))
      const res = await fetch(`/api/model-usage?${q}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as UsageReport
      setReport(data)
      setErr(null)
    } catch (error) {
      setErr(String(error instanceof Error ? error.message : error))
    }
  }, [range, model])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!auto) return
    const id = setInterval(() => { void load() }, 5000)
    return () => clearInterval(id)
  }, [auto, load])

  const reload = (): void => { setRev((r) => r + 1) }
  useEffect(() => { if (rev > 0) void load() }, [rev, load])

  if (err) {
    return (
      <div className={styles.empty}>
        <div>⚠️ 加载模型用量失败</div>
        <div className={styles.errSub}>{err}</div>
      </div>
    )
  }
  if (!report) return <div className={styles.empty}>加载中…</div>

  // 顶部统计栏:全量历史;用量明细(KPI/列表):窗口内(days)。
  // 防御:老版本 host 可能尚未返回 overview(需重启 DSH),缺失时回退到
  // summary,避免页面白屏。
  const sum = report.summary
  const ov = report.overview ?? {
    totalTokens: sum.totalTokens,
    peakTokens: sum.peakTokens,
    maxDur: sum.maxDur,
    currentStreak: sum.currentStreak,
    maxStreak: sum.maxStreak,
  }
  // 先去重合并同源同名(如 workbuddy/deepseek-v4-flash ≡ deepseek-v4-flash),再分组。
  // 过滤掉没有任何输入/输出/缓存 token 的模型(如 0 token 的调用,不影响展示)。
  const rows = mergeRows(report.rows).filter((r) => r.totalTokens > 0)
  const daily = report.daily

  // ── 热力图:7 行 × N 列(列 = 周,与 GitHub/Codex 一致) ──
  // 热力图有自己的时间范围(heatZoom:6个月/1年),独立于用量明细的时间选择器。
  const heatDays = heatZoom
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const weeks = Math.ceil((heatDays + today.getDay()) / 7)
  const start = new Date(today)
  start.setDate(start.getDate() - (weeks * 7 - 1 - today.getDay()))
  const cells: { key: string; t: number; future: boolean; label: string; col: number; row: number }[] = []
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    cells.push({
      key,
      t: daily[key]?.tokens ?? 0,
      future: d.getTime() > today.getTime(),
      label: `${d.getMonth() + 1}月${d.getDate()}日`,
      col: Math.floor(i / 7),
      row: i % 7,
    })
  }
  const maxDay = Math.max(1, ...cells.map((c) => (c.future ? 0 : c.t)))

  // 月份标签(底部横排):每月从"包含该月 1 号的那一列"开始。
  // 之前的实现按每列首日的月份打标,导致 8月1号 落在上一列(7月31日那列)
  // 却要到下一列(8月7日)才标 8月;现在遍历每日,记录每月首次出现的列。
  const monthStartCols: { y: number; m: number; col: number }[] = []
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const y = d.getFullYear(), m = d.getMonth()
    const last = monthStartCols[monthStartCols.length - 1]
    if (!last || last.y !== y || last.m !== m) {
      monthStartCols.push({ y, m, col: Math.floor(i / 7) })
    }
  }
  const monthBands: { label: string; span: number }[] = monthStartCols.map((s, idx) => {
    const next = monthStartCols[idx + 1]
    return { label: `${s.m + 1}月`, span: next ? next.col - s.col : weeks - s.col }
  })

  const showTip = (text: string) => (e: { clientX: number; clientY: number }): void => {
    setTip({ text, x: e.clientX, y: e.clientY })
  }
  const moveTip = (e: { clientX: number; clientY: number }): void => {
    setTip((t) => (t ? { ...t, x: e.clientX, y: e.clientY } : t))
  }
  const hideTip = (): void => setTip(null)

  // ── 按来源(provider)分组:同一来源的模型全部叠放在一个组里(不分先后),可收缩/展开 ──
  const groupMap = new Map<string, { provider: string; rows: ModelRow[]; totalTokens: number; calls: number }>()
  for (const r of rows) {
    let g = groupMap.get(r.provider)
    if (!g) {
      g = { provider: r.provider, rows: [], totalTokens: 0, calls: 0 }
      groupMap.set(r.provider, g)
    }
    g.rows.push(r)
    g.totalTokens += r.totalTokens
    g.calls += r.calls
  }
  const groups = [...groupMap.values()]
  // 默认收缩:未在 collapsed 记录里的组视为折叠(undefined → 折叠)。
  const isCollapsed = (provider: string): boolean => collapsed[provider] === undefined ? true : collapsed[provider]
  const toggle = (provider: string): void =>
    setCollapsed((prev) => {
      const cur = prev[provider] === undefined ? true : prev[provider]
      return { ...prev, [provider]: !cur }
    })

  return (
    <div className={styles.root}>
      {/* ── 顶部统计栏:5 个指标横向排列(全量历史) ── */}
      <div className={styles.stats}>
        <StatCard label="累计 Token 数" value={fc(ov.totalTokens)} />
        <StatCard label="峰值 Token 数" value={fc(ov.peakTokens)} />
        <StatCard label="最长聊天时长" value={fdur(ov.maxDur)} />
        <StatCard label="当前连续天数" value={ov.currentStreak != null ? `${ov.currentStreak} 天` : '—'} />
        <StatCard label="最长连续天数" value={ov.maxStreak != null ? `${ov.maxStreak} 天` : '—'} />
      </div>

      {/* ── Token 活动 ── */}
      <div className={styles.panel}>
        <div className={styles.panelHead}>
          <h3><span className={styles.dotBlue} />Token 活动</h3>
          <div className={styles.tools}>
            <select
              className={styles.sel}
              value={heatZoom}
              onChange={(e) => setHeatZoom(Number(e.target.value))}
              title="热力图时间范围(不影响用量明细)"
            >
              <option value={182}>近 6 个月</option>
              <option value={365}>近 1 年</option>
            </select>
          </div>
        </div>

        <div className={styles.heatWrap}>
          <div className={styles.heat} style={{ '--weeks': weeks } as CSSProperties}>
            {Array.from({ length: 7 }, (_, ri) => (
              <Fragment key={ri}>
                {Array.from({ length: weeks }, (_, c) => {
                  const cell = cells[c * 7 + ri]!
                  return (
                    <div
                      key={cell.key}
                      className={styles.cell + ' ' + (cell.future ? styles.cellFuture : styles[cellClass(lvl(cell.t, maxDay))])}
                      onMouseEnter={showTip(`${cell.label} 使用了 ${fc(cell.t)} 个 Token`)}
                      onMouseMove={moveTip}
                      onMouseLeave={hideTip}
                    />
                  )
                })}
              </Fragment>
            ))}
          </div>
          <div className={styles.monthBar} style={{ '--weeks': weeks } as CSSProperties}>
            {monthBands.map((b, i) => (
              <div
                key={i}
                className={styles.monthBand}
                style={{ gridColumn: `span ${Math.max(1, b.span)}` }}
              >
                {b.label}
              </div>
            ))}
          </div>
        </div>

        {tip && (
          <div className={styles.tooltip} style={{ left: tip.x + 12, top: tip.y + 12 }}>
            {tip.text}
          </div>
        )}
      </div>

      {/* ── 用量明细 ── */}
      <div className={styles.panel}>
        <div className={styles.panelHead}>
          <h3><span className={styles.dotGreen} />用量明细</h3>
          <div className={styles.tools}>
            <TimeRangePicker value={range} onChange={setRange} />
            <ModelSelect
              value={model}
              rows={rows}
              onChange={setModel}
            />
            <button className={styles.btn} onClick={reload}>⟳ 刷新</button>
            <button className={styles.btn + (auto ? ' ' + styles.on : '')} onClick={() => setAuto(!auto)}>
              {auto ? <span className={styles.auto}><span className={styles.pulse} />5s 自动刷新</span> : '自动刷新关闭'}
            </button>
          </div>
        </div>

        {/* 当前时间范围指示器(便于确认所选范围是否生效) */}
        <div className={styles.rangeInfo}>
          当前范围:<span className={styles.rangeInfoStrong}>{range.label}</span>
          <span className={styles.rangeInfoDim}>
            {range.start != null ? fmtDT(range.start) : '全部时间'}
            {range.end != null ? ' ~ ' + fmtDT(range.end) : ''}
          </span>
          <span className={styles.rangeInfoDim}>
            {report.debug?.version ? '· host ' + report.debug.version : ''}
          </span>
        </div>

        {/* KPI 卡(无图标,简洁文字) */}
        <div className={styles.kpis}>
          <Kpi l="真实消耗 Tokens" v={fc(sum.totalTokens)} d="输入+输出+缓存" />
          <Kpi l="总请求数" v={sum.requests != null ? String(sum.requests) : '—'} d="所有模型调用" />
          <Kpi l="总成本(估算)" v={sum.costUsd != null ? '¥' + Number(sum.costUsd).toFixed(2) : '—'} d="按官方公开价(¥/M)估算" />
          <Kpi l="缓存命中" v={fc(sum.cacheReadTokens)} d="cache read tokens" />
          <Kpi l="推理 Tokens" v={fc(sum.reasoningTokens)} d="reasoning tokens" />
        </div>

        {/* 缓存命中率 */}
        <div className={styles.rateWrap}>
          <div className={styles.rateRow}>
            <span className={styles.rateL}>缓存命中率</span>
            <span className={styles.rateV}>{sum.cacheHitRate != null ? (sum.cacheHitRate * 100).toFixed(1) + '%' : '—'}</span>
          </div>
          <div className={styles.rateBar}><div className={styles.rateFill} style={{ width: Math.min(100, (sum.cacheHitRate ?? 0) * 100) + '%' }} /></div>
        </div>

        {/* 模型列表:按来源(provider)分组,可收缩/展开 */}
        {rows.length === 0 ? (
          <div className={styles.empty}>暂无调用记录</div>
        ) : (
          <div className={styles.list}>
            {groups.map((g) => {
              const open = !isCollapsed(g.provider)
              return (
                <div key={g.provider} className={styles.group}>
                  <button
                    type="button"
                    className={styles.groupHead}
                    onClick={() => toggle(g.provider)}
                    aria-expanded={open}
                  >
                    <span className={styles.groupChevron + (open ? ' ' + styles.groupChevronOpen : '')}>▸</span>
                    <span className={styles.groupName}>{g.provider}</span>
                    <span className={styles.groupMeta}>
                      {g.rows.length} 个模型 · 共 {fc(g.totalTokens)} · {g.calls} 次调用
                    </span>
                  </button>
                  {open && (
                    <div className={styles.groupBody}>
                      {g.rows.map((r) => (
                        <div key={r.provider + '/' + r.model} className={styles.row}>
                          <div className={styles.nm}>
                            <div>{r.model}</div>
                            <div className={styles.pv}>{r.provider}</div>
                          </div>
                          <div className={styles.nums}>
                            <div className={styles.num}><b>{fc(r.totalTokens)}</b><span>总 token</span></div>
                            <div className={styles.num}><b>{r.calls}</b><span>调用</span></div>
                            <div className={styles.num}><b>{fc(r.inputTokens)}</b><span>输入</span></div>
                            <div className={styles.num}><b>{fc(r.outputTokens)}</b><span>输出</span></div>
                            <div className={styles.num}><b>{fc(r.reasoningTokens)}</b><span>推理</span></div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className={styles.stat}>
      <div className={styles.statVal}>{value}</div>
      <div className={styles.statLabel}>{label}</div>
    </div>
  )
}

function Kpi({ l, v, d }: { l: string; v: string; d: string }): ReactNode {
  return (
    <div className={styles.kpi}>
      <div className={styles.kpiL}>{l}</div>
      <div className={styles.kpiV}>{v}</div>
      <div className={styles.kpiD}>{d}</div>
    </div>
  )
}

/** 自定义模型筛选下拉:纯文字按钮 + 浮层,选中项高亮带 ✓。 */
function ModelSelect(props: {
  value: string
  rows: ReadonlyArray<{ model: string; provider: string }>
  onChange: (v: string) => void
}): ReactNode {
  const { value, rows, onChange } = props
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const label = value === '' ? '全部模型' : value.replace('/', ' · ')

  return (
    <div className={styles.dropdown} ref={rootRef}>
      <button
        type="button"
        className={styles.dropBtn + (open ? ' ' + styles.open : '')}
        onClick={() => setOpen(!open)}
      >
        {label}
      </button>
      {open && (
        <div className={styles.dropMenu}>
          <button
            type="button"
            className={styles.dropItem + (value === '' ? ' ' + styles.picked : '')}
            onClick={() => { onChange(''); setOpen(false) }}
          >
            <span className={styles.dropText}>全部模型</span>
            {value === '' && <span className={styles.dropCheck}>✓</span>}
          </button>
          {rows.map((r) => {
            const v = r.provider + '/' + r.model
            return (
              <button
                type="button"
                key={v}
                className={styles.dropItem + (value === v ? ' ' + styles.picked : '')}
                onClick={() => { onChange(v); setOpen(false) }}
              >
                <span className={styles.dropText}>{r.model} · {r.provider}</span>
                {value === v && <span className={styles.dropCheck}>✓</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** ms → datetime-local 输入值(YYYY-MM-DDTHH:mm)。 */
function toLocalInput(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** datetime-local 输入值 → ms;非法输入返回 null。 */
function fromLocalInput(s: string): number | null {
  if (!s) return null
  const t = new Date(s).getTime()
  return Number.isFinite(t) ? t : null
}

/** ccswitch 风格时间范围选择器:预置档 + 自定义起止时间 + 结束跟随当前。 */
function TimeRangePicker(props: {
  value: TimeRange
  onChange: (r: TimeRange) => void
}): ReactNode {
  const { value, onChange } = props
  const [open, setOpen] = useState(false)
  const [customStart, setCustomStart] = useState(() => toLocalInput(value.start ?? Date.now() - DAY))
  const [customEnd, setCustomEnd] = useState(() => toLocalInput(value.end ?? Date.now()))
  const [followNow, setFollowNow] = useState(value.end == null && value.start != null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const applyPreset = (p: (typeof PRESETS)[number]): void => {
    onChange(p.make(Date.now()))
    setOpen(false)
  }
  const applyCustom = (): void => {
    const start = fromLocalInput(customStart)
    if (start == null) return
    const end = followNow ? null : fromLocalInput(customEnd)
    onChange(customRange(start, end))
    setOpen(false)
  }

  return (
    <div className={styles.dropdown} ref={rootRef}>
      <button
        type="button"
        title="选择时间范围,仅作用于用量明细(展示该时间段内使用的模型与用量)"
        className={styles.dropBtn + (open ? ' ' + styles.open : '')}
        onClick={() => {
          // 每次打开时用当前值初始化自定义草稿
          setCustomStart(toLocalInput(value.start ?? Date.now() - DAY))
          setCustomEnd(toLocalInput(value.end ?? Date.now()))
          setFollowNow(value.end == null && value.start != null)
          setOpen(!open)
        }}
      >
        {value.label}
        <span className={styles.dropChevron}>▾</span>
      </button>
      {open && (
        <div className={styles.rangeMenu}>
          <div className={styles.rangePresets}>
            {PRESETS.map((p) => {
              const r = p.make(Date.now())
              const picked = sameRange(value, r)
              return (
                <button
                  type="button"
                  key={p.key}
                  className={styles.chip + (picked ? ' ' + styles.chipOn : '')}
                  onClick={() => applyPreset(p)}
                >
                  {p.label}
                </button>
              )
            })}
          </div>
          <div className={styles.rangeDivider} />
          <div className={styles.rangeCustom}>
            <div className={styles.rangeHint}>支持日期与时间</div>
            <label className={styles.rangeField}>
              <span>开始时间</span>
              <input
                className={styles.sel}
                type="datetime-local"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
              />
            </label>
            <label className={styles.rangeField}>
              <span>结束时间</span>
              <input
                className={styles.sel}
                type="datetime-local"
                value={customEnd}
                disabled={followNow}
                onChange={(e) => setCustomEnd(e.target.value)}
              />
            </label>
            <label className={styles.rangeCheck}>
              <input
                type="checkbox"
                checked={followNow}
                onChange={(e) => setFollowNow(e.target.checked)}
              />
              结束时间跟随当前时刻
            </label>
            <div className={styles.rangeActions}>
              <button type="button" className={styles.btn} onClick={() => setOpen(false)}>取消</button>
              <button type="button" className={styles.btnPrimary} onClick={applyCustom}>确定</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}