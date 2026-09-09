// The route suite runs against a throwaway database on the local docker
// compose Postgres (scripts/pg-init.sql creates it). Override with
// ADRIVE_TEST_DATABASE_URL to point at another server.
export const TEST_DATABASE_URL =
	process.env.ADRIVE_TEST_DATABASE_URL ??
	'postgres://adrive:adrive@127.0.0.1:5432/adrive_test';
