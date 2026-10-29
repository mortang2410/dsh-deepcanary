import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { handleNotificationClick, positionSelectedAttention } from '../src/client/attention-navigation.js'
import { filterInboxItems, groupDecisionItems, orderDecisionBlocks, showsAttentionItems } from '../src/client/decision-groups.js'
import type { DecisionGroupingEntry, DecisionFilter } from '../src/client/decision-groups.js'
import { decisionSessionLabel, workingDirectoryBasename } from '../src/client/session-navigation.js'

describe('DeepCanary attention navigation', () => {
  it('returns a notification click to the selected alert in order', () => {
    const order: string[] = []
    handleNotificationClick(
      { close: () => { order.push('close') } },
      'alert-2',
      () => { order.push('focus') },
      id => { order.push(`open:${id}`) },
    )
    expect(order).toEqual(['focus', 'open:alert-2', 'close'])
  })

  it('positions only the matching alert with nearest alignment', () => {
    const calls: Array<{ id: string; options: unknown }> = []
    const elements = ['alert-1', 'alert-2'].map(id => ({
      dataset: { deepcanaryItem: id },
      scrollIntoView: (options?: unknown) => { calls.push({ id, options }) },
    }))
    expect(positionSelectedAttention(elements, 'alert-2')).toBe(true)
    expect(positionSelectedAttention(elements, 'missing')).toBe(false)
    expect(calls).toEqual([{ id: 'alert-2', options: { block: 'nearest', inline: 'nearest' } }])
  })

  it('keeps the Inbox visible when alpha5 rejects an older session id', () => {
    const order: string[] = []
    handleNotificationClick(
      { close: () => { order.push('close') } },
      'historical-alert',
      () => { order.push('focus') },
      id => { order.push(`open:${id}`) },
      () => false,
      url => { order.push(`navigate:${url}`) },
      '/?session=historical-session',
      'historical-session',
    )
    expect(order).toEqual(['focus', 'open:historical-alert', 'close'])
  })

  it('retains URL fallback for a host without the native Session API', () => {
    const order: string[] = []
    handleNotificationClick(
      { close: () => { order.push('close') } },
      'legacy-alert',
      () => { order.push('focus') },
      id => { order.push(`open:${id}`) },
      undefined,
      url => { order.push(`navigate:${url}`) },
      '/?session=legacy-session',
    )
    expect(order).toEqual(['focus', 'open:legacy-alert', 'navigate:/?session=legacy-session', 'close'])
  })

  it('prefers the public DSH Session API for an existing historical target', () => {
    const order: string[] = []
    handleNotificationClick(
      { close: () => { order.push('close') } },
      'historical-alert',
      () => { order.push('focus') },
      id => { order.push(`open:${id}`) },
      sessionId => { order.push(`session:${sessionId}`); return true },
      url => { order.push(`navigate:${url}`) },
      '/?session=historical-session',
      'historical-session',
    )
    expect(order).toEqual(['focus', 'session:historical-session', 'open:historical-alert', 'close'])
  })
})

