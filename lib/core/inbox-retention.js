function retentionPriority(item) {
    if (item.status !== 'open' && item.status !== 'seen' && item.status !== 'snoozed')
        return 0;
    if (item.level === 'C3')
        return 100;
    if (item.status === 'snoozed' || item.reminderPending)
        return 80;
    return item.level === 'C2' ? 60 : 40;
}
/**
 * Keep human waits and deliberately scheduled work during routine update bursts.
 * A decision item is never dropped here: the cap bounds attention noise, while a
 * recorded decision is history the user reviews later and the spec promises it
 * survives. Decisions therefore do not consume the attention slots either, so a
 * long decision history cannot crowd out a stalled task.
 */
export function retainInboxItems(items, limit) {
    const attention = items.filter(item => item.decision === undefined);
    if (attention.length <= limit)
        return [...items];
    const retained = new Set([...attention].sort((left, right) => retentionPriority(right) - retentionPriority(left)
        || Date.parse(right.lastReminderAt ?? right.occurredAt) - Date.parse(left.lastReminderAt ?? left.occurredAt)).slice(0, limit));
    return items.filter(item => item.decision !== undefined || retained.has(item));
}
//# sourceMappingURL=inbox-retention.js.map