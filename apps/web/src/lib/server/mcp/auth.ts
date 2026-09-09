import type { RequestEvent } from '@sveltejs/kit';
import type { AuthContext } from '../identity';
import type { McpRunResult } from './run';

// MCP accepts API keys only: the handle hook already resolved the bearer
// into locals.auth, so this just refuses sessions and missing credentials.
export const authorizeMcp = (
	event: Pick<RequestEvent, 'locals'>
): McpRunResult<AuthContext> => {
	const auth = event.locals.auth;
	if (!auth || auth.via !== 'api-key') {
		return {
			ok: false,
			message: 'A valid API key is required',
			status: 401
		};
	}
	return { ok: true, value: auth };
};

export const mcpUnauthorizedResponse = (
	message = 'A valid API key is required'
) =>
	Response.json(
		{ message },
		{
			status: 401,
			headers: {
				'Cache-Control': 'private, no-store',
				'WWW-Authenticate': 'Bearer'
			}
		}
	);

export const mcpAuthFailureResponse = (message: string, status: number) =>
	Response.json(
		{ message },
		{
			status,
			headers: {
				'Cache-Control': 'private, no-store',
				...(status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {})
			}
		}
	);
