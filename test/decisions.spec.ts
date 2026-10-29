import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { retainInboxItems } from '../src/core/inbox-retention.js'
import { DeepCanaryService } from '../src/service.js'
import { registerTools } from '../src/tools.js'
import type { InboxItem } from '../src/types.js'

interface FakeHeader {
  cwd?: string
  parentSession?: string
  delegationDepth?: number
}

// A stand-in for the host session store: only the header read the adapter performs.
function hostWith(headers: Record<string, FakeHeader>) {
  return {
    logger: {},
    sessions: { get: (id: string) => (Object.hasOwn(headers, id) ? { header: headers[id] } : undefined) },
  }
}

const cwd = '/work/app'
const valid = {
  sentence: 'Keep the existing store.',
  explanation: 'The store already persists inbox items, so a second table would duplicate it.',
  alternatives: 'A separate decisions file was considered and rejected for the reason above.',
  blastRadius: 'Only the inbox persistence path.',
}

describe('decisions', () => {
  const directories: string[] = []
  const services: DeepCanaryService[] = []

  async function open(headers: Record<string, FakeHeader>, stateDir?: string) {
    const directory = stateDir ?? await mkdtemp(path.join(os.tmpdir(), 'deepcanary-decisions-'))
    if (stateDir === undefined) directories.push(directory)
    const service = new DeepCanaryService(hostWith(headers) as never, { stateDir: directory })
    services.push(service)
    await service.ready
    return { service, directory }
  }

  afterEach(async () => {
    for (const service of services.splice(0)) await service.dispose()
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
  })

  it('records a made decision with its content and review state, and returns its id at once', async () => {
    const { service } = await open({ top: { cwd } })
    const returned = await service.recordMadeDecision('top', valid)
    const [listed] = service.inbox(5)
    expect(returned.id).toEqual(expect.any(String))
    expect(listed).toEqual(returned)
    expect(listed).toMatchObject({ sessionId: 'top', level: 'C1', reasonCode: 'DECISION_MADE' })
    expect(listed?.decision).toEqual({ kind: 'made', ...valid, delegationDepth: 0, workingDirectory: cwd, reviewState: 'unreviewed' })
  })

  it('stores the parent session and delegation depth of a subagent decision', async () => {
    const { service } = await open({ top: { cwd }, child: { cwd, parentSession: 'top', delegationDepth: 1 } })
    const item = await service.recordMadeDecision('child', valid)
    expect(item.decision).toMatchObject({ parentSessionId: 'top', delegationDepth: 1 })
  })

  it('keeps decisions whole across a restart of the same state directory', async () => {
    const headers = { top: { cwd }, child: { cwd, parentSession: 'top', delegationDepth: 1 } }
    const { service, directory } = await open(headers)
    const recorded = await service.recordMadeDecision('child', {
      ...valid,
      explanation: 'x'.repeat(4000),
      alternatives: 'y'.repeat(4000),
    })
    await service.dispose()
    const restarted = await open(headers, directory)
    expect(restarted.service.inbox(5)).toEqual([recorded])
  })

  // The limits are the specified values, written out so that changing a constant fails a test.
  it.each([
    ['sentence', 200],
    ['explanation', 4000],
    ['alternatives', 4000],
    ['blastRadius', 2000],
    ['sessionTitle', 200],
  ] as const)('accepts %s at its limit and refuses one character past it, storing nothing', async (field, limit) => {
    const { service } = await open({ top: { cwd } })
    const accepted = await service.recordMadeDecision('top', { ...valid, [field]: 'a'.repeat(limit) })
    expect(accepted.decision?.[field as 'sentence']).toHaveLength(limit)
    await expect(service.recordMadeDecision('top', { ...valid, [field]: 'a'.repeat(limit + 1) }))
      .rejects.toThrow(`the limit is ${limit}`)
    expect(service.inbox(10)).toHaveLength(1)
  })

  it('refuses a working directory one character past its limit and accepts one at it', async () => {
    const atLimit = `/${'a'.repeat(499)}`
    const accepted = await open({ top: { cwd: atLimit } })
    expect((await accepted.service.recordMadeDecision('top', valid)).decision?.workingDirectory).toHaveLength(500)
    const over = await open({ top: { cwd: `${atLimit}a` } })
    await expect(over.service.recordMadeDecision('top', valid)).rejects.toThrow('the limit is 500')
    expect(over.service.inbox(10)).toEqual([])
  })

  it('refuses a control character in the one-line sentence but allows line breaks in the explanation', async () => {
    const { service } = await open({ top: { cwd } })
    await expect(service.recordMadeDecision('top', { ...valid, sentence: 'Keep\nthe store.' })).rejects.toThrow('control character')
    const item = await service.recordMadeDecision('top', { ...valid, explanation: 'First line.\nSecond line.' })
    expect(item.decision?.explanation).toBe('First line.\nSecond line.')
  })

  it('keeps two decisions from one session, each with its own id', async () => {
    const { service } = await open({ top: { cwd } })
    const first = await service.recordMadeDecision('top', valid)
    const second = await service.recordMadeDecision('top', { ...valid, sentence: 'Use a second decision.' })
    expect(first.id).not.toBe(second.id)
    expect(service.decisionsFor('top').map(item => item.id)).toEqual([second.id, first.id])
  })

  it('refuses to acknowledge a decision, which stays open until it is answered or reviewed', async () => {
    const { service } = await open({ top: { cwd } })
    const item = await service.recordMadeDecision('top', valid)
    expect(service.acknowledge(item.id)).toBe(false)
    expect(service.inbox(5)[0]).toMatchObject({ id: item.id, status: 'open' })
  })

  it("lists only the calling session's decisions", async () => {
    const { service } = await open({ top: { cwd }, child: { cwd, parentSession: 'top', delegationDepth: 1 } })
    const own = await service.recordMadeDecision('top', valid)
    await service.recordMadeDecision('child', { ...valid, sentence: 'A subagent choice.' })
    expect(service.decisionsFor('top')).toEqual([own])
  })

  it('refuses a session the host does not know, and stores nothing', async () => {
    const { service } = await open({ top: { cwd } })
    await expect(service.recordMadeDecision('ghost', valid)).rejects.toThrow('not known to the host')
    expect(service.inbox(5)).toEqual([])
  })

  it('exposes the record tool under the calling session and refuses a call with no session', async () => {
    const { service } = await open({ top: { cwd } })
    const definitions = new Map<string, { execute: (args: unknown, exec: unknown) => Promise<unknown> }>()
    registerTools({ tools: { register: (definition: { name: string }) => definitions.set(definition.name, definition as never) } }, service)
    const record = definitions.get('deepcanary_record_decision')!
    const item = await record.execute(valid, { agent: { id: 'top' } }) as { id: string; decision: { workingDirectory: string } }
    expect(item.decision.workingDirectory).toBe(cwd)
    expect(await definitions.get('deepcanary_list_decisions')!.execute({}, { agent: { id: 'top' } })).toEqual([item])
    await expect(record.execute(valid, {})).rejects.toThrow('belong to the calling agent session')
  })

  // Every retention site (insert, ingest, restore, settings change) calls this function,
  // so its rule is the rule the service applies. Only the fields the ranker reads are set.
  it('keeps decisions through an attention overflow and still caps attention items', () => {
    const decision = { id: 'decision', decision: { kind: 'made' }, status: 'open', level: 'C1', occurredAt: '2026-01-01T00:00:00.000Z' } as InboxItem
    const attention = Array.from({ length: 5 }, (_, index) => ({
      id: `attention-${index}`,
      status: 'open',
      level: 'C1',
      occurredAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + index).toISOString(),
    }) as InboxItem)
    const kept = retainInboxItems([decision, ...attention], 2)
    expect(kept).toContain(decision)
    expect(kept.filter(item => item.decision === undefined)).toHaveLength(2)
    expect(retainInboxItems(attention, 2)).toHaveLength(2)
  })

  describe('pending decisions', () => {
    const options = ['Keep the store', 'Split the store']

    it('queues an answer when its known target is not live and refuses a second answer', async () => {
      const { service } = await open({ top: { cwd } })
      const requested = await service.requestDecision('top', { ...valid, options })
      expect(requested.decision?.deliveryState).toBe('queued')
      const answered = await service.answerDecision(requested.id, 'Keep the store')
      expect(answered.decision).toMatchObject({ answer: 'Keep the store', deliveryState: 'queued' })
      await expect(service.answerDecision(requested.id, 'Split the store')).rejects.toThrow(/already been answered/i)
    })

    it('refuses an overlong answer, accepts 8000 characters, and keeps the committed answer across restart', async () => {
      const headers = { top: { cwd } }
      const { service, directory } = await open(headers)
      const requested = await service.requestDecision('top', { ...valid, options })
      await expect(service.answerDecision(requested.id, '😀'.repeat(8001))).rejects.toThrow('the limit is 8000')
      expect(service.decisionsFor('top')[0]?.decision?.answer).toBeUndefined()
      const answer = '😀'.repeat(8000)
      const accepted = await service.answerDecision(requested.id, answer)
      expect(accepted.decision).toMatchObject({ answer, deliveryState: 'queued' })
      await service.dispose()
      const restarted = await open(headers, directory)
      expect(restarted.service.decisionsFor('top')[0]?.decision).toMatchObject({ answer, deliveryState: 'queued' })
      await expect(restarted.service.answerDecision(requested.id, 'Again')).rejects.toThrow(/already been answered/)
    })

    it('skips an in-flight delivery and releases its claim when the send fails', async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'deepcanary-decision-claim-'))
      directories.push(directory)
      let signalStarted!: () => void
      let rejectSend!: (error: Error) => void
      const started = new Promise<void>(resolve => { signalStarted = resolve })
      const blocked = new Promise<void>((_resolve, reject) => { rejectSend = reject })
      const followup = vi.fn().mockImplementationOnce(() => { signalStarted(); return blocked }).mockResolvedValue(undefined)
      const session = { id: 'top', header: { cwd } }
      const host = { logger: {}, sessions: { get: () => session, flush: async () => true }, agents: { get: () => ({ session, followup }) } }
      const service = new DeepCanaryService(host as never, { stateDir: directory })
      services.push(service)
      await service.ready
      const requested = await service.requestDecision('top', { ...valid, options })
      const answer = service.answerDecision(requested.id, 'Keep the store')
      await started
      const seam = service as unknown as { items: InboxItem[]; flushPendingDelivery(item: InboxItem): Promise<void> }
      const item = seam.items.find(candidate => candidate.id === requested.id)!
      await seam.flushPendingDelivery(item)
      expect(followup).toHaveBeenCalledTimes(1)
      rejectSend(new Error('send failed'))
      expect((await answer).decision?.deliveryState).toBe('queued')
      await seam.flushPendingDelivery(item)
      expect(followup).toHaveBeenCalledTimes(2)
      expect(service.decisionsFor('top')[0]?.decision?.deliveryState).toBe('queued')
    })

    it('observes only a token-bearing user message on the routed parent and preserves queued on failure', async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'deepcanary-decision-delivery-'))
      directories.push(directory)
      const listeners = new Map<string, (...args: unknown[]) => void>()
      const session = { id: 'top', header: { cwd } }
      const child = { id: 'child', header: { cwd, parentSession: 'top', delegationDepth: 1 } }
      const sent: Array<{ role: string; content: Array<{ text: string }>; source: { kind: string } }> = []
      const followup = vi.fn((message: typeof sent[number]) => { sent.push(message) })
      const host = {
        logger: {},
        on: (event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener) },
        sessions: { get: (id: string) => id === 'top' ? session : id === 'child' ? child : undefined, list: () => [session, child], flush: async () => true },
        agents: { get: (id: string) => id === 'top' ? { session, followup } : undefined },
      }
      const service = new DeepCanaryService(host as never, { stateDir: directory })
      services.push(service)
      await service.ready
      service.start()
      await service.adapter.start()
      const requested = await service.requestDecision('child', { ...valid, options })
      const answered = await service.answerDecision(requested.id, 'Keep the store')
      expect(answered.decision?.deliveryState).toBe('queued')
      expect(followup).toHaveBeenCalledTimes(1)
      expect(sent[0]).toMatchObject({ role: 'user', source: { kind: 'user' } })
      expect(sent[0]?.content[0]?.text).toMatch(/Delivery token: [0-9a-f-]{36}/)
      expect(answered.decision?.deliveryToken).toBeUndefined()
      expect(sent[0]?.content[0]?.text).toContain('idempotency key')
      const emit = (target: unknown, message: unknown) => listeners.get('session/event')?.(target, { type: 'user/message', data: message })
      emit(session, { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: requested.id }] })
      emit(session, { ...sent[0], source: { kind: 'synthetic' } })
      emit(child, sent[0])
      expect(service.decisionsFor('child')[0]?.decision?.deliveryState).toBe('queued')
      emit(session, sent[0])
      expect(service.decisionsFor('child')[0]?.decision?.deliveryState).toBe('delivered')
      await expect(service.answerDecision(requested.id, 'Again')).rejects.toThrow(/already been answered/)
      expect(followup).toHaveBeenCalledTimes(1)
      const failed = await service.requestDecision('child', { ...valid, options })
      followup.mockImplementationOnce(() => { throw new Error('send failed') })
      expect((await service.answerDecision(failed.id, 'Answer')).decision?.deliveryState).toBe('queued')
    })

    it('requests a pending decision and returns its id at once', async () => {
      const { service } = await open({ top: { cwd } })
      const requested = await service.requestDecision('top', { ...valid, options })
      expect(requested.id).toEqual(expect.any(String))
      expect(service.snapshot().inbox.map(item => item.id)).toEqual([requested.id])
      expect(service.snapshot().inbox[0]).toMatchObject({ sessionId: 'top', level: 'C2', action: 'INTERRUPT', reasonCode: 'DECISION_PENDING', notificationEligible: true })
      expect(service.snapshot().inbox[0]?.decision).toEqual({ kind: 'pending', ...valid, options, delegationDepth: 0, workingDirectory: cwd, deliveryState: 'queued' })
    })

    it('refuses a sixth option or a label past 120 characters, and stores nothing', async () => {
      const { service } = await open({ top: { cwd } })
      await expect(service.requestDecision('top', { ...valid, options: ['a', 'b', 'c', 'd', 'e', 'f'] })).rejects.toThrow('the limit is 5')
      await expect(service.requestDecision('top', { ...valid, options: ['a'.repeat(121)] })).rejects.toThrow('the limit is 120')
      expect(service.inbox(10)).toEqual([])
      const atLimit = await service.requestDecision('top', { ...valid, options: ['b'.repeat(120), 'c', 'd', 'e', 'f'] })
      expect(atLimit.decision?.options?.[0]).toHaveLength(120)
      expect(atLimit.decision?.options).toHaveLength(5)
    })

    it('keeps the option list across a restart of the same state directory', async () => {
      const headers = { top: { cwd } }
      const { service, directory } = await open(headers)
      const requested = await service.requestDecision('top', { ...valid, options })
      await service.dispose()
      const restarted = await open(headers, directory)
      expect(restarted.service.inbox(5)).toEqual([requested])
    })

    it('lets only the asking session cancel, and a cancelled decision leaves the pending view', async () => {
      const { service } = await open({ top: { cwd }, other: { cwd } })
      const requested = await service.requestDecision('top', { ...valid, options })
      expect(() => service.cancelDecision('other', requested.id)).toThrow('belongs to this session')
      const cancelled = service.cancelDecision('top', requested.id)
      expect(cancelled).toMatchObject({ id: requested.id, status: 'cancelled' })
      expect(service.snapshot().inbox).toEqual([])
      expect(service.snapshot().scheduled ?? []).toEqual([])
      expect(service.decisionsFor('top')).toEqual([cancelled])
      expect(() => service.cancelDecision('top', requested.id)).toThrow('belongs to this session')
    })

    it('refuses to cancel a made decision, and refuses seen, snooze, mute and unmute on a cancelled one', async () => {
      const { service } = await open({ top: { cwd } })
      const made = await service.recordMadeDecision('top', valid)
      const requested = await service.requestDecision('top', { ...valid, sentence: 'Use a second store.', options })
      expect(() => service.cancelDecision('top', made.id)).toThrow('belongs to this session')
      service.cancelDecision('top', requested.id)
      expect(service.seen(requested.id)).toBe(false)
      expect(service.snooze(requested.id, 15)).toBe(false)
      expect(service.mute(requested.id)).toBe(false)
      expect(service.unmute(requested.id)).toBe(false)
      expect(service.snapshot().inbox.map(item => item.id)).toEqual([made.id])
      expect(service.snapshot().scheduled ?? []).toEqual([])
    })

    it('exposes the request and cancel tools under the calling session, and refuses a call with no session', async () => {
      const { service } = await open({ top: { cwd } })
      const definitions = new Map<string, { execute: (args: unknown, exec: unknown) => Promise<unknown> }>()
      registerTools({ tools: { register: (definition: { name: string }) => definitions.set(definition.name, definition as never) } }, service)
      const request = definitions.get('deepcanary_request_decision')!
      const cancel = definitions.get('deepcanary_cancel_decision')!
      const requested = await request.execute({ ...valid, options }, { agent: { id: 'top' } }) as { id: string; status: string }
      expect(requested.status).toBe('open')
      await expect(request.execute({ ...valid, options: ['a', 'b', 'c', 'd', 'e', 'f'] }, { agent: { id: 'top' } })).rejects.toThrow('the limit is 5')
      await expect(request.execute({ ...valid, options }, {})).rejects.toThrow('belong to the calling agent session')
      expect(await cancel.execute({ id: requested.id }, { agent: { id: 'top' } })).toMatchObject({ id: requested.id, status: 'cancelled' })
    })

    it('refuses acknowledge on a pending decision, and its snooze and reminder survive the attempt', async () => {
      const { service } = await open({ top: { cwd } })
      const requested = await service.requestDecision('top', { ...valid, options })
      expect(service.snooze(requested.id, 15)).toBe(true)
      expect(service.acknowledge(requested.id)).toBe(false)
      expect(service.snapshot().scheduled?.[0]).toMatchObject({ id: requested.id, status: 'snoozed', reminderPending: true })
    })

    it('brings a snoozed pending decision back to the pending view at its reminder time', async () => {
      const { service } = await open({ top: { cwd } })
      let now = Date.parse('2026-10-29T08:00:00.000Z')
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
      try {
        const requested = await service.requestDecision('top', { ...valid, options })
        expect(service.snooze(requested.id, 5)).toBe(true)
        expect(service.snapshot().inbox).toEqual([])
        now += 5 * 60_000 + 1
        expect(service.snapshot().inbox[0]).toMatchObject({ id: requested.id, status: 'open', notificationEligible: true })
      } finally {
        clock.mockRestore()
      }
    })

    it('never expires a pending decision, while an attention item of the same session does', async () => {
      vi.useFakeTimers()
      const directory = await mkdtemp(path.join(os.tmpdir(), 'deepcanary-decision-expiry-'))
      directories.push(directory)
      vi.setSystemTime(new Date('2026-10-29T00:00:00.000Z'))
      try {
        const first = new DeepCanaryService(hostWith({ top: { cwd } }) as never, { stateDir: directory })
        services.push(first)
        await first.ready
        const requested = await first.requestDecision('top', { ...valid, options })
        const question = await first.ingest({
          schemaVersion: 1,
          id: 'question-1',
          occurredAt: '2026-10-29T00:00:00.000Z',
          source: 'session',
          kind: 'HUMAN_QUESTION_PENDING',
          sessionId: 'top',
          severityHint: 3,
          evidence: [{ type: 'session-event', authority: 'host', ref: 'question', summary: 'the agent is waiting for an answer' }],
          dedupeKey: 'question:top',
          data: {},
        })
        expect(question).toBeDefined()
        await first.dispose()

        const second = new DeepCanaryService({ logger: {}, sessions: { list: () => [] } } as never, { stateDir: directory })
        services.push(second)
        await second.ready
        second.start()
        await second.adapter.start()
        second.inbox(10)
        vi.advanceTimersByTime(31_000)
        await Promise.resolve()
        const items = second.inbox(10)
        expect(items.find(item => item.id === question?.id)).toMatchObject({ status: 'expired' })
        expect(items.find(item => item.id === requested.id)).toMatchObject({ status: 'open', targetAvailable: false })
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
