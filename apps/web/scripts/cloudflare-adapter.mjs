import adapter from '@sveltejs/adapter-cloudflare';
import {
	appendFileSync,
	copyFileSync,
	readFileSync,
	unlinkSync,
	writeFileSync
} from 'node:fs';

export const facadeSource = (svelteKitWorker) =>
	`
import sveltekit from ${JSON.stringify(`./${svelteKitWorker}`)};
export * from ${JSON.stringify(`./${svelteKitWorker}`)};

const toHex = (bytes) =>
	Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');

const hmacSign = async (secret, message) => {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	return toHex(
		await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
	);
};

const scheduledSignature = (secret, scheduledTime, cron) =>
	hmacSign(secret, \`\${scheduledTime}\\n\${cron}\`);

// Mirrors verifyJobsRequest in src/lib/server/cron-auth.ts.
const jobsSignature = (secret, timestamp, body) =>
	hmacSign(secret, \`jobs\\n\${timestamp}\\n\${body}\`);

export default {
	fetch(request, env, ctx) {
		return sveltekit.fetch(request, env, ctx);
	},
	scheduled(controller, env, ctx) {
		const scheduledTime = String(controller.scheduledTime);
		ctx.waitUntil(
			(async () => {
				const signature = await scheduledSignature(
					env.MAINTENANCE_SECRET,
					scheduledTime,
					controller.cron
				);
				const response = await sveltekit.fetch(
					new Request(new URL('/api/internal/maintenance', env.DASHBOARD_ORIGIN), {
						method: 'POST',
						headers: {
							'X-Adrive-Scheduled-Time': scheduledTime,
							'X-Adrive-Scheduled-Cron': controller.cron,
							'X-Adrive-Scheduled-Signature': signature
						}
					}),
					env,
					ctx
				);
				if (!response.ok) {
					throw new Error(\`Scheduled maintenance failed with status \${response.status}\`);
				}
			})()
		);
	},
	// Queue batches are forwarded to the SvelteKit bundle in-process (the
	// consumer lives under $lib, unreachable from this facade). The endpoint
	// returns one ack/retry decision per message id; anything it did not
	// decide on is retried so a crash never silently drops work.
	async queue(batch, env, ctx) {
		const timestamp = String(Date.now());
		const body = JSON.stringify({
			queue: batch.queue,
			messages: batch.messages.map((message) => ({
				id: message.id,
				attempts: message.attempts,
				body: message.body
			}))
		});
		const signature = await jobsSignature(env.MAINTENANCE_SECRET, timestamp, body);
		const response = await sveltekit.fetch(
			new Request(new URL('/api/internal/jobs', env.DASHBOARD_ORIGIN), {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'X-Adrive-Jobs-Time': timestamp,
					'X-Adrive-Jobs-Signature': signature
				},
				body
			}),
			env,
			ctx
		);
		if (!response.ok) {
			throw new Error(\`Queue consumer failed with status \${response.status}\`);
		}
		const { decisions } = await response.json();
		const actions = new Map(decisions.map((decision) => [decision.id, decision.action]));
		for (const message of batch.messages) {
			if (actions.get(message.id) === 'ack') message.ack();
			else message.retry();
		}
	}
};
`.trimStart();

export const withScheduledLifecycle = (options) => {
	const base = adapter(options);
	const main = '.svelte-kit/cloudflare/_worker.js';
	const generatedName = '_sveltekit.js';

	return {
		...base,
		name: '@adrive/adapter-cloudflare',
		async adapt(builder) {
			await base.adapt(builder);
			const directory = main.slice(0, main.lastIndexOf('/'));
			const generated = `${directory}/${generatedName}`;
			copyFileSync(main, generated);
			unlinkSync(main);
			writeFileSync(main, facadeSource(generatedName));

			const assetsIgnore = `${directory}/.assetsignore`;
			const current = readFileSync(assetsIgnore, 'utf8');
			if (!current.includes(generatedName)) {
				appendFileSync(assetsIgnore, `\n${generatedName}\n`);
			}
		}
	};
};
