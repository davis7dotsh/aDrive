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

const scheduledSignature = async (passcode, scheduledTime, cron) => {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(passcode),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	return toHex(
		await crypto.subtle.sign(
			'HMAC',
			key,
			new TextEncoder().encode(\`\${scheduledTime}\\n\${cron}\`)
		)
	);
};

export default {
	fetch(request, env, ctx) {
		return sveltekit.fetch(request, env, ctx);
	},
	scheduled(controller, env, ctx) {
		const scheduledTime = String(controller.scheduledTime);
		ctx.waitUntil(
			(async () => {
				const signature = await scheduledSignature(
					env.PASSCODE,
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
