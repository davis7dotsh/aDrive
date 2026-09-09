import { Context, Effect } from 'effect';
import { AppConfig } from '../config';

// The tenant a program runs for. Services yield these at construction and
// add `org_id = ${org.id}` to every tenant-scoped statement, so the layer
// decides the tenant once and no query can forget it. The slug names the
// org's content host; AppConfig.contentOriginFor(org.slug) is its origin.
export class CurrentOrg extends Context.Service<
	CurrentOrg,
	{ readonly id: string; readonly slug: string }
>()('app/CurrentOrg') {}

export class CurrentUser extends Context.Service<
	CurrentUser,
	{ readonly id: string }
>()('app/CurrentUser') {}

const missing = (what: string) => {
	const read = (): never => {
		throw new Error(
			`No ${what} on this program: tenant-scoped work needs a signed-in caller or an explicit org`
		);
	};
	return {
		get id(): string {
			return read();
		},
		get slug(): string {
			return read();
		}
	};
};

// Stand-ins for programs that have no tenant: content routes, the queue
// consumer, cross-org sweeps before they pick an org. They keep every
// service constructible; reading the id is a bug and surfaces as a defect
// instead of silently matching no rows.
export const anonymousOrg: CurrentOrg['Service'] = missing('org');
export const anonymousUser: CurrentUser['Service'] = missing('user');

export const tenantOrgId = (org: CurrentOrg['Service']) =>
	org === anonymousOrg ? null : org.id;

// Where the current org's content is served from:
// `<scheme>//<slug>.<content domain>`. Dashboard responses hand this to
// the client and the CLI; grants and thumbnails are bound to it.
export const currentContentOrigin = Effect.map(
	Effect.all([AppConfig, CurrentOrg]),
	([config, org]) => config.contentOriginFor(org.slug)
);
