// The route suite runs against a throwaway database on the local docker
// compose Postgres (scripts/pg-init.sql creates it).
// ADRIVE_TEST_DATABASE_URL may select another server, but its database
// must be explicitly reserved for destructive test runs.
export const disposableTestDatabaseUrl = (url: string) => {
	try {
		const parsed = new URL(url);
		if (
			!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
			!parsed.hostname ||
			!['/adrive_test', '/adrive_review'].includes(parsed.pathname) ||
			parsed.hash ||
			/\s/.test(url) ||
			parsed.searchParams.has('database') ||
			parsed.searchParams.has('dbname') ||
			parsed.searchParams.has('connectionString')
		) {
			throw new Error();
		}
		// Reject malformed percent escapes before the PG URL parser runs.
		decodeURIComponent(url);
		return url;
	} catch {
		// Never attach the input or parser error: URLs can contain credentials.
		throw new Error(
			'ADRIVE_TEST_DATABASE_URL must be a valid Postgres URL for the disposable adrive_test or adrive_review database'
		);
	}
};

export const TEST_DATABASE_URL = disposableTestDatabaseUrl(
	process.env.ADRIVE_TEST_DATABASE_URL ??
		'postgres://adrive:adrive@127.0.0.1:5432/adrive_test'
);
