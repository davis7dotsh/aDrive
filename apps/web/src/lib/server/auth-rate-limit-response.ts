import type { BlockedAuthAttempt } from './services/auth-guard';

export const authRateLimitResponse = (
	decision: BlockedAuthAttempt,
	message = 'Too many authentication requests. Try again later.'
) =>
	Response.json(
		{ message },
		{
			status: 429,
			headers: {
				'Cache-Control': 'private, no-store',
				'Retry-After': String(decision.retryAfterSeconds)
			}
		}
	);
