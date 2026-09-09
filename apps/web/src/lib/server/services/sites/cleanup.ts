import { Effect } from 'effect';
import { delaySecondsUntil, stuckBefore } from '../../job-policy';
import type { SiteInternals } from './internals';
import { SiteSessionRow, type SitesShape } from './types';

export const cleanupOps = (
	internals: SiteInternals
): Pick<SitesShape, 'cleanupSession' | 'sweepLifecycle'> => {
	const { all, cleanupStaged, sweepPendingDeletes, sql, org, jobs } = internals;

	const sendCleanupJob = (sessionId: string, at: string) =>
		jobs.trySend(
			{ kind: 'site-cleanup', orgId: org.id, sessionId },
			{ delaySeconds: delaySecondsUntil(at) }
		);

	return {
		// Runs from the queue once the session's TTL is up. A session that
		// committed or aborted in the meantime has nothing left to clean;
		// one still open but not yet expired (its expiry was pushed out)
		// comes back when it is.
		cleanupSession: Effect.fn('Sites.cleanupSession')(function* (
			sessionId: string
		) {
			const rows = yield* all(
				sql`
					SELECT id, file_id, display_name, version, status, created_at,
						expires_at
					FROM site_upload_sessions
					WHERE id = ${sessionId} AND org_id = ${org.id}
					LIMIT 1`,
				SiteSessionRow,
				'find site upload session to clean'
			);
			const session = rows[0];
			if (!session || session.status !== 'open') return;
			const now = new Date().toISOString();
			if (session.expires_at > now) {
				return yield* sendCleanupJob(session.id, session.expires_at);
			}
			yield* cleanupStaged(
				{ id: session.id, fileId: session.file_id, version: session.version },
				'aborted'
			);
		}),
		// Reconciliation: sessions expired long ago that the queue never
		// cleaned get a fresh job, and R2 deletes that failed earlier are
		// retried. Returns how many of either were handled.
		sweepLifecycle: Effect.fn('Sites.sweepLifecycle')(function* (
			limit: number
		) {
			const bounded = Math.max(1, Math.min(limit, 25));
			const cutoff = stuckBefore();
			const stuck = yield* all(
				sql`
					SELECT id, file_id, display_name, version, status, created_at,
						expires_at
					FROM site_upload_sessions
					WHERE org_id = ${org.id} AND status = 'open'
						AND expires_at <= ${cutoff}
					ORDER BY expires_at
					LIMIT ${bounded}`,
				SiteSessionRow,
				'list stuck site upload sessions'
			);
			for (const session of stuck) {
				yield* sendCleanupJob(session.id, session.expires_at);
			}
			const pending = yield* sweepPendingDeletes(limit);
			return stuck.length + pending;
		})
	};
};
