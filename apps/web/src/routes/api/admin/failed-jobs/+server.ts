import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { InvalidRequest } from '$lib/server/errors';
import { listFailedJobs } from '$lib/server/failed-jobs';
import { PgSql } from '$lib/server/pg';
import { requireAuth } from '$lib/server/request-auth';

// The org's dead-lettered jobs, for its owners. Read scope is enough;
// nothing here changes state.
export const GET: RequestHandler = (event) =>
	runEdge(
		Effect.gen(function* () {
			const sql = yield* PgSql;
			const auth = yield* requireAuth(event);
			if (auth.role !== 'owner') {
				return yield* new InvalidRequest({
					status: 403,
					message: 'Only an owner can view failed jobs'
				});
			}
			const jobs = yield* listFailedJobs(sql, auth.orgId);
			return Response.json({ jobs });
		})
	);
