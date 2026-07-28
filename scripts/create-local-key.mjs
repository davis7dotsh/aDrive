import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const prefix = randomBytes(4).toString('hex');
const secret = randomBytes(32).toString('base64url');
const token = `adr_${prefix}_${secret}`;
const hash = createHash('sha256').update(token).digest('hex');
const id = randomUUID();
const createdAt = new Date().toISOString();
const sql = [
	'INSERT INTO api_keys (id, name, prefix, secret_hash, created_at)',
	`VALUES ('${id}', 'local development', '${prefix}', '${hash}', '${createdAt}')`
].join(' ');

const result = spawnSync(
	'pnpm',
	[
		'--filter',
		'@adrive/web',
		'exec',
		'wrangler',
		'd1',
		'execute',
		'DB',
		'--local',
		'--command',
		sql
	],
	{ stdio: ['ignore', 'inherit', 'inherit'] }
);

if (result.status !== 0) {
	process.exitCode = result.status ?? 1;
} else {
	console.log('\nLocal API key (shown once):');
	console.log(token);
}
