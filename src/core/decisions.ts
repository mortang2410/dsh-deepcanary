/** Bounds for decision text, in characters. Content past a bound is refused, never truncated. */
export const DECISION_LIMITS = {
  sentence: 200,
  explanation: 4000,
  alternatives: 4000,
  blastRadius: 2000,
  sessionTitle: 200,
  workingDirectory: 500,
} as const

export type DecisionTextField = keyof typeof DECISION_LIMITS

const labels: Record<DecisionTextField, string> = {
  sentence: 'decision sentence',
  explanation: 'explanation',
  alternatives: 'alternatives',
  blastRadius: 'blast radius',
  sessionTitle: 'session title',
  workingDirectory: 'working directory',
}

/** Fields rendered on one line; their control characters include the line breaks. */
const singleLineFields = new Set<DecisionTextField>(['sentence', 'sessionTitle', 'workingDirectory'])
const singleLineControl = /[\u0000-\u001f\u007f]/
const multiLineControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

export interface MadeDecisionText {
  sentence: string
  explanation: string
  alternatives: string
  blastRadius: string
}

/**
 * Check one decision text field and return it unchanged. A required field refuses
 * when absent or blank; an optional field returns undefined when absent or blank.
 * Every refusal names the field and the limit, and nothing is stored.
 */
export function boundedDecisionText(field: DecisionTextField, value: unknown, required: true): string
export function boundedDecisionText(field: DecisionTextField, value: unknown, required: false): string | undefined
export function boundedDecisionText(field: DecisionTextField, value: unknown, required: boolean): string | undefined {
  const label = labels[field]
  if (value === undefined) {
    if (required) throw new TypeError(`${label} is required; nothing was recorded`)
    return undefined
  }
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string; nothing was recorded`)
  if (value.trim().length === 0) {
    if (required) throw new TypeError(`${label} must not be blank; nothing was recorded`)
    return undefined
  }
  const length = [...value].length
  if (length > DECISION_LIMITS[field]) {
    throw new RangeError(`${label} is ${length} characters; the limit is ${DECISION_LIMITS[field]}. Shorten it and record again; nothing was truncated or recorded`)
  }
  const control = singleLineFields.has(field) ? singleLineControl : multiLineControl
  if (control.test(value)) throw new TypeError(`${label} contains a control character; nothing was recorded`)
  return value
}

/** Validate every text field of a made decision. All four are required. */
export function madeDecisionText(input: { sentence: unknown; explanation: unknown; alternatives: unknown; blastRadius: unknown }): MadeDecisionText {
  return {
    sentence: boundedDecisionText('sentence', input.sentence, true),
    explanation: boundedDecisionText('explanation', input.explanation, true),
    alternatives: boundedDecisionText('alternatives', input.alternatives, true),
    blastRadius: boundedDecisionText('blastRadius', input.blastRadius, true),
  }
}
