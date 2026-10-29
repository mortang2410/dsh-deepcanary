import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadRuntime } from './runtime-checkout.mjs'

// A real Context and the host's real SessionStore from the selected runtime. No model runs;
// the sessions are controlled, and the decision tools are invoked through their definitions.
const runtime = await loadRuntime(process.env.DSH_RUNTIME)
const { Context } = await runtime.importPackage('@deepseek-ai/cordis')
const { SessionStore } = await runtime.importPackage('@deepseek-ai/dsh-session')
const { DeepCanaryService } = await import('../lib/service.js')
const { registerTools } = await import('../lib/tools.js')

const directory = await mkdtemp(path.join(process.env.DEEPCANARY_TEST_TMP ?? os.tmpdir(), 'deepcanary-decision-contract-'))
const ctx = new Context()
const fibers = []
const detachers = []
const definitions = new Map()
const checks = {}
let service
const tool = name => definitions.get(name)
const bindTools = () => registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, service)
const valid = {
  sentence: 'Keep the existing store.',
  explanation: 'The store already persists inbox items, so a second table would duplicate it.',
  alternatives: 'A separate decisions file was considered and rejected for the reason above.',
  blastRadius: 'Only the inbox persistence path.',
}

function openSession(id, meta) {
  const session = ctx.sessions.prepare(id, { meta })
  detachers.push(ctx.sessions.enter(session))
  ctx.sessions.announce(session)
  return session
}

try {
  fibers.push(await ctx.plugin(SessionStore))
  const parent = openSession('controlled-decision-owner', { cwd: directory })
  const child = openSession('controlled-decision-subagent', {
    cwd: directory, parentSession: parent.id, origin: 'subagent', delegationDepth: 1,
  })
  service = new DeepCanaryService(ctx, { stateDir: directory })
  await service.ready
  bindTools()

  const recorded = await tool('deepcanary_record_decision').execute(valid, { agent: { id: parent.id } })
  assert.equal(typeof recorded.id, 'string')
  assert.equal(recorded.decision.workingDirectory, directory)
  assert.equal(recorded.decision.delegationDepth, 0)
  checks.recordedReturnsId = true

  const subagent = await tool('deepcanary_record_decision').execute({ ...valid, sentence: 'A subagent choice.' }, { agent: { id: child.id } })
  assert.equal(subagent.decision.parentSessionId, parent.id)
  assert.equal(subagent.decision.delegationDepth, 1)
  checks.lineageReadFromHostHeader = true

  assert.deepEqual((await tool('deepcanary_inbox').execute({ limit: 10 }, {})).find(item => item.id === recorded.id), recorded)
  checks.readableThroughInboxTool = true

  assert.deepEqual(await tool('deepcanary_list_decisions').execute({}, { agent: { id: parent.id } }), [recorded])
  checks.listScopedToCallingSession = true

  await assert.rejects(
    tool('deepcanary_record_decision').execute({ ...valid, explanation: 'x'.repeat(4001) }, { agent: { id: parent.id } }),
    /the limit is 4000/,
  )
  assert.equal(service.inbox(20).length, 2)
  checks.overBoundRefusedAndNothingStored = true

  const before = service.inbox(20)
  await service.dispose()
  service = new DeepCanaryService(ctx, { stateDir: directory })
  await service.ready
  bindTools()
  assert.deepEqual(service.inbox(20), before)
  checks.survivesRestart = true

  console.log(JSON.stringify({ passed: true, runtimeVersion: runtime.version, checks }, null, 2))
} finally {
  await service?.dispose()
  for (const detach of detachers.reverse()) detach()
  for (const fiber of fibers.reverse()) await fiber.dispose()
  await rm(directory, { recursive: true, force: true })
}