describe('DeepCanary decision inbox views', () => {
  const item = (id: string, decision?: DecisionGroupingEntry['decision']): DecisionGroupingEntry => ({
    id, sessionId: id, occurredAt: `2026-01-0${id.length}T00:00:00.000Z`, ...(decision === undefined ? {} : { decision }),
  })

  it('shows every entry by default and keeps attention entries in the pending view', () => {
    const entries = [
      item('attention'),
      item('pending', { kind: 'pending' }),
      item('made', { kind: 'made', reviewState: 'unreviewed' }),
      item('reviewed', { kind: 'made', reviewState: 'reviewed' }),
      item('disputed', { kind: 'made', reviewState: 'disputed' }),
    ]
    const ids = (filter: DecisionFilter) => filterInboxItems(entries, filter).map(entry => entry.id)

    expect(ids('all')).toEqual(['attention', 'pending', 'made', 'reviewed', 'disputed'])
    expect(ids('pending')).toEqual(['attention', 'pending'])
    expect(ids('made')).toEqual(['made'])
    expect(ids('reviewed')).toEqual(['reviewed'])
    expect(ids('disputed')).toEqual(['disputed'])
    expect(showsAttentionItems('all')).toBe(true)
    expect(showsAttentionItems('pending')).toBe(true)
    expect(showsAttentionItems('made')).toBe(false)
    expect(showsAttentionItems('reviewed')).toBe(false)
    expect(showsAttentionItems('disputed')).toBe(false)
  })

  it('keeps attention cards and decision groups in the incoming priority order', () => {
    const entries = [item('urgent'), item('question', { kind: 'pending' }), item('routine')]
    const groups = groupDecisionItems([entries[1]!])
    const blocks = orderDecisionBlocks(entries, groups)
    expect(blocks.map(block => block.kind === 'attention' ? `attention:${block.item.id}` : `group:${block.group.sessionId}`))
      .toEqual(['attention:urgent', 'group:question', 'attention:routine'])
  })

  it('uses the basename of a Windows working directory until the title arrives', () => {
    const directory = 'C:\\work\\app'
    expect(workingDirectoryBasename(directory)).toBe('app')
    expect(decisionSessionLabel({ sessionId: 'child', decision: { workingDirectory: directory } }, { id: 'child', cwd: directory })).toBe('app')
  })

  it('uses the session-list title over the basename and exposes nested group data for rendering', () => {
    const entry = item('child', { kind: 'made', parentSessionId: 'root', delegationDepth: 1, workingDirectory: '/work/app' })
    const session = { id: 'child', cwd: '/work/app', parentId: 'root' }
    const groups = groupDecisionItems([entry], { byId: { root: { id: 'root', cwd: '/work/app' }, child: session } })

    expect(groups[0]).toMatchObject({
      sessionId: 'root', title: 'app', workingDirectory: '/work/app',
      children: [{ sessionId: 'child', depth: 1, title: 'app', items: [{ id: 'child' }] }],
    })
    expect(decisionSessionLabel(entry, session)).toBe('app')
    expect(decisionSessionLabel(entry, { ...session, title: 'Session title event' })).toBe('Session title event')
  })
})

describe('DeepCanary DSH client surface', () => {
  it('declares the DSH client module and all four interaction gates', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
      exports?: Record<string, unknown>
      dsh?: { client?: { platform?: string; inject?: string[] } }
    }
    const source = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')

    expect(manifest.exports?.['./client']).toBe('./lib/client.js')
    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(manifest.dsh?.client?.inject).toEqual([
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-layout',
      '@deepseek-ai/dsh-api-session-controller',
      '@deepseek-ai/dsh-client-ui-session',
      '@deepseek-ai/dsh-client-ui-sidebar',
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-ui-settings-plugins',
    ])
    expect(source).toContain('open: false')
    expect(source).toContain('data-deepcanary-close')
    expect(source).toContain('sidebar.footer.action')
    expect(source).toContain('shell.overlay')
    expect(source).toContain('role: \'separator\'')
    expect(source).toContain('onPointerCancel')
    expect(source).toContain('touch-action:none')
    expect(source).toContain('aria-live\': \'polite\'')
    expect(source).toContain('AUTO_OPEN_REASONS')
    expect(source).toContain('panel.bodyLabel')
    expect(source).toContain('satisfies Record<keyof typeof zh, string>')
    expect(source).toContain('ctx.locale.register(NS, { zh, en })')
    expect(source).toContain('settings.plugins.tab')
    expect(source).toContain('ctx.configForms.get<ClientSettings>(SETTINGS_NS)')
    expect(source).toContain('ctx.configForms.whileServed')
    expect(source).toContain('id: SETTINGS_NS')
    expect(source).toContain('new SettingsDraft')
    expect(source).toContain('requestId: makeRequestId()')
    expect(source).toContain('positionSelectedAttention')
    expect(source).toContain('filterDecisionLists(items, scheduledItems, decisionFilter, state.selectedId)')
    expect(source).toContain('groupDecisionItems')
    expect(source).toContain('orderDecisionBlocks(visibleEntries, decisionGroups)')
    expect(source).toContain('orderDecisionBlocks(visibleScheduledEntries, scheduledGroups)')
    expect(source).toContain('useSyncExternalStore')
    expect(source).toContain('subscribeSessionList')
    expect(source).toContain('data-decision-filter')
    expect(source).toContain('dsc-session-group')
    expect(source).toContain('handleNotificationClick')
    expect(source).toContain('notificationTitle')
    expect(source).toContain('claimNotificationBatch')
    expect(source).toContain('ctx.sessions')
    expect(source).toContain('sessions.list?.subscribe')
    expect(source).toContain('scheduleFromSessionRevision')
    expect(source).toContain('item.moreActions')
    expect(source).toContain('item.suppressType')
    expect(source).toContain('item.feedbackMenu')
    expect(source).toContain('item.noSessionLink')
    expect(source).toContain('pointermove')
    expect(source).toContain('visibilitychange')
    expect(source).toContain('notificationGeneration(item)')
    expect(source).not.toContain('function SettingsForm')
  })

  it('uses the shared filter and group path for scheduled decisions', async () => {
    const source = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8')

    expect(source).toContain('filterDecisionLists(items, scheduledItems, decisionFilter, state.selectedId)')
    expect(source).toContain('if (activeFilter !== decisionFilter)')
    expect(source).toContain('setDecisionFilter(activeFilter)')
    expect(source).toContain('groupDecisionItems(scheduledDecisionEntries, sessionListSnapshot)')
    expect(source).toContain('orderDecisionBlocks(visibleScheduledEntries, scheduledGroups)')
    expect(source).toContain('...scheduledBlocks.map(block =>')
    expect(source).toContain('if (snapshot !== undefined && hasDecisions) body.push')
  })
})

