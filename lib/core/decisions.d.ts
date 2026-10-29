/** Bounds for decision text, in characters. Content past a bound is refused, never truncated. */
export declare const DECISION_LIMITS: {
    readonly sentence: 200;
    readonly explanation: 4000;
    readonly alternatives: 4000;
    readonly blastRadius: 2000;
    readonly sessionTitle: 200;
    readonly workingDirectory: 500;
};
export type DecisionTextField = keyof typeof DECISION_LIMITS;
export interface MadeDecisionText {
    sentence: string;
    explanation: string;
    alternatives: string;
    blastRadius: string;
}
/**
 * Check one decision text field and return it unchanged. A required field refuses
 * when absent or blank; an optional field returns undefined when absent or blank.
 * Every refusal names the field and the limit, and nothing is stored.
 */
export declare function boundedDecisionText(field: DecisionTextField, value: unknown, required: true): string;
export declare function boundedDecisionText(field: DecisionTextField, value: unknown, required: false): string | undefined;
/** Validate every text field of a made decision. All four are required. */
export declare function madeDecisionText(input: {
    sentence: unknown;
    explanation: unknown;
    alternatives: unknown;
    blastRadius: unknown;
}): MadeDecisionText;
//# sourceMappingURL=decisions.d.ts.map