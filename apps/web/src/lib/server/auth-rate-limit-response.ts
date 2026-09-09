// Every rate limit binding counts over a 60 second window
// (wrangler.jsonc), so a refused request can try again after it.
export const RATE_LIMIT_PERIOD_SECONDS = 60;

export const rateLimitResponse = (
	message = 'Too many requests. Try again later.'
) =>
	Response.json(
		{ message },
		{
			status: 429,
			headers: {
				'Cache-Control': 'private, no-store',
				'Retry-After': String(RATE_LIMIT_PERIOD_SECONDS)
			}
		}
	);
