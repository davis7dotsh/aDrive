import { Effect } from 'effect';
import { bearerToken } from '../auth-policy';
import { Unauthorized } from '../errors';
import type { AuthShape } from '../services/auth';

export const authorizeMcp = (auth: AuthShape, request: Request, url: URL) => {
	const token = bearerToken(request.headers.get('authorization'));
	if (!token) {
		return Effect.fail(
			new Unauthorized({ message: 'A valid API key is required' })
		);
	}
	return auth
		.authorize({
			authorization: `Bearer ${token}`,
			sessionToken: undefined,
			requestOrigin: url.origin,
			origin: request.headers.get('origin'),
			method: request.method
		})
		.pipe(
			Effect.flatMap((credential) =>
				credential.kind === 'api-key'
					? Effect.succeed(credential)
					: Effect.fail(
							new Unauthorized({ message: 'A valid API key is required' })
						)
			)
		);
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
