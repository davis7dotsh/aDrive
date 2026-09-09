import { WorkOS } from '@workos-inc/node';
import { Context, Effect, Layer } from 'effect';
import { AppConfig, type WorkOSConfig } from '../config';
import { StorageError, Unauthorized } from '../errors';

// The slice of WorkOS the app depends on. Routes and tests program against
// this shape; the SDK is confined to workOSLive below and WorkOSFake stands
// in whenever no API key is configured.

export interface ExchangedCode {
	readonly sealedSession: string;
	readonly sessionId: string;
	readonly user: {
		readonly id: string;
		readonly email: string;
		readonly emailVerified: boolean;
	};
	readonly organizationId: string | null;
}

export type LoadedSession =
	| {
			readonly authenticated: true;
			readonly sessionId: string;
			readonly userId: string;
			readonly orgId: string | null;
			readonly role: string | null;
	  }
	| { readonly authenticated: false; readonly refreshable: boolean };

export type WebhookEvent =
	| { readonly event: 'user.deleted'; readonly userId: string }
	| {
			readonly event: 'organization_membership.deleted';
			readonly orgId: string;
			readonly userId: string;
	  }
	| { readonly event: 'ignored'; readonly name: string };

export interface WorkOSClientShape {
	readonly authorizationUrl: (state: string, redirectUri: string) => string;
	readonly exchangeCode: (
		code: string
	) => Effect.Effect<ExchangedCode, Unauthorized | StorageError>;
	readonly loadSession: (
		cookie: string
	) => Effect.Effect<LoadedSession, StorageError>;
	// Returns the new sealed session, or null when the session cannot be
	// refreshed (revoked, expired, or a terminal WorkOS failure).
	readonly refresh: (
		cookie: string,
		orgId?: string
	) => Effect.Effect<string | null, StorageError>;
	readonly logoutUrl: (
		sessionId: string,
		returnTo: string
	) => Effect.Effect<string, StorageError>;
	readonly createOrganization: (
		name: string
	) => Effect.Effect<{ readonly id: string }, StorageError>;
	readonly createOrganizationMembership: (input: {
		readonly organizationId: string;
		readonly userId: string;
		readonly roleSlug: string;
	}) => Effect.Effect<void, StorageError>;
	readonly constructEvent: (
		payload: string,
		signature: string
	) => Effect.Effect<WebhookEvent, Unauthorized>;
}

export class WorkOSClient extends Context.Service<
	WorkOSClient,
	WorkOSClientShape
>()('app/WorkOSClient') {}

const toWebhookEvent = (event: {
	readonly event: string;
	readonly data: unknown;
}): WebhookEvent => {
	const data =
		typeof event.data === 'object' && event.data !== null
			? (event.data as Record<string, unknown>)
			: {};
	const text = (value: unknown) => (typeof value === 'string' ? value : '');
	if (event.event === 'user.deleted' && text(data.id)) {
		return { event: 'user.deleted', userId: text(data.id) };
	}
	if (
		event.event === 'organization_membership.deleted' &&
		text(data.organizationId) &&
		text(data.userId)
	) {
		return {
			event: 'organization_membership.deleted',
			orgId: text(data.organizationId),
			userId: text(data.userId)
		};
	}
	return { event: 'ignored', name: event.event };
};

// One SDK instance per isolate: it caches the JWKS used to verify session
// tokens locally, so per-request construction would refetch it every time.
let cachedSdk: { readonly key: string; readonly sdk: WorkOS } | undefined;
const sdkFor = (config: WorkOSConfig & { readonly apiKey: string }) => {
	const key = `${config.apiKey}\n${config.clientId}`;
	if (cachedSdk?.key !== key) {
		cachedSdk = {
			key,
			sdk: new WorkOS(config.apiKey, { clientId: config.clientId })
		};
	}
	return cachedSdk.sdk;
};

const failure = (operation: string) => (cause: unknown) =>
	new StorageError({ operation, cause });

