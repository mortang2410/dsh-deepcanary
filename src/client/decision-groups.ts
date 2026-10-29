import { workingDirectoryBasename } from './session-navigation.js'
import type { SessionListSnapshot, SessionSummary } from './session-navigation.js'

export type DecisionFilter = 'all' | 'pending' | 'made' | 'reviewed' | 'disputed'

export interface DecisionGroupingEntry {
  id: string
  sessionId?: string
  occurredAt: string
  decision?: {
    kind: 'pending' | 'made'
    reviewState?: 'unreviewed' | 'reviewed' | 'disputed'
    answer?: string
    parentSessionId?: string
    delegationDepth?: number
    workingDirectory?: string
    sessionUnavailable?: boolean
  }
}

export interface DecisionSessionGroup<TItem extends DecisionGroupingEntry = DecisionGroupingEntry> {
  sessionId: string
  depth: number
  title: string
  workingDirectory?: string
  items: TItem[]
  children: DecisionSessionGroup<TItem>[]
}

export function showsAttentionItems(filter: DecisionFilter): boolean {
  return filter === 'all' || filter === 'pending'
}

export function filterInboxItems<TItem extends DecisionGroupingEntry>(items: readonly TItem[], filter: DecisionFilter): TItem[] {
  if (filter === 'all') return [...items]
  return items.filter(item => {
    if (item.decision === undefined) return showsAttentionItems(filter)
    if (filter === 'pending') return item.decision.kind === 'pending' && item.decision.answer === undefined
    const reviewState = item.decision.reviewState ?? 'unreviewed'
    if (filter === 'made') return item.decision.kind === 'made' && reviewState === 'unreviewed'
    return item.decision.kind === 'made' && reviewState === filter
  })
}

export interface FilteredDecisionLists<TItem extends DecisionGroupingEntry> {
  activeFilter: DecisionFilter
  hasDecisions: boolean
  inbox: TItem[]
  scheduled: TItem[]
}

export function filterDecisionLists<TItem extends DecisionGroupingEntry>(
  inbox: readonly TItem[],
  scheduled: readonly TItem[],
  filter: DecisionFilter,
  selectedId?: string,
): FilteredDecisionLists<TItem> {
  const allItems = [...inbox, ...scheduled]
  const hasDecisions = allItems.some(item => item.decision !== undefined)
  const selectedVisible = selectedId === undefined || filterInboxItems(allItems, filter).some(item => item.id === selectedId)
  const activeFilter = !hasDecisions || !selectedVisible ? 'all' : filter
  return {
    activeFilter,
    hasDecisions,
    inbox: filterInboxItems(inbox, activeFilter),
    scheduled: filterInboxItems(scheduled, activeFilter),
  }
}

export type DecisionListBlock<TItem extends DecisionGroupingEntry = DecisionGroupingEntry> =
  | { kind: 'attention'; item: TItem }
  | { kind: 'group'; group: DecisionSessionGroup<TItem> }

function collectGroupItems<TItem extends DecisionGroupingEntry>(
  current: DecisionSessionGroup<TItem>,
  root: DecisionSessionGroup<TItem>,
  groupsByItem: Map<string, DecisionSessionGroup<TItem>>,
): void {
  for (const item of current.items) groupsByItem.set(item.id, root)
  for (const child of current.children) collectGroupItems(child, root, groupsByItem)
}

export function orderDecisionBlocks<TItem extends DecisionGroupingEntry>(
  items: readonly TItem[],
  groups: readonly DecisionSessionGroup<TItem>[],
): DecisionListBlock<TItem>[] {
  const groupsByItem = new Map<string, DecisionSessionGroup<TItem>>()
  for (const group of groups) collectGroupItems(group, group, groupsByItem)

  const emittedGroups = new Set<DecisionSessionGroup<TItem>>()
  const blocks: DecisionListBlock<TItem>[] = []
  for (const item of items) {
    if (item.decision === undefined) {
      blocks.push({ kind: 'attention', item })
      continue
    }
    const group = groupsByItem.get(item.id)
    if (group === undefined) throw new Error(`Decision item ${item.id} has no rendered session group`)
    if (emittedGroups.has(group)) continue
    emittedGroups.add(group)
    blocks.push({ kind: 'group', group })
  }
  return blocks
}

function parentMapFor(items: readonly DecisionGroupingEntry[], summaries: Readonly<Record<string, SessionSummary>>): Map<string, string> {
  const parents = new Map<string, string>()
  for (const [id, summary] of Object.entries(summaries)) {
    if (summary.origin === 'subagent' && summary.parentId !== undefined) parents.set(id, summary.parentId)
  }
  for (const item of items) {
    const decision = item.decision
    if (item.sessionId !== undefined && decision?.parentSessionId !== undefined
      && decision.delegationDepth !== undefined && decision.delegationDepth > 0 && !parents.has(item.sessionId)) {
      parents.set(item.sessionId, decision.parentSessionId)
    }
  }
  return parents
}

