import { Context } from 'effect';

// The tenant a program runs for. Services yield these at construction and
// add `org_id = ${org.id}` to every tenant-scoped statement, so the layer
// decides the tenant once and no query can forget it.
export class CurrentOrg extends Context.Service<
	CurrentOrg,
	{ readonly id: string }
>()('app/CurrentOrg') {}

export class CurrentUser extends Context.Service<
	CurrentUser,
	{ readonly id: string }
>()('app/CurrentUser') {}

const missing = (what: string) => ({
	get id(): string {
		throw new Error(
			`No ${what} on this program: tenant-scoped work needs a signed-in caller or an explicit org`
		);
	}
});

// Stand-ins for programs that have no tenant: content routes, the queue
// consumer, cross-org sweeps before they pick an org. They keep every
// service constructible; reading the id is a bug and surfaces as a defect
// instead of silently matching no rows.
export const anonymousOrg: CurrentOrg['Service'] = missing('org');
export const anonymousUser: CurrentUser['Service'] = missing('user');

export const tenantOrgId = (org: CurrentOrg['Service']) =>
	org === anonymousOrg ? null : org.id;