describe('decision card rendering', () => {
  /** Every text node a rendered card would show, in document order. */
  function cardText(node: unknown, out: string[] = []): string[] {
    if (typeof node === 'string' || typeof node === 'number') {
      out.push(String(node))
      return out
    }
    if (Array.isArray(node)) {
      for (const child of node) cardText(child, out)
      return out
    }
    if (node !== null && typeof node === 'object' && 'props' in node) {
      const children = (node as { props?: { children?: unknown } }).props?.children
      if (children !== undefined) cardText(children, out)
    }
    return out
  }

  // A stub that never returns the bare key, so the card cannot fall back to its built-in catalogue
  // and every label the card asks for shows up with its parameters in the collected text.
  const translate = (key: string, params?: Record<string, unknown>): string =>
    params === undefined ? `T:${key}` : `T:${key} ${Object.values(params).join(' ')}`

  async function render(item: Record<string, unknown>): Promise<string> {
    const { itemCard } = await import('../src/client/index.js')
    const previous = Reflect.get(globalThis, 'document')
    Reflect.set(globalThis, 'document', { documentElement: { lang: 'en' } })
    try {
      const context = {
        state: { pending: new Set<string>() },
        t: translate,
        controller: { hasHistoricalSession: () => false },
        sessionListSnapshot: undefined,
        selectedId: undefined,
      }
      const tree = itemCard(
        { evidence: [], targetAvailable: true, bundleCount: 1, ...item } as unknown as Parameters<typeof itemCard>[0],
        context as unknown as Parameters<typeof itemCard>[1],
      )
      return cardText(tree).join('\n')
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, 'document')
      else Reflect.set(globalThis, 'document', previous)
    }
  }

  it('shows the stored answer on a pending decision and hides the answer form', async () => {
    const text = await render({
      id: 'decision-1',
      level: 'C2',
      status: 'open',
      occurredAt: '2026-01-01T00:00:00.000Z',
      decision: { kind: 'pending', sentence: 'Which store?', explanation: 'Two stores compete.', answer: 'Keep the store', deliveryState: 'queued' },
    })

    expect(text).toContain('T:item.decisionAnswerGiven Keep the store')
    expect(text).not.toContain('T:item.decisionSubmit')
  })

  it('offers the answer form while a pending decision has no answer', async () => {
    const text = await render({
      id: 'decision-2',
      level: 'C2',
      status: 'open',
      occurredAt: '2026-01-01T00:00:00.000Z',
      decision: { kind: 'pending', sentence: 'Which store?', explanation: 'Two stores compete.' },
    })

    expect(text).toContain('T:item.decisionSubmit')
    expect(text).not.toContain('T:item.decisionAnswerGiven')
  })
})
