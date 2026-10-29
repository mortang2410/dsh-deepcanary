import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadRuntime } from './runtime-checkout.mjs'

// A real Context and the host's real SessionStore from the selected runtime. No model runs;
// the sessions are controlled, and the decision tools are invoked through their definitions.
const runtime = await loadRuntime(process.env.DSH_RUNTIME)
const { Context } = await runtime.importPackage('@deepseek-ai/cordis')
const { SessionStore } = await runtime.importPackage('@deepseek-ai/dsh-session')
const { AgentRegistry } = await runtime.importPackage('@deepseek-ai/dsh-agent')
const { CredentialProvider } = await runtime.importPackage('@deepseek-ai/dsh-credentials')
const { default: WebServer } = await runtime.importPackage('@deepseek-ai/dsh-host-webserver')
const connectionPlugin = await runtime.importPackage('@deepseek-ai/dsh-client-connection')
const { DeepCanaryService } = await import('../lib/service.js')
const { registerTools } = await import('../lib/tools.js')
const { installWebRoutes } = await import('../lib/web.js')
// Test-only credential store, the same as connection-contract: no real secret is involved.
class TestCredentials extends CredentialProvider {
  records = new Map()
  async modifyRecord(key, mutate) {
    const value = await mutate(this.records.get(key))
    if (value === undefined) this.records.delete(key)
    else this.records.set(key, value)
    return value
  }
}

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
  fibers.push(await ctx.plugin(AgentRegistry))
  ctx.provide('profileContext', { name: 'contract', dir: directory, home: directory })
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
  fibers.push(await ctx.plugin({ name: 'decision-contract-scoped-service', inject: ['sessions', 'profileContext'], apply(scopedCtx) {
    service = new DeepCanaryService(scopedCtx, { stateDir: directory })
  } }))
  await service.ready
  bindTools()
  assert.deepEqual(service.inbox(20), before)
  checks.survivesRestart = true

  // The restarted service, read through the authenticated state route: a pending decision
  // appears with its owner and options, and leaves the view once it is cancelled.
  fibers.push(await ctx.plugin(TestCredentials))
  fibers.push(await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }))
  fibers.push(await ctx.plugin(connectionPlugin, { maxRequestBodyBytes: 64_000 }))
  fibers.push(await ctx.plugin(pluginCtx => installWebRoutes(pluginCtx, service)))
  const base = `http://127.0.0.1:${ctx.webServer.port}`
  const disposeIndex = ctx.webServer.register({ kind: 'exact', path: '/', handler: (req, res) => {
    if (ctx.connection.authorizeIndex(req, res)) { res.statusCode = 200; res.end('test index') }
  } })
  const exchange = await fetch(ctx.connection.authenticatedUrl(`${base}/`), { redirect: 'manual' })
  const cookie = exchange.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  disposeIndex()
  const headers = { cookie }
  const readInbox = async () => {
    const response = await fetch(`${base}/api/dsh-deepcanary/state`, { headers })
    assert.equal(response.status, 200)
    return (await response.json()).inbox
  }
  const requested = await tool('deepcanary_request_decision').execute(
    { ...valid, options: ['Keep the store', 'Split the store'] },
    { agent: { id: parent.id } },
  )
  const entry = (await readInbox()).find(item => item.id === requested.id)
  assert.equal(entry?.sessionId, parent.id)
  assert.equal(entry?.decision?.kind, 'pending')
  assert.deepEqual(entry?.decision?.options, ['Keep the store', 'Split the store'])
  checks.pendingReadThroughAuthenticatedRoute = true
  const cancelled = await tool('deepcanary_cancel_decision').execute({ id: requested.id }, { agent: { id: parent.id } })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal((await readInbox()).some(item => item.id === requested.id), false)
  checks.pendingCancelLeavesView = true

  service.start()
  await service.adapter.start()
  const sent = []
  const detachAgent = ctx.agents.enter({ id: parent.id, session: parent, ctx, followup(message) { sent.push(message) } })
  detachers.push(detachAgent)
  const answerRequest = async (id, answer) => fetch(`${base}/api/dsh-deepcanary/decision/answer`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ id, answer }),
  })
  const unauthenticated = await fetch(`${base}/api/dsh-deepcanary/decision/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'none', answer: 'none' }),
  })
  assert.equal(unauthenticated.status, 401)
  checks.answerRouteRequiresAuthentication = true
  const pending = await tool('deepcanary_request_decision').execute(
    { ...valid, options: ['Keep the store'] }, { agent: { id: child.id } },
  )
  assert.equal((await readInbox()).find(item => item.id === pending.id).decision.deliveryState, 'queued')
  checks.queuedBeforeAnswer = true
  const tooLong = await answerRequest(pending.id, 'x'.repeat(8001))
  assert.equal(tooLong.status, 400)
  assert.match((await tooLong.json()).error, /8000/)
  assert.equal(sent.length, 0)
  checks.overlongAnswerRefused = true
  const response = await answerRequest(pending.id, 'Keep the store')
  assert.equal(response.status, 200)
  const answered = (await response.json()).item
  assert.equal(answered.decision.deliveryState, 'queued')
  assert.equal(answered.decision.deliveryToken, undefined)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].role, 'user')
  assert.equal(sent[0].source.kind, 'user')
  const deliveredText = sent[0].content.find(block => block.type === 'text').text
  assert.match(deliveredText, /Delivery token: [0-9a-f-]{36}/)
  assert.match(deliveredText, /idempotency key/)
  assert.ok(deliveredText.includes(pending.id) && deliveredText.includes(valid.sentence) && deliveredText.includes('Keep the store'))
  checks.tokenMessageReachedParentCaptureAgent = true
  parent.append('user/message', { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: pending.id }] }, { surfaceOp: 'append' })
  assert.equal((await readInbox()).find(item => item.id === pending.id).decision.deliveryState, 'queued')
  checks.idAloneDoesNotMarkDelivered = true
  parent.append('user/message', sent[0], { surfaceOp: 'append' })
  assert.equal((await readInbox()).find(item => item.id === pending.id).decision.deliveryState, 'delivered')
  checks.observedTokenMarksDelivered = true
  const repeated = await answerRequest(pending.id, 'Different answer')
  assert.equal(repeated.status, 400)
  assert.match((await repeated.json()).error, /already been answered/)
  assert.equal(sent.length, 1)
  checks.secondAnswerRefused = true
  detachers.pop()()
  const offline = await tool('deepcanary_request_decision').execute(
    { ...valid, options: [] }, { agent: { id: parent.id } },
  )
  assert.equal((await answerRequest(offline.id, 'Queued answer')).status, 200)
  assert.equal((await readInbox()).find(item => item.id === offline.id).decision.deliveryState, 'queued')
  assert.equal(sent.length, 1)
  checks.nonLiveTargetStaysQueued = true

  console.log(JSON.stringify({ passed: true, runtimeVersion: runtime.version, checks }, null, 2))
} finally {
  await service?.dispose()
  for (const detach of detachers.reverse()) detach()
  for (const fiber of fibers.reverse()) await fiber.dispose()
  await rm(directory, { recursive: true, force: true })
}
