// Timing rules for queue-driven work. Pure so the consumer and the
// services that send jobs can be tested without a queue.

// Cloudflare Queues cap a message delay at 12 hours; anything later is
// re-sent by the consumer with the remainder when it arrives.
export const MAX_JOB_DELAY_SECONDS = 12 * 60 * 60;

// A job whose row is still pending or leased this long after it should
// have run is presumed lost and re-sent by the cron reconciliation.
export const STUCK_JOB_MS = 15 * 60 * 1_000;

export const delaySecondsUntil = (at: string | number, now = Date.now()) => {
	const target = typeof at === 'number' ? at : new Date(at).getTime();
	if (!Number.isFinite(target)) return 0;
	return Math.max(
		0,
		Math.min(Math.ceil((target - now) / 1_000), MAX_JOB_DELAY_SECONDS)
	);
};

// Transient failures back off by delivery count (message.attempts is 1
// on the first delivery): a minute, then doubling up to an hour.
export const retryDelaySeconds = (attempts: number) =>
	Math.min(30 * 2 ** Math.max(0, attempts), 3_600);

export const stuckBefore = (now = Date.now()) =>
	new Date(now - STUCK_JOB_MS).toISOString();
