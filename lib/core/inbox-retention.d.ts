import type { InboxItem } from '../types.js';
/**
 * Keep human waits and deliberately scheduled work during routine update bursts.
 * A decision item is never dropped here: the cap bounds attention noise, while a
 * recorded decision is history the user reviews later and the spec promises it
 * survives. Decisions therefore do not consume the attention slots either, so a
 * long decision history cannot crowd out a stalled task.
 */
export declare function retainInboxItems<T extends InboxItem>(items: readonly T[], limit: number): T[];
//# sourceMappingURL=inbox-retention.d.ts.map