function rootSessionId(sessionId: string, parents: ReadonlyMap<string, string>): string {
  let root = sessionId
  const seen = new Set([root])
  while (true) {
    const parent = parents.get(root)
    if (parent === undefined || seen.has(parent)) return root
    root = parent
    seen.add(root)
  }
}

function sessionDepth(sessionId: string, rootId: string, parents: ReadonlyMap<string, string>): number {
  let depth = 0
  let current = sessionId
  const seen = new Set([current])
  while (current !== rootId) {
    const parent = parents.get(current)
    if (parent === undefined || seen.has(parent)) return depth
    current = parent
    seen.add(current)
    depth++
  }
  return depth
}

function compareEntries(left: DecisionGroupingEntry, right: DecisionGroupingEntry): number {
  const leftTime = Date.parse(left.occurredAt)
  const rightTime = Date.parse(right.occurredAt)
  const chronological = (Number.isFinite(leftTime) ? leftTime : 0) - (Number.isFinite(rightTime) ? rightTime : 0)
  return chronological || left.id.localeCompare(right.id)
}

function earliestEntry<TItem extends DecisionGroupingEntry>(group: DecisionSessionGroup<TItem>): number {
  const own = group.items[0]
  const ownTime = own === undefined ? Number.POSITIVE_INFINITY : Date.parse(own.occurredAt)
  return Math.min(Number.isFinite(ownTime) ? ownTime : Number.POSITIVE_INFINITY, ...group.children.map(earliestEntry))
}

function makeSessionGroup<TItem extends DecisionGroupingEntry>(
  sessionId: string,
  depth: number,
  items: TItem[],
  summaries: Readonly<Record<string, SessionSummary>>,
): DecisionSessionGroup<TItem> {
  const summary = summaries[sessionId]
  const ownDirectory = items.find(item => item.decision?.workingDirectory !== undefined)?.decision?.workingDirectory
  const workingDirectory = summary?.cwd || ownDirectory
  const title = summary?.title?.trim() || workingDirectoryBasename(workingDirectory) || sessionId
  return {
    sessionId,
    depth,
    title,
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
    items: [...items].sort(compareEntries),
    children: [],
  }
}

export function groupDecisionItems<TItem extends DecisionGroupingEntry>(
  items: readonly TItem[],
  sessionList?: Pick<SessionListSnapshot, 'byId'>,
): DecisionSessionGroup<TItem>[] {
  const summaries = sessionList?.byId ?? {}
  const parents = parentMapFor(items, summaries)
  const entriesByRoot = new Map<string, Map<string, TItem[]>>()

  for (const item of items) {
    const sessionId = item.sessionId ?? `unavailable:${item.id}`
    const rootId = rootSessionId(sessionId, parents)
    let entriesBySession = entriesByRoot.get(rootId)
    if (entriesBySession === undefined) {
      entriesBySession = new Map()
      entriesByRoot.set(rootId, entriesBySession)
    }
    const entries = entriesBySession.get(sessionId) ?? []
    entries.push(item)
    entriesBySession.set(sessionId, entries)
  }

  const roots: DecisionSessionGroup<TItem>[] = []
  for (const [rootId, entriesBySession] of entriesByRoot) {
    const rootEntries = entriesBySession.get(rootId) ?? []
    const root = makeSessionGroup(rootId, 0, rootEntries, summaries)
    const groupsBySession = new Map<string, DecisionSessionGroup<TItem>>([[rootId, root]])
    for (const [sessionId, entries] of entriesBySession) {
      if (sessionId === rootId) continue
      const recordedDepths = entries.map(item => item.decision?.delegationDepth)
        .filter((depth): depth is number => typeof depth === 'number' && Number.isSafeInteger(depth) && depth >= 0)
      const depth = recordedDepths.length > 0
        ? Math.max(...recordedDepths)
        : sessionDepth(sessionId, rootId, parents)
      groupsBySession.set(sessionId, makeSessionGroup(sessionId, depth, entries, summaries))
    }

    for (const [sessionId, group] of groupsBySession) {
      if (sessionId === rootId) continue
      let parentId = parents.get(sessionId)
      let parent = parentId === undefined ? undefined : groupsBySession.get(parentId)
      const seen = new Set([sessionId])
      while (parent === undefined && parentId !== undefined && parentId !== rootId && !seen.has(parentId)) {
        seen.add(parentId)
        parentId = parents.get(parentId)
        parent = parentId === undefined ? undefined : groupsBySession.get(parentId)
      }
      const destination = parent ?? root
      destination.children.push(group)
    }

    const sortChildren = (group: DecisionSessionGroup<TItem>): void => {
      group.children.sort((left, right) => left.depth - right.depth
        || earliestEntry(left) - earliestEntry(right)
        || left.sessionId.localeCompare(right.sessionId))
      for (const child of group.children) sortChildren(child)
    }
    sortChildren(root)
    roots.push(root)
  }

  roots.sort((left, right) => earliestEntry(left) - earliestEntry(right) || left.sessionId.localeCompare(right.sessionId))
  return roots
}
