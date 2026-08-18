# DSH-model-usage

> npm 包名：`dsh-model-usage`（npm 要求小写）· 仓库名：`DSH-model-usage`

<!-- Hero -->
<div align="center">
  <b style="font-size: 1.15em;">DeepSeek Harness 模型用量仪表盘 —— 设置页「模型用量」</b><br /><br />
  <a href="https://opensource.org/licenses/MIT"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
  <img alt="平台" src="https://img.shields.io/badge/-DeepSeek%20Harness-4d6bfe" /> <img alt="统计" src="https://img.shields.io/badge/-Token%20统计-4d6bfe" /> <img alt="成本" src="https://img.shields.io/badge/-成本估算-4d6bfe" /> <img alt="热力图" src="https://img.shields.io/badge/-活动热力图-4d6bfe" /><br /><br />
  <b>像 Codex 用量页一样查看你的 DSH Token 消耗</b> —— 按模型 API 逐次采集、本地持久化、
  浏览器端聚合展示，全程不经过任何第三方服务。
</div>

## ✨ 功能一览

- **📊 顶部统计栏**：累计 Token 数 / 峰值 Token 数 / 最长聊天时长 / 当前连续天数 / 最长连续天数
- **🔥 Token 活动热力图**：GitHub/Codex 风格 7×N 网格，近 30 天 / 90 天 / 6 个月 / 1 年 可切，悬停显示每日用量
- **📋 用量明细**：真实消耗 Tokens / 总请求数 / 总成本(估算) / 缓存命中 / 推理 Tokens 五张 KPI 卡
- **🛡 缓存命中率**：cache read token 占比进度条
- **🤖 模型列表**：按 `provider/model` 聚合，显示总 token、调用、输入、输出、推理
- **🔄 5s 自动刷新** + 手动刷新 + 模型筛选下拉
- **💾 本地持久化**：每次调用 append 写入 `~/.dsh/storages/model-usage.jsonl`，重启不丢
<img width="2528" height="1748" alt="7b2d7510411fc14b0bf8cb1fb4b02cc8" src="https://github.com/user-attachments/assets/ed9b93a9-2514-4dfb-9568-cfd9bc666531" />

## 📦 安装

要求：DeepSeek Harness（含 web profile）与 pnpm。

### 方式一：源码构建 + 挂载（推荐）

```bash
# 1. 克隆并构建
git clone https://github.com/ZSN12/DSH-model-usage.git
cd DSH-model-usage
pnpm install
pnpm build            # 产出 lib/index.js + lib/client.js + lib/types
pnpm pack             # 产出 tarball

# 2. 装进 web profile
dsh plugin --profile web add file:dsh-model-usage-0.1.0.tgz
```

### 方式二：profile 直挂（开发用）

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dsh": { "profile": { "bundles": [ /* ..., */ "dsh-model-usage" ] } },
  "dependencies": { "dsh-model-usage": "link:/path/to/dsh-model-usage" }
}
```

`cordis.patch.yml` 会注册 `model-usage` 插件，设置页出现「模型用量」分区。改完**重启 `dsh web`**（host 半路由随之加载）；浏览器端改动需重新 `pnpm build` 后刷新页面。

## 🔌 架构

| 半 | 文件 | 职责 |
|---|---|---|
| Host | `src/index.ts` | 包装 `llm/stream` waterfall 采集每次调用的 usage chunk；持久化到 jsonl；注册 HTTP 路由 |
| Host | `src/report.ts` | 共享的 wire contracts（记录结构 / 聚合行 / 单价表） |
| Client | `src/client/index.ts` | 注册 `settings.section` 分区（模型用量, order 12） |
| Client | `src/client/UsageSection.tsx` | 仪表盘 UI：统计栏 / 热力图 / KPI / 命中率 / 模型列表 |
| Client | `src/client/UsageSection.module.css` | 样式（CSS Modules, 随皮肤令牌适配） |

### Host 采集原理

```ts
ctx.on('llm/stream', async function* (options, next) {
  // 透传流,同时捕获 type === 'usage' 的 chunk
  for await (const chunk of next()) {
    if (chunk?.type === 'usage' && chunk.usage) captured = chunk.usage
    yield chunk
  }
  // 调用结束后 append 一条 UsageRecord 到 jsonl
})
```

记录字段：`{ ts, provider, model, inp, out, cr, cw, rsn, dur }`。启动时回放 jsonl（上限 50,000 条），内存聚合出报告。

### HTTP 端点

| 端点 | 说明 |
|---|---|
| `GET /api/model-usage?days=&model=` | 聚合报告 JSON（rows / totals / daily / summary / debug） |
| `POST /api/model-usage/reset` | 清空记录与 jsonl（⚠️ 无鉴权，仅限本机使用） |

## 💰 成本估算说明

KPI 卡里的「总成本(估算)」按 `src/report.ts` 内嵌的**公开单价表**（美元/百万 token）关键词匹配计算，**不是官方账单**。各模型价格会变动，如有偏差请自行更新单价表。

## 🔒 隐私与数据

- 所有用量数据仅写入本机 `~/.dsh/storages/model-usage.jsonl`（纯本地，无任何上传）
- 单价表与代码均为静态数据，不读取 API key、聊天内容或会话内容
- `MAX_CALLS = 50_000` 内存上限，超出后裁剪最旧记录（磁盘文件仍 append，重启回放时截断）

## 🧑‍💻 开发

```bash
pnpm install
pnpm build        # tsc 类型声明 + tsdown 双 bundle
pnpm watch        # tsdown watch
pnpm typecheck    # tsc --noEmit
```

`lib/` 为构建产物（已 gitignore），发布走 `pnpm pack`（`prepublishOnly` 自动构建）。

## 📄 License

[MIT](./LICENSE)

---

> 灵感来自 openai/codex 的用量页设计。本项目非 DeepSeek 官方出品。
