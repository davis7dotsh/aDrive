import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/server', async () => {
	const { mockGetRequestEvent } = await import('../test/route-context.js');
	return mockGetRequestEvent();
});

import {
	call,
	createRouteContext,
	type RouteTestContext
} from '../test/route-context';
import { login, uploadFile } from '../test/helpers';

const createTag = async (ctx: RouteTestContext, name: string) => {
	const { POST } = await import('../../../routes/api/tags/+server.js');
	const response = await call(
		POST,
		ctx.event({
			method: 'POST',
			path: '/api/tags',
			body: JSON.stringify({ name }),
			headers: { 'content-type': 'application/json' }
		})
	);
	if (response.status !== 201) {
		throw new Error(`Tag create failed: ${response.status}`);
	}
	return ((await response.json()) as { tag: { id: string } }).tag.id;
};

const createKey = async (
	ctx: RouteTestContext,
	body: Record<string, unknown>
) => {
	const { POST } = await import('../../../routes/api/auth/keys/+server.js');
	const response = await call(
		POST,
		ctx.event({
			method: 'POST',
			path: '/api/auth/keys',
			body: JSON.stringify(body),
			headers: { 'content-type': 'application/json' }
		})
	);
	if (response.status !== 201) {
		throw new Error(`Key create failed: ${response.status}`);
	}
	return ((await response.json()) as { token: string }).token;
};

// A bearer-authenticated event. The cookie jar still carries a session, but
// the Authorization header wins in Auth.authorize, so this exercises the
// scoped-token path.
const bearerEvent = (
	ctx: RouteTestContext,
	token: string,
	input: {
		method?: string;
		path: string;
		body?: string;
		params?: Record<string, string>;
	}
) =>
	ctx.event({
		...input,
		headers: {
			authorization: `Bearer ${token}`,
			...(input.body ? { 'content-type': 'text/plain' } : {})
		}
	});

describe('scoped tokens (local platform)', () => {
	let shared: RouteTestContext | undefined;
	const setup = async () => (shared ??= await createRouteContext());

	it('enforces a tag-scoped read-only token across REST', async () => {
		const ctx = await setup();
		await login(ctx);
		const reportsTag = await createTag(ctx, 'scope-reports');
		const inScope = await uploadFile(ctx, {
			name: 'scoped-in.txt',
			content: 'in scope',
			tags: ['scope-reports']
		});
		const outScope = await uploadFile(ctx, {
			name: 'scoped-out.txt',
			content: 'out of scope'
		});

		const token = await createKey(ctx, {
			name: 'reports reader',
			scope: 'read-only',
			allowedTagIds: [reportsTag]
		});

		const { GET: listGET } = await import(
			'../../../routes/api/files/+server.js'
		);
		const listing = await call(
			listGET,
			bearerEvent(ctx, token, { path: '/api/files' })
		);
		expect(listing.status).toBe(200);
		const listed = (await listing.json()) as {
			files: Array<{ id: string }>;
		};
		const ids = listed.files.map((file) => file.id);
		expect(ids).toContain(inScope.id);
		expect(ids).not.toContain(outScope.id);

		const { GET: detailGET } = await import(
			'../../../routes/api/files/[id]/+server.js'
		);
		const inDetail = await call(
			detailGET,
			bearerEvent(ctx, token, {
				path: `/api/files/${inScope.id}`,
				params: { id: inScope.id }
			})
		);
		expect(inDetail.status).toBe(200);

		await expect(
			call(
				detailGET,
				bearerEvent(ctx, token, {
					path: `/api/files/${outScope.id}`,
					params: { id: outScope.id }
				})
			)
		).rejects.toMatchObject({ status: 403 });

		const { GET: linkGET } = await import(
			'../../../routes/api/files/[id]/link/+server.js'
		);
		const link = await call(
			linkGET,
			bearerEvent(ctx, token, {
				path: `/api/files/${inScope.id}/link`,
				params: { id: inScope.id }
			})
		);
		expect(link.status).toBe(200);
	});

	it('lets a read-write scoped token edit in-scope files but not create new ones', async () => {
		const ctx = await setup();
		await login(ctx);
		const target = await uploadFile(ctx, {
			name: 'scoped-file-target.txt',
			content: 'target'
		});
		const token = await createKey(ctx, {
			name: 'single file editor',
			scope: 'read-write',
			allowedFileIds: [target.id]
		});

		// Rename the in-scope file: allowed.
		const { PATCH } = await import('../../../routes/api/files/[id]/+server.js');
		const renamed = await call(
			PATCH,
			ctx.event({
				method: 'PATCH',
				path: `/api/files/${target.id}`,
				body: JSON.stringify({ action: 'rename', displayName: 'renamed.txt' }),
				headers: {
					authorization: `Bearer ${token}`,
					'content-type': 'application/json'
				},
				params: { id: target.id }
			})
		);
		expect(renamed.status).toBe(200);

		// Creating a brand-new file is refused for a scoped token.
		const { PUT } = await import('../../../routes/api/files/+server.js');
		await expect(
			call(
				PUT,
				ctx.event({
					method: 'PUT',
					path: '/api/files',
					body: 'new file bytes',
					headers: {
						authorization: `Bearer ${token}`,
						'content-type': 'text/plain',
						'x-adrive-file-name': encodeURIComponent('nope.txt')
					}
				})
			)
		).rejects.toMatchObject({ status: 403 });
	});
});
