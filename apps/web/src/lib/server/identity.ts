import type { ApiKeyScope } from '@adrive/shared';

// The org a program runs for. userId is null for programs that act for
// an org without a signed-in member: content requests, whose host names
// the org. orgSlug names the org's content host (`<slug>.<content
// domain>`); when a caller does not know it, the layer looks it up once.
export interface ProgramTenant {
	readonly orgId: string;
	readonly orgSlug?: string;
	readonly userId: string | null;
}

// The tenant a program acts for. Requests take it from locals.auth,
// background work names it explicitly.
export interface ProgramIdentity extends ProgramTenant {
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
