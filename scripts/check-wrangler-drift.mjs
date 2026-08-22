// Fails when top-level and env.production wrangler config drift on values
// that must stay in sync. Wrangler environments don't inherit, so the
// production block redeclares everything — this guards the redeclarations.
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const configPath = join('apps', 'web', 'wrangler.jsonc');

// Strip // and /* */ comments without treating those sequences inside
// JSON strings as comments.
export const stripComments = (source) => {
	let out = '';
	let i = 0;
	let state = 'code';
	let quote = '"';
	while (i < source.length) {
		const current = source[i];
		const next = source[i + 1];
		if (state === 'string') {
			out += current;
			if (current === '\\') {
				out += next ?? '';
				i += 2;
				continue;
			}
			if (current === quote) state = 'code';
			i += 1;
			continue;
		}
		if (state === 'line') {
			if (current === '\n') {
				state = 'code';
				out += current;
			}
			i += 1;
			continue;
		}
		if (state === 'block') {
			if (current === '*' && next === '/') {
				state = 'code';
				i += 2;
				continue;
			}
			i += 1;
			continue;
		}
		if (current === '"' || current === "'") {
			state = 'string';
			quote = current;
			out += current;
			i += 1;
			continue;
		}
		if (current === '/' && next === '/') {
			state = 'line';
			i += 2;
			continue;
		}
		if (current === '/' && next === '*') {
			state = 'block';
			i += 2;
			continue;
		}
		out += current;
		i += 1;
	}
	return out;
};

const normalize = (value) => {
	if (Array.isArray(value)) return value.map(normalize);
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, normalize(value[key])])
		);
	}
	return value;
};

export const sameJson = (left, right) =>
	JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));

const placeholderIds = (block, label, drift) => {
	for (const entry of block.d1_databases ?? []) {
		if (String(entry.database_id ?? '').includes('replace-with-')) {
			drift.push(
				`${label} D1 ${entry.binding ?? 'DB'}: still has a placeholder database_id`
			);
		}
	}
	for (const entry of block.kv_namespaces ?? []) {
		if (String(entry.id ?? '').includes('replace-with-')) {
			drift.push(
				`${label} KV ${entry.binding ?? 'AUTH_GUARD'}: still has a placeholder id`
			);
		}
	}
};

const main = () => {
	const envFlag = process.argv.indexOf('--env');
	const envName =
		envFlag >= 0 && process.argv[envFlag + 1]
			? process.argv[envFlag + 1]
			: 'production';
	const placeholdersOnly = process.argv.includes('--placeholders-only');
	const config = JSON.parse(stripComments(readFileSync(configPath, 'utf8')));
	const prod = config.env?.[envName];
	if (!prod || typeof prod !== 'object' || Array.isArray(prod)) {
		console.error(`wrangler.jsonc does not define env.${envName}.`);
		process.exitCode = 1;
		return;
	}
	const drift = [];

	placeholderIds(prod, `env.${envName}`, drift);

	if (!placeholdersOnly) {
		const ENV_ONLY_VARS = new Set([
			'SEMANTIC_SEARCH',
			'DASHBOARD_ORIGIN',
			'CONTENT_ORIGIN'
		]);
		const localVars = { ...config.vars };
		const prodVars = { ...prod.vars };
		for (const key of ENV_ONLY_VARS) {
			delete localVars[key];
			delete prodVars[key];
		}
		if (!sameJson(localVars, prodVars)) {
			for (const key of new Set([
				...Object.keys(localVars),
				...Object.keys(prodVars)
			])) {
				if (localVars[key] !== prodVars[key]) {
					drift.push(
						`vars.${key}: local=${JSON.stringify(localVars[key])} production=${JSON.stringify(prodVars[key])}`
					);
				}
			}
		}
		for (const key of ['DASHBOARD_ORIGIN', 'CONTENT_ORIGIN']) {
			if (!config.vars?.[key] || !prod.vars?.[key]) {
				drift.push(
					`vars.${key}: must be defined at both top level and env.${envName}`
				);
			}
		}
		if (config.vars?.SEMANTIC_SEARCH !== 'auto') {
			drift.push(
				`vars.SEMANTIC_SEARCH: local must be "auto" (got ${JSON.stringify(config.vars?.SEMANTIC_SEARCH)})`
			);
		}
		if (prod.vars?.SEMANTIC_SEARCH !== 'required') {
			drift.push(
				`vars.SEMANTIC_SEARCH: env.${envName} must be "required" (got ${JSON.stringify(prod.vars?.SEMANTIC_SEARCH)})`
			);
		}

		for (const key of ['triggers', 'observability']) {
			if (!sameJson(config[key], prod[key])) {
				drift.push(
					`${key}: local=${JSON.stringify(config[key])} production=${JSON.stringify(prod[key])}`
				);
			}
		}

		const bindingNames = (entries) =>
			(entries ?? []).map((entry) => entry.binding).sort();
		for (const key of ['d1_databases', 'r2_buckets', 'kv_namespaces']) {
			if (!sameJson(bindingNames(config[key]), bindingNames(prod[key]))) {
				drift.push(
					`${key} bindings: local=${JSON.stringify(bindingNames(config[key]))} production=${JSON.stringify(bindingNames(prod[key]))}`
				);
			}
		}
	}

	if (drift.length > 0) {
		console.error(
			`wrangler.jsonc drift between top level and env.${envName}:\n${drift.map((line) => `  - ${line}`).join('\n')}`
		);
		process.exitCode = 1;
		return;
	}
	console.log(`No drift between top-level and env.${envName} wrangler config.`);
};

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	main();
}
