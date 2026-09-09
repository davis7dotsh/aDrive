import { error } from '@sveltejs/kit';
import { Effect } from 'effect';
import { runEdgeWithEvent } from '$lib/server/edge';
import { requireAdmin } from '$lib/server/request-auth';
import { Admin } from '$lib/server/services/admin';
import type { PageServerLoad } from './$types';

// Rendered on the server so an admin never sees a flash of an empty page
// and a non-admin sees nothing at all. Actions go through /api/admin/*.
export const load: PageServerLoad = async (event) => {
	if (!event.locals.auth) error(404, 'Not found');
	const overview = await runEdgeWithEvent(
		event,
		Effect.gen(function* () {
			const admin = yield* Admin;
			yield* requireAdmin(event);
			return yield* admin.overview;
		})
	);
	return { overview };
};
