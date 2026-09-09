import { pgLayer } from '../pg';
import { TEST_DATABASE_URL } from './database';

// Layer providing PgSql against the migrated test database. Postgres-backed
// unit tests live in *.pg.test.ts files and run in the routes vitest
// project so they share the global migration and run one file at a time.
// Use unique ids per test: the database is not reset between files.
export const testPgLayer = () =>
	pgLayer({ connectionString: TEST_DATABASE_URL });
