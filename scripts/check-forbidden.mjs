import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';

const roots = ['apps', 'packages'];
const forbidden = [
	{ label: 'D1 transactions', pattern: '.withTransaction(' },
	{ label: 'D1 query streams', pattern: '.stream(' }
];
const violations = [];

const visit = async (directory) => {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			await visit(path);
		} else if (['.ts', '.svelte'].includes(extname(entry.name))) {
			const source = await readFile(path, 'utf8');
			for (const rule of forbidden) {
				if (source.includes(rule.pattern)) {
					violations.push(`${path}: forbidden ${rule.label} (${rule.pattern})`);
				}
			}
		}
	}
};

for (const root of roots) {
	await visit(root);
}

if (violations.length > 0) {
	console.error(violations.join('\n'));
	process.exitCode = 1;
} else {
	console.log('No unsupported D1 transaction or query-stream calls found.');
}
