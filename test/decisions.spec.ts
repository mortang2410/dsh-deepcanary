import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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

describe('made decisions', () => {
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
})
