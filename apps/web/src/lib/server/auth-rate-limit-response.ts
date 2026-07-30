import type { BlockedAuthAttempt } from './services/auth-guard';

export const authRateLimitResponse = (decision: BlockedAuthAttempt) => {
	const message =
		decision.reason === 'lockout'
			? 'Too many incorrect passcode attempts. Try again later.'
			: 'Too many authentication requests. Try again later.';
	return Response.json(
		{ message },
		{
			status: 429,
			headers: {
				'Cache-Control': 'private, no-store',
				'Retry-After': String(decision.retryAfterSeconds)
			}
		}
	);
};
