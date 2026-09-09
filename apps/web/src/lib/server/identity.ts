import type { ApiKeyScope } from '@adrive/shared';

// The tenant a program acts for. Requests take it from locals.auth,
// background work names it explicitly.
export interface ProgramIdentity {
	readonly orgId: string;
	readonly userId: string;
}

// What a request is allowed to act as. Both credential kinds (WorkOS
// session, adr_ API key) resolve to this one shape so routes and services
// never branch on how the caller signed in.
export interface AuthContext extends ProgramIdentity {
	readonly role: string;
	readonly via: 'session' | 'api-key';
	readonly scope: ApiKeyScope;
	// API key id, or the WorkOS session id for browser sessions. Rate
	// limits key on it so one leaked credential cannot exhaust another's
	// budget.
	readonly credentialId: string;
	readonly email: string;
	readonly orgName: string;
	readonly orgSlug: string;
}

export interface ResolvedCredential {
	readonly auth: AuthContext | null;
	// A re-sealed session WorkOS issued while validating this request; the
	// handle hook writes it back so the next request skips the refresh.
	readonly refreshedSession: string | null;
}
