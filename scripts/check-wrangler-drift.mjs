// Fails when top-level and env.production wrangler config drift on values
// that must stay in sync. Wrangler environments don't inherit, so the
// production block redeclares everything — this guards the redeclarations.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const configPath = join('apps', 'web', 'wrangler.jsonc');
const stripComments = (source) =>
	source
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n')
		.map((line) => line.replace(/(^|[^:"'\\])\/\/.*$/, '$1'))
		.join('\n');

const config = JSON.parse(stripComments(readFileSync(configPath, 'utf8')));
const prod = config.env?.production ?? {};
const drift = [];

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Vars must match on every key except the intentional local/production
// differences: SEMANTIC_SEARCH is `auto` locally (no AI/Vectorize bindings)
// and `required` in production (fail loudly on missing bindings), and the
// origins point at localhost vs the custom domains.
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
			`vars.${key}: must be defined at both top level and env.production`
		);
	}
}

for (const key of ['triggers', 'observability']) {
	if (!sameJson(config[key], prod[key])) {
		drift.push(
			`${key}: local=${JSON.stringify(config[key])} production=${JSON.stringify(prod[key])}`
		);
	}
}

// Binding names must stay aligned across envs even when resource ids differ.
// AI/Vectorize are production-only by design (local dev is keyword-only).
const bindingNames = (entries) =>
	(entries ?? []).map((entry) => entry.binding).sort();
for (const key of ['d1_databases', 'r2_buckets', 'kv_namespaces']) {
	if (!sameJson(bindingNames(config[key]), bindingNames(prod[key]))) {
		drift.push(
			`${key} bindings: local=${JSON.stringify(bindingNames(config[key]))} production=${JSON.stringify(bindingNames(prod[key]))}`
		);
	}
}

if (drift.length > 0) {
	console.error(
		`wrangler.jsonc drift between top level and env.production:\n${drift.map((line) => `  - ${line}`).join('\n')}`
	);
	process.exitCode = 1;
} else {
	console.log('No drift between top-level and env.production wrangler config.');
}
