import type { ApiKeyScope } from '@adrive/shared';

// The tenant a program acts for. Requests take it from locals.auth,
// background work names it explicitly.
export interface ProgramIdentity {
	readonly orgId: string;
	readonly userId: string;
}

// What a request is allowed to act as. Both credential kinds (browser
// session, adr_ API key) resolve to this one shape so routes and services
// never branch on how the caller signed in.
export interface AuthContext extends ProgramIdentity {
	readonly role: string;
	readonly via: 'session' | 'api-key';
	readonly scope: ApiKeyScope;
	// API key id, or the session id for browser sessions. Rate limits key
	// on it so one leaked credential cannot exhaust another's budget.
	readonly credentialId: string;
}
