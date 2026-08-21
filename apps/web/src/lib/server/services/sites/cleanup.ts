import { Effect } from 'effect';
import type { SiteInternals } from './internals';

export const cleanupOps = (internals: SiteInternals) => {
	const {
		drainDeletes,
		cleanupStaged,
		pendingDeleteCount,
		sweepExpiredSessions,
		sweepPendingDeletes
	} = internals;

	return {
		drainDeletes,
		cleanupStaged,
		pendingDeleteCount,
		sweepExpiredSessions,
		sweepPendingDeletes,
		sweepLifecycle: Effect.fn('Sites.sweepLifecycle')(function* (
			limit: number
		) {
			const expired = yield* sweepExpiredSessions(limit);
			const pending = yield* sweepPendingDeletes(limit);
			return expired + pending;
		})
	};
};
