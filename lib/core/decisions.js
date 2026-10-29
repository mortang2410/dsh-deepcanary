/** Bounds for decision text, in characters. Content past a bound is refused, never truncated. */
export const DECISION_LIMITS = {
    sentence: 200,
    explanation: 4000,
    alternatives: 4000,
    blastRadius: 2000,
    sessionTitle: 200,
    workingDirectory: 500,
    optionLabel: 120,
    answer: 8000,
    disputeText: 2000,
};
/** A pending decision offers at most this many options. */
export const MAX_DECISION_OPTIONS = 5;
const labels = {
    sentence: 'decision sentence',
    explanation: 'explanation',
    alternatives: 'alternatives',
    blastRadius: 'blast radius',
    sessionTitle: 'session title',
    workingDirectory: 'working directory',
    optionLabel: 'option label',
    answer: 'answer',
    disputeText: 'disagreement',
};
/** Fields rendered on one line; their control characters include the line breaks. */
const singleLineFields = new Set(['sentence', 'sessionTitle', 'workingDirectory', 'optionLabel']);
const singleLineControl = /[\u0000-\u001f\u007f]/;
const multiLineControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
export function boundedDecisionText(field, value, required) {
    const label = labels[field];
    if (value === undefined) {
        if (required)
            throw new TypeError(`${label} is required; nothing was recorded`);
        return undefined;
    }
    if (typeof value !== 'string')
        throw new TypeError(`${label} must be a string; nothing was recorded`);
    if (value.trim().length === 0) {
        if (required)
            throw new TypeError(`${label} must not be blank; nothing was recorded`);
        return undefined;
    }
    const length = [...value].length;
    if (length > DECISION_LIMITS[field]) {
        throw new RangeError(`${label} is ${length} characters; the limit is ${DECISION_LIMITS[field]}. Shorten it and record again; nothing was truncated or recorded`);
    }
    const control = singleLineFields.has(field) ? singleLineControl : multiLineControl;
    if (control.test(value))
        throw new TypeError(`${label} contains a control character; nothing was recorded`);
    return value;
}
/** Validate the four text fields of a decision. All four are required. */
export function decisionText(input) {
    return {
        sentence: boundedDecisionText('sentence', input.sentence, true),
        explanation: boundedDecisionText('explanation', input.explanation, true),
        alternatives: boundedDecisionText('alternatives', input.alternatives, true),
        blastRadius: boundedDecisionText('blastRadius', input.blastRadius, true),
    };
}
/**
 * Validate the options a pending decision offers: a list of at most five labels, each
 * at most 120 characters. Zero options are allowed. Nothing is truncated or dropped.
 */
export function decisionOptions(value) {
    if (value === undefined)
        throw new TypeError('options is required; nothing was recorded');
    if (!Array.isArray(value))
        throw new TypeError('options must be a list; nothing was recorded');
    if (value.length > MAX_DECISION_OPTIONS) {
        throw new RangeError(`options has ${value.length} entries; the limit is ${MAX_DECISION_OPTIONS}. Remove the extra options and ask again; nothing was truncated or recorded`);
    }
    return value.map(label => boundedDecisionText('optionLabel', label, true));
}
//# sourceMappingURL=decisions.js.map