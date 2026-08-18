/**
 * 模型用量 (Model Usage) — browser half.
 *
 * Registers one `settings.section` entry (nav label 模型用量, order 12 —
 * between 模型 (10) and 插件 (15)) rendering the usage dashboard, which
 * fetches aggregates from the Host half's HTTP endpoints
 * (`/api/model-usage`, `/api/model-usage/reset`).
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { UsageSection } from './UsageSection.tsx'

export type { UsageSectionProps } from './UsageSection.tsx'

/** Required services: the settings slot ledger. */
export const inject = ['slots']

/**
 * Register the usage section once the `settings.section` declaration is on
 * the ledger. The dashboard needs no host push events — it polls the HTTP
 * endpoint on mount and on manual refresh.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'model-usage',
    order: 12,
    label: '模型用量',
  }, UsageSection))
}

export type UsageSectionOwnerProps = SettingsSectionOwnerProps
