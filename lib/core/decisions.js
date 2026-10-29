/** Bounds for decision text, in characters. Content past a bound is refused, never truncated. */
export const DECISION_LIMITS = {
    sentence: 200,
    explanation: 4000,
    alternatives: 4000,
    blastRadius: 2000,
    sessionTitle: 200,
    workingDirectory: 500,
};
const labels = {
    sentence: 'decision sentence',
    explanation: 'explanation',
    alternatives: 'alternatives',
    blastRadius: 'blast radius',
    sessionTitle: 'session title',
    workingDirectory: 'working directory',
};
/** Fields rendered on one line; their control characters include the line breaks. */
const singleLineFields = new Set(['sentence', 'sessionTitle', 'workingDirectory']);
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
/** Validate every text field of a made decision. All four are required. */
export function madeDecisionText(input) {
    return {
        sentence: boundedDecisionText('sentence', input.sentence, true),
        explanation: boundedDecisionText('explanation', input.explanation, true),
        alternatives: boundedDecisionText('alternatives', input.alternatives, true),
        blastRadius: boundedDecisionText('blastRadius', input.blastRadius, true),
    };
}
//# sourceMappingURL=decisions.js.map