const workOSLive = (
	config: WorkOSConfig & { readonly apiKey: string }
): WorkOSClientShape => {
	const workos = sdkFor(config);
	const session = (cookie: string) =>
		workos.userManagement.loadSealedSession({
			sessionData: cookie,
			cookiePassword: config.cookiePassword
		});
	return {
		authorizationUrl: (state, redirectUri) =>
			workos.userManagement.getAuthorizationUrl({
				provider: 'authkit',
				clientId: config.clientId,
				redirectUri,
				state
			}),
		exchangeCode: (code) =>
			Effect.tryPromise({
				try: () =>
					workos.userManagement.authenticateWithCode({
						clientId: config.clientId,
						code,
						session: {
							sealSession: true,
							cookiePassword: config.cookiePassword
						}
					}),
				catch: failure('exchange WorkOS authorization code')
			}).pipe(
				Effect.flatMap((result) =>
					Effect.gen(function* () {
						if (!result.sealedSession) {
							return yield* new Unauthorized({
								message: 'WorkOS did not return a session'
							});
						}
						const loaded = yield* Effect.tryPromise({
							try: () => session(result.sealedSession ?? '').authenticate(),
							catch: failure('read exchanged WorkOS session')
						});
						return {
							sealedSession: result.sealedSession,
							sessionId: loaded.authenticated ? loaded.sessionId : '',
							user: {
								id: result.user.id,
								email: result.user.email,
								emailVerified: result.user.emailVerified
							},
							organizationId: result.organizationId ?? null
						};
					})
				)
			),
		loadSession: (cookie) =>
			Effect.tryPromise({
				try: () => session(cookie).authenticate(),
				catch: failure('authenticate WorkOS session')
			}).pipe(
				Effect.map((result): LoadedSession =>
					result.authenticated
						? {
								authenticated: true,
								sessionId: result.sessionId,
								userId: result.user.id,
								orgId: result.organizationId ?? null,
								role: result.role ?? null
							}
						: {
								authenticated: false,
								refreshable: result.reason === 'invalid_jwt'
							}
				)
			),
		refresh: (cookie, orgId) =>
			Effect.tryPromise({
				try: () =>
					session(cookie).refresh({
						cookiePassword: config.cookiePassword,
						organizationId: orgId
					}),
				catch: failure('refresh WorkOS session')
			}).pipe(
				Effect.map((result) =>
					result.authenticated ? (result.sealedSession ?? null) : null
				)
			),
		logoutUrl: (sessionId, returnTo) =>
			Effect.sync(() =>
				workos.userManagement.getLogoutUrl({ sessionId, returnTo })
			),
		createOrganization: (name) =>
			Effect.tryPromise({
				try: () => workos.organizations.createOrganization({ name }),
				catch: failure('create WorkOS organization')
			}).pipe(Effect.map((org) => ({ id: org.id }))),
		createOrganizationMembership: (input) =>
			Effect.tryPromise({
				try: () => workos.userManagement.createOrganizationMembership(input),
				catch: failure('create WorkOS organization membership')
			}).pipe(Effect.asVoid),
		constructEvent: (payload, signature) =>
			Effect.tryPromise({
				try: () =>
					workos.webhooks.constructEvent({
						payload,
						sigHeader: signature,
						secret: config.webhookSecret
					}),
				catch: () =>
					new Unauthorized({ message: 'Webhook signature is invalid' })
			}).pipe(Effect.map(toWebhookEvent))
	};
};

// Local development and tests. Identities are plain strings so a test can
// sign in as anyone: the authorization code and the session cookie are
// both `fake:<userId>[:<orgId>]`. No secrets are checked, which is why the
// fake is only ever selected when WORKOS_API_KEY is absent.
export const FAKE_SESSION_PREFIX = 'fake:';
export const FAKE_DEV_USER = 'user_local';

export const fakeSession = (userId: string, orgId: string | null = null) =>
	`${FAKE_SESSION_PREFIX}${userId}:${orgId ?? ''}`;

const parseFake = (value: string) => {
	if (!value.startsWith(FAKE_SESSION_PREFIX)) return null;
	const [userId = '', orgId = ''] = value
		.slice(FAKE_SESSION_PREFIX.length)
		.split(':');
	return userId ? { userId, orgId: orgId || null } : null;
};

const fakeEmail = (userId: string) => `${userId}@fake.adrive.invalid`;

export const workOSFake: WorkOSClientShape = {
	authorizationUrl: (state, redirectUri) => {
		const url = new URL(redirectUri);
		url.searchParams.set('code', fakeSession(FAKE_DEV_USER));
		url.searchParams.set('state', state);
		return url.href;
	},
	exchangeCode: (code) => {
		const parsed = parseFake(code);
		return parsed
			? Effect.succeed({
					sealedSession: fakeSession(parsed.userId, parsed.orgId),
					sessionId: `fake-session:${parsed.userId}`,
					user: {
						id: parsed.userId,
						email: fakeEmail(parsed.userId),
						emailVerified: true
					},
					organizationId: parsed.orgId
				})
			: Effect.fail(
					new Unauthorized({ message: 'Authorization code is invalid' })
				);
	},
	loadSession: (cookie) => {
		const parsed = parseFake(cookie);
		return Effect.succeed(
			parsed
				? {
						authenticated: true,
						sessionId: `fake-session:${parsed.userId}`,
						userId: parsed.userId,
						orgId: parsed.orgId,
						role: 'owner'
					}
				: { authenticated: false, refreshable: false }
		);
	},
	refresh: (cookie, orgId) => {
		const parsed = parseFake(cookie);
		return Effect.succeed(
			parsed ? fakeSession(parsed.userId, orgId ?? parsed.orgId) : null
		);
	},
	logoutUrl: (_sessionId, returnTo) => Effect.succeed(returnTo),
	createOrganization: () =>
		Effect.succeed({ id: `org_fake_${crypto.randomUUID().slice(0, 8)}` }),
	createOrganizationMembership: () => Effect.void,
	constructEvent: (payload) =>
		Effect.try({
			try: (): unknown => JSON.parse(payload),
			catch: () => new Unauthorized({ message: 'Webhook payload is invalid' })
		}).pipe(
			Effect.map((body) =>
				toWebhookEvent(
					typeof body === 'object' && body !== null && 'event' in body
						? {
								event: String(body.event),
								data: 'data' in body ? body.data : undefined
							}
						: { event: '', data: undefined }
				)
			)
		)
};

export const WorkOSFake = Layer.succeed(WorkOSClient, workOSFake);

export const WorkOSLive = Layer.effect(
	WorkOSClient,
	Effect.map(AppConfig, (config) =>
		config.workos.apiKey === null
			? workOSFake
			: workOSLive({ ...config.workos, apiKey: config.workos.apiKey })
	)
);
