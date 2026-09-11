import { Effect } from 'effect';
import {
	alertWebhookUrl,
	postFailedJobAlert,
	recordFailedJob
} from '../failed-jobs';
import { PgSql } from '../pg';
import { ack, type JobBatch, type JobDecision } from './consumer';

// The dead-letter consumer. Every message is recorded and acked; the
// error text is what the platform tells us, which is only that the main
// consumer's retry budget ran out. Any earlier cause is on the row the
// job was working on (index_error, purge_error) and in the logs.
export const consumeDeadLetters = (env: Env, batch: JobBatch) =>
	Effect.gen(function* () {
		const sql = yield* PgSql;
		const kinds = new Set<string>();
		const orgIds = new Set<string>();
		let recorded = 0;
		const decisions: Array<JobDecision> = [];
		for (const message of batch.messages) {
			const result = yield* recordFailedJob(sql, {
				id: message.id,
				body: message.body,
				attempts: message.attempts,
				error: `Retries exhausted on ${batch.queue}`
			});
			if (result.recorded) {
				recorded += 1;
				kinds.add(result.kind);
				if (result.orgId !== null) orgIds.add(result.orgId);
			}
			decisions.push({ id: message.id, ...ack });
		}
		console.error(
			JSON.stringify({
				message: 'jobs dead-lettered',
				queue: batch.queue,
				received: batch.messages.length,
				recorded,
				kinds: [...kinds],
				orgIds: [...orgIds]
			})
		);
		const webhook = alertWebhookUrl(env);
		if (webhook !== null && recorded > 0) {
			yield* postFailedJobAlert(webhook, {
				queue: batch.queue,
				recorded,
				kinds: [...kinds],
				orgIds: [...orgIds]
			});
		}
		return decisions;
	});
