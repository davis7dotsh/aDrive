import {
	AuthenticateWithSessionCookieFailureReason,
	RefreshSessionFailureReason,
	type CookieSession,
	type User,
	type WorkOS as WorkOSSDK
} from '@workos-inc/node';
import { Effect, Layer } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppConfig } from '../config';
import { StorageError, Unauthorized } from '../errors';
import { WorkOSClient, WorkOSLive } from './workos';

const sdk = vi.hoisted(() => {
	const refresh = vi.fn<CookieSession['refresh']>();
	const authenticate = vi.fn<CookieSession['authenticate']>();
	return {
		refresh,
		authenticate,
		loadSealedSession: vi.fn(() => ({ refresh, authenticate })),
		authenticateWithCode:
			vi.fn<WorkOSSDK['userManagement']['authenticateWithCode']>()
	};
});

vi.mock('@workos-inc/node', async (importOriginal) => ({
	...(await importOriginal<typeof import('@workos-inc/node')>()),
	WorkOS: class {
		userManagement = {
			loadSealedSession: sdk.loadSealedSession,
			authenticateWithCode: sdk.authenticateWithCode
		};
	}
}));

const user = {
	object: 'user',
	id: 'user_workos_adapter',
	email: 'adapter@example.com',
	emailVerified: true,
	profilePictureUrl: null,
	name: null,
	firstName: null,
	lastName: null,
	lastSignInAt: null,
	locale: null,
	createdAt: '2026-09-01T00:00:00.000Z',
	updatedAt: '2026-09-01T00:00:00.000Z',
	externalId: null,
	metadata: {}
} satisfies User;

const cookiePassword = 'workos-adapter-test-cookie-password-32-characters';
const live = WorkOSLive.pipe(
	Layer.provide(
		Layer.succeed(AppConfig, {
			dashboardOrigin: 'https://drive.example.com',
			contentOrigin: 'https://content.example.com',
			maxUploadBytes: 1_000_000,
			maintenanceSecret: 'workos-adapter-maintenance',
			workos: {
				apiKey: 'sk_workos_adapter_test',
				clientId: 'client_workos_adapter_test',
				cookiePassword,
				webhookSecret: 'workos-adapter-webhook'
			},
			semanticSearch: 'off',
			embeddingModel: '@cf/baai/bge-small-en-v1.5',
			embeddingPooling: 'cls',
			embeddingDimensions: 384
		})
	)
);

const run = <A, E>(program: Effect.Effect<A, E, WorkOSClient>) =>
	Effect.runPromise(program.pipe(Effect.provide(live)));

const refresh = () =>
	Effect.flatMap(WorkOSClient, (workos) =>
		workos.refresh('sealed-old', 'org_test')
	);

describe('WorkOS live adapter', () => {
	beforeEach(() => {
		sdk.refresh.mockReset();
		sdk.authenticate.mockReset();
		sdk.authenticateWithCode.mockReset();
		sdk.loadSealedSession.mockClear();
	});

	it('returns a refreshed sealed session using the configured cookie password and organization', async () => {
		sdk.refresh.mockResolvedValue({
			authenticated: true,
			sealedSession: 'sealed-new',
			sessionId: 'session_new',
			user,
			authenticationMethod: 'Password'
		});
		expect(await run(refresh())).toBe('sealed-new');
		expect(sdk.loadSealedSession).toHaveBeenCalledWith({
			sessionData: 'sealed-old',
			cookiePassword
		});
		expect(sdk.refresh).toHaveBeenCalledWith({
			cookiePassword,
			organizationId: 'org_test'
		});
	});

	it('returns null only for a terminal refresh failure', async () => {
		sdk.refresh.mockResolvedValue({
			authenticated: false,
			reason: RefreshSessionFailureReason.INVALID_GRANT,
			retryable: false
		});
		expect(await run(refresh())).toBeNull();
	});

	it.each([
		RefreshSessionFailureReason.TIMEOUT,
		RefreshSessionFailureReason.NETWORK_ERROR,
		RefreshSessionFailureReason.RATE_LIMIT_EXCEEDED,
		RefreshSessionFailureReason.SERVER_ERROR
	] as const)(
		'preserves retryable %s refresh failures as storage errors',
		async (reason) => {
			sdk.refresh.mockResolvedValue({
				authenticated: false,
				reason,
				retryable: true
			});
			const result = await run(
				refresh().pipe(
					Effect.match({
						onSuccess: () => null,
						onFailure: (failure) => failure
					})
				)
			);
			expect(result).toBeInstanceOf(StorageError);
			expect(result).toMatchObject({
				operation: 'refresh WorkOS session',
				cause: reason
			});
		}
	);

	it('maps thrown SDK refresh failures to storage errors', async () => {
		const cause = new Error('SDK refresh failed');
		sdk.refresh.mockRejectedValue(cause);
		const result = await run(
			refresh().pipe(
				Effect.match({ onSuccess: () => null, onFailure: (failure) => failure })
			)
		);
		expect(result).toBeInstanceOf(StorageError);
		expect(result).toMatchObject({
			operation: 'refresh WorkOS session',
			cause
		});
	});

	it.each(['member', 'owner', undefined])(
		'returns the verified session role %s on exchange',
		async (role) => {
			sdk.authenticateWithCode.mockResolvedValue({
				user,
				organizationId: 'org_test',
				accessToken: 'access-test',
				refreshToken: 'refresh-test',
				sealedSession: 'sealed-exchanged'
			});
			sdk.authenticate.mockResolvedValue({
				authenticated: true,
				accessToken: 'access-test',
				authenticationMethod: 'Password',
				sessionId: 'session_exchanged',
				organizationId: 'org_test',
				user,
				role
			});
			const result = await run(
				Effect.flatMap(WorkOSClient, (workos) =>
					workos.exchangeCode('code-test')
				)
			);
			expect(result).toMatchObject({
				sealedSession: 'sealed-exchanged',
				sessionId: 'session_exchanged',
				organizationId: 'org_test',
				role: role ?? null
			});
		}
	);

	it('rejects code exchange when the returned session cannot authenticate', async () => {
		sdk.authenticateWithCode.mockResolvedValue({
			user,
			accessToken: 'access-test',
			refreshToken: 'refresh-test',
			sealedSession: 'sealed-invalid'
		});
		sdk.authenticate.mockResolvedValue({
			authenticated: false,
			reason: AuthenticateWithSessionCookieFailureReason.INVALID_JWT
		});
		const result = await run(
			Effect.flatMap(WorkOSClient, (workos) =>
				workos.exchangeCode('code-test')
			).pipe(
				Effect.match({ onSuccess: () => null, onFailure: (failure) => failure })
			)
		);
		expect(result).toBeInstanceOf(Unauthorized);
	});
});
