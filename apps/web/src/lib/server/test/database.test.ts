import { describe, expect, it } from 'vitest';
import { disposableTestDatabaseUrl } from './database';

describe('disposable test database URL', () => {
	it.each([
		'postgres://adrive:adrive@127.0.0.1:5432/adrive_test',
		'postgresql://tester:password@ci-postgres:5432/adrive_review?sslmode=require',
		'postgres://tester@remote.example/adrive_test?options=-csearch_path%3Dtest_schema'
	])('allows a reserved database on a configurable host: %s', (url) => {
		expect(disposableTestDatabaseUrl(url)).toBe(url);
	});

	it.each([
		'postgres://adrive:do-not-print@127.0.0.1:5432/adrive',
		'postgres://owner:do-not-print@production.example/production',
		'postgres://tester:do-not-print@localhost/another_test',
		'postgres://tester:do-not-print@localhost/',
		'https://tester:do-not-print@localhost/adrive_test',
		'postgres:///adrive_test',
		'postgres://tester:do-not-print@localhost/adrive_test#production',
		'postgres://tester:do-not-print@localhost/adrive_test?database=production',
		'postgres://tester:do-not-print@localhost/adrive_test?dbname=production',
		'postgres://tester:do-not-print@localhost/adrive_test?connectionString=postgres%3A%2F%2Flocalhost%2Fproduction',
		'postgres://tester:do-not-print%ZZ@localhost/adrive_test',
		' postgres://tester:do-not-print@localhost/adrive_test',
		'not a database URL'
	])(
		'rejects unsafe or malformed targets without echoing the URL: %s',
		(url) => {
			expect(() => disposableTestDatabaseUrl(url)).toThrow(
				new Error(
					'ADRIVE_TEST_DATABASE_URL must be a valid Postgres URL for the disposable adrive_test or adrive_review database'
				)
			);
		}
	);
});
