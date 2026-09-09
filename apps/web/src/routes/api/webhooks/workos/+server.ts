import type { RequestHandler } from './$types';
import { Effect } from 'effect';
import { runEdge } from '$lib/server/edge';
import { InvalidRequest, Unauthorized } from '$lib/server/errors';
import { Auth } from '$lib/server/services/auth';
import { WorkOSClient } from '$lib/server/services/workos';

const MAX_PAYLOAD_BYTES = 256 * 1024;

// WorkOS is the source of truth for accounts. Sign-in upserts everything
// it needs at callback time; the webhook only mirrors the two removals a
// callback can never observe.
export const POST: RequestHandler = ({ request }) =>
	runEdge(
		Effect.gen(function* () {
			const workos = yield* WorkOSClient;
			const auth = yield* Auth;
			const payload = yield* Effect.tryPromise({
				try: () => request.text(),
				catch: () =>
					new InvalidRequest({ status: 400, message: 'Webhook is invalid' })
			});
			if (payload.length > MAX_PAYLOAD_BYTES) {
				return yield* new InvalidRequest({
					status: 413,
					message: 'Webhook payload is too large'
				});
			}
			const signature = request.headers.get('workos-signature');
			if (!signature) {
				return yield* new Unauthorized({
					message: 'Webhook signature is missing'
				});
			}
			const event = yield* workos.constructEvent(payload, signature);
			switch (event.event) {
				case 'user.deleted':
					yield* auth.removeUser(event.userId);
					break;
				case 'organization_membership.deleted':
					yield* auth.removeMembership(event.orgId, event.userId);
					break;
				case 'ignored':
					break;
			}
			return Response.json(
				{ ok: true as const },
				{ headers: { 'Cache-Control': 'private, no-store' } }
			);
		})
	);
