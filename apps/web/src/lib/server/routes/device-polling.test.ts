import {
	DeviceAuthorizationResponseSchema,
	DevicePendingResponseSchema
} from '@adrive/shared';
import { Effect, Schema } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { runWorkerProgram } from '../edge';
import { PgSql } from '../pg';

vi.mock('$app/server', async () => {
	const { mockGetRequestEvent } = await import('../test/route-context.js');
	return mockGetRequestEvent();
});

import { call, createRouteContext } from '../test/route-context';

describe('device authorization rate limiting', () => {
	it('returns a compatible slowdown, protects creation, and resumes polling', async () => {
		const ctx = await createRouteContext();
		const { POST: create } =
			await import('../../../routes/api/auth/device/+server.js');
		const { POST: poll } =
			await import('../../../routes/api/auth/device/token/+server.js');
		const createRequest = () =>
			ctx.event({
				method: 'POST',
				path: '/api/auth/device',
				body: JSON.stringify({ name: 'rate-limited CLI' }),
				headers: { 'Content-Type': 'application/json' }
			});
		const created = await call(create, createRequest());
		expect(created.status).toBe(201);
		const authorization = Schema.decodeUnknownSync(
			DeviceAuthorizationResponseSchema
		)(await created.json());
		expect(authorization.interval).toBe(5);
		const pollRequest = () =>
			ctx.event({
				method: 'POST',
				path: '/api/auth/device/token',
				body: JSON.stringify({ deviceCode: authorization.deviceCode }),
				headers: { 'Content-Type': 'application/json' }
			});
		try {
			ctx.deniedRateLimits.add('auth');
			const limited = await call(poll, pollRequest());
			expect(limited.status).toBe(429);
			expect(limited.headers.get('Retry-After')).toBe('60');
			expect(limited.headers.get('Cache-Control')).toBe('private, no-store');
			expect(
				Schema.decodeUnknownSync(DevicePendingResponseSchema)(
					await limited.json()
				)
			).toEqual({ status: 'slow_down' });

			const blockedCreate = await call(create, createRequest());
			expect(blockedCreate.status).toBe(429);
			expect(blockedCreate.headers.get('Retry-After')).toBe('60');

			ctx.deniedRateLimits.delete('auth');
			const resumed = await call(poll, pollRequest());
			expect(resumed.status).toBe(202);
			expect(await resumed.json()).toEqual({ status: 'authorization_pending' });
		} finally {
			ctx.deniedRateLimits.clear();
			await runWorkerProgram(
				ctx.env,
				Effect.flatMap(
					PgSql,
					(sql) =>
						sql`DELETE FROM device_codes WHERE user_code = ${authorization.userCode}`
				)
			);
		}
	});
});
