import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { loadRuntime } from './runtime-checkout.mjs'

// A real Context and the host's real SessionStore from the selected runtime. No model runs;
// the sessions are controlled, and the decision tools are invoked through their definitions.
const runtime = await loadRuntime(process.env.DSH_RUNTIME)
const { Context } = await runtime.importPackage('@deepseek-ai/cordis')
const { SessionStore } = await runtime.importPackage('@deepseek-ai/dsh-session')
const { AgentRegistry } = await runtime.importPackage('@deepseek-ai/dsh-agent')
const { default: JsonlSessionPersistence } = await runtime.importPackage('@deepseek-ai/dsh-session-persistence-jsonl')
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
async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await delay(10)
  assert.ok(predicate(), label)
}
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
  // The host's real persistence backend is isolated under this contract's temporary root.
  fibers.push(await ctx.plugin(JsonlSessionPersistence, { root: path.join(directory, 'sessions'), compression: 'none' }))
  const parent = openSession('controlled-decision-owner', { cwd: directory })
  const child = openSession('controlled-decision-subagent', {
    cwd: directory, parentSession: parent.id, origin: 'subagent', delegationDepth: 1,
  })
  for (const session of [parent, child]) {
    const handle = await ctx.sessionPersistence.create(session.header)
    await handle.flush()
    await handle.close()
  }
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
  let routesFiber = await ctx.plugin(pluginCtx => installWebRoutes(pluginCtx, service))
  fibers.push(routesFiber)
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
  const seed = parent.snapshotEvents()
  detachers.splice(0, 1)[0]()
  assert.equal(ctx.sessions.get(parent.id), undefined)
  assert.equal((await answerRequest(offline.id, 'Queued answer')).status, 200)
  assert.equal((await readInbox()).find(item => item.id === offline.id).decision.deliveryState, 'queued')
  assert.equal(sent.length, 1)
  checks.nonLiveTargetStaysQueued = true

  // Recreate the host publication order used on resume: the session and agent are
  // entered before the session announcement. The old stream is the resume seed.
  const resumed = ctx.sessions.prepare(parent.id, { meta: { cwd: directory }, seed })
  detachers.push(ctx.sessions.enter(resumed))
  const capture = { id: resumed.id, session: resumed, ctx, inbox: { nextTurn: [] }, followup(message) { sent.push(message) } }
  detachers.push(ctx.agents.enter(capture))
  ctx.sessions.announce(resumed)
  await service.adapter.reconcile()
  await waitFor(() => sent.length === 2, 'queued answer did not reach the resumed session')
  await service.adapter.reconcile()
  // Let the reconciliation callback enter its asynchronous flush before draining it.
  await Promise.resolve()
  await service.dispose()
  assert.equal(sent.length, 2)
  checks.resumeAndConcurrentReconcileDeliverOnce = true

  // The delivery reaches the session stream while this plugin is stopped, so
  // its persisted in-flight claim must be reconciled without another send.
  resumed.append('user/message', sent[1], { surfaceOp: 'append' })
  fibers.splice(fibers.indexOf(routesFiber), 1)
  await routesFiber.dispose()
  service = new DeepCanaryService(ctx, { stateDir: directory })
  await service.ready
  bindTools()
  service.start()
  await service.adapter.start()
  routesFiber = await ctx.plugin(pluginCtx => installWebRoutes(pluginCtx, service))
  fibers.push(routesFiber)
  await waitFor(() => service.decisionsFor(parent.id).find(item => item.id === offline.id)?.decision?.deliveryState === 'delivered', 'restart did not observe token')
  assert.equal(sent.length, 2)
  checks.restartObservesTokenWithoutResending = true

  // Review and dispute both ownership routes through the authenticated API.
  const postDecision = (action, payload) => fetch(`${base}/api/dsh-deepcanary/decision/${action}`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(payload),
  })
  const review = await postDecision('review', { id: recorded.id })
  assert.equal(review.status, 200)
  assert.equal((await review.json()).item.decision.reviewState, 'reviewed')
  checks.madeDecisionReviewed = true
  const topDispute = await postDecision('dispute', { id: recorded.id, text: 'Reconsider the top-level decision.' })
  assert.equal(topDispute.status, 200)
  assert.equal((await topDispute.json()).item.decision.reviewState, 'disputed')
  assert.equal(sent.length, 3)
  assert.match(sent[2].content[0].text, /already applied.*disagrees/i)
  assert.ok(sent[2].content[0].text.includes(recorded.id))
  resumed.append('user/message', sent[2], { surfaceOp: 'append' })
  assert.equal((await readInbox()).find(item => item.id === recorded.id).decision.deliveryState, 'delivered')
  checks.topLevelDisputeDeliveredAndObserved = true
  const childDispute = await postDecision('dispute', { id: subagent.id, text: 'Reconsider the subagent decision.' })
  assert.equal(childDispute.status, 200)
  assert.equal(sent.length, 4)
  assert.ok(sent[3].content[0].text.includes(subagent.id) && sent[3].content[0].text.includes(child.id))
  resumed.append('user/message', sent[3], { surfaceOp: 'append' })
  assert.equal((await readInbox()).find(item => item.id === subagent.id).decision.deliveryState, 'delivered')
  checks.subagentDisputeRoutedToParent = true

  const offlineMade = await tool('deepcanary_record_decision').execute({ ...valid, sentence: 'An offline made decision.' }, { agent: { id: resumed.id } })
  const offlineSeed = resumed.snapshotEvents()
  detachers.pop()()
  detachers.pop()()
  const queuedDispute = await postDecision('dispute', { id: offlineMade.id, text: 'Reconsider while offline.' })
  assert.equal(queuedDispute.status, 200)
  assert.equal((await queuedDispute.json()).item.decision.deliveryState, 'queued')
  assert.equal(sent.length, 4)
  const resumedAgain = ctx.sessions.prepare(parent.id, { meta: { cwd: directory }, seed: offlineSeed })
  detachers.push(ctx.sessions.enter(resumedAgain))
  detachers.push(ctx.agents.enter({ id: resumedAgain.id, session: resumedAgain, ctx, inbox: { nextTurn: [] }, followup(message) { sent.push(message) } }))
  ctx.sessions.announce(resumedAgain)
  await service.adapter.reconcile()
  await waitFor(() => sent.length === 5, 'queued disagreement did not reach the resumed session')
  await service.adapter.reconcile()
  await service.dispose()
  assert.equal(sent.length, 5)
  assert.ok(sent[4].content[0].text.includes(offlineMade.id))
  resumedAgain.append('user/message', sent[4], { surfaceOp: 'append' })
  fibers.splice(fibers.indexOf(routesFiber), 1)
  await routesFiber.dispose()
  service = new DeepCanaryService(ctx, { stateDir: directory })
  await service.ready
  bindTools()
  service.start()
  await service.adapter.start()
  routesFiber = await ctx.plugin(pluginCtx => installWebRoutes(pluginCtx, service))
  fibers.push(routesFiber)
  await waitFor(() => service.decisionsFor(parent.id).find(item => item.id === offlineMade.id)?.decision?.deliveryState === 'delivered', 'restart did not observe disputed token')
  assert.equal(sent.length, 5)
  checks.offlineDisputeDeliveredOnce = true

  // This session is deliberately not materialized; after detachment the real
  // backend reports it absent, unlike the retained owner above.
  const missingSession = openSession('controlled-missing-session', { cwd: directory })
  const missing = await tool('deepcanary_request_decision').execute(
    { ...valid, sentence: 'A decision whose session is removed.', options: [] }, { agent: { id: missingSession.id } },
  )
  const missingMade = await tool('deepcanary_record_decision').execute(
    { ...valid, sentence: 'A made decision whose session is removed.' }, { agent: { id: missingSession.id } },
  )
  detachers.pop()()
  assert.equal(await ctx.sessionPersistence.stat(missingSession.id), undefined)
  const refused = await answerRequest(missing.id, 'Cannot deliver')
  assert.equal(refused.status, 400)
  assert.match((await refused.json()).error, /unavailable/i)
  const unavailable = (await readInbox()).find(item => item.id === missing.id)
  assert.equal(unavailable?.decision?.sessionUnavailable, true)
  assert.equal(unavailable?.decision?.sentence, missing.decision.sentence)
  checks.deletedTargetRefusedAndRetained = true
  const refusedDispute = await postDecision('dispute', { id: missingMade.id, text: 'Cannot deliver' })
  assert.equal(refusedDispute.status, 400)
  assert.match((await refusedDispute.json()).error, /unavailable/i)
  const unavailableMade = (await readInbox()).find(item => item.id === missingMade.id)
  assert.equal(unavailableMade?.decision?.sessionUnavailable, true)
  assert.equal(unavailableMade?.decision?.sentence, missingMade.decision.sentence)
  assert.equal(unavailableMade?.decision?.reviewState, 'unreviewed')
  const deleteMade = await postDecision('delete', { id: missingMade.id })
  assert.equal(deleteMade.status, 200)
  checks.missingDisputeRefusedRetainedAndDeleted = true
  const deletion = await fetch(`${base}/api/dsh-deepcanary/decision/delete`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ id: missing.id }),
  })
  assert.equal(deletion.status, 200)
  assert.equal((await readInbox()).some(item => item.id === missing.id), false)
  checks.unavailableDecisionDeletedExplicitly = true

  console.log(JSON.stringify({ passed: true, runtimeVersion: runtime.version, checks }, null, 2))
} finally {
  await service?.dispose()
  for (const detach of detachers.reverse()) detach()
  for (const fiber of fibers.reverse()) await fiber.dispose()
  await rm(directory, { recursive: true, force: true })
}
