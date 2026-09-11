import { Context, Effect, Layer } from 'effect';
import { AppConfig, type CloudflareZoneConfig } from '../config';

// Purging what the edge already holds. Two layers: the Worker's own Cache
// API (caches.default) for URLs this code stored itself, and the zone
// purge API for everything Cloudflare's CDN cached on its own (site
// assets, anything under a suspended org's host). The zone API needs
// CF_API_TOKEN + CF_ZONE_ID; without them the call is logged and skipped,
// which the runbook (docs/abuse.md) tells the operator to do by hand.

export interface CloudflareCachePurgeShape {
	readonly enabled: boolean;
	// Drops exact URLs from the CDN. Never fails: a purge that could not
	// run is logged, and the entries expire on their own.
	readonly purgeUrls: (urls: ReadonlyArray<string>) => Effect.Effect<void>;
	// Drops everything cached for one host (a suspended org's content host).
	readonly purgeHost: (host: string) => Effect.Effect<void>;
}

export class CloudflareCachePurge extends Context.Service<
	CloudflareCachePurge,
	CloudflareCachePurgeShape
>()('app/CloudflareCachePurge') {}

const log = (entry: Record<string, unknown>) =>
	Effect.sync(() => {
		console.log(JSON.stringify(entry));
	});

const purgeRequest = (
	zone: CloudflareZoneConfig,
	body: Record<string, unknown>
) =>
	Effect.tryPromise(async () => {
		const response = await fetch(
			`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zone.zoneId)}/purge_cache`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${zone.apiToken}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(5_000)
			}
		);
		await response.body?.cancel();
		if (!response.ok) {
			throw new Error(`purge_cache returned ${response.status}`);
		}
	}).pipe(
		Effect.catchCause((cause) =>
			log({
				message: 'edge cache purge failed',
				body,
				cause: String(cause)
			})
		)
	);

const cachePurgeLive = (
	zone: CloudflareZoneConfig
): CloudflareCachePurgeShape => ({
	enabled: true,
	purgeUrls: (urls) => {
		if (urls.length === 0) return Effect.void;
		// The API takes 30 files per call.
		const batches = Array.from(
			{ length: Math.ceil(urls.length / 30) },
			(_, i) => urls.slice(i * 30, i * 30 + 30)
		);
		return Effect.forEach(batches, (files) => purgeRequest(zone, { files }), {
			discard: true
		});
	},
	purgeHost: (host) => purgeRequest(zone, { hosts: [host] })
});

export const cachePurgeNull: CloudflareCachePurgeShape = {
	enabled: false,
	purgeUrls: (urls) =>
		urls.length === 0
			? Effect.void
			: log({
					message: 'edge cache purge skipped (CF_API_TOKEN/CF_ZONE_ID unset)',
					urls
				}),
	purgeHost: (host) =>
		log({
			message: 'edge cache purge skipped (CF_API_TOKEN/CF_ZONE_ID unset)',
			host
		})
};

export const CloudflareCachePurgeLive = Layer.effect(
	CloudflareCachePurge,
	Effect.map(AppConfig, (config) =>
		config.cloudflareZone === null
			? cachePurgeNull
			: cachePurgeLive(config.cloudflareZone)
	)
);

// The Worker's own cache. Content routes store small public files there
// (content-cache.ts); a verdict that changes what a URL should serve
// deletes those entries directly. `caches` is absent outside the Worker.
const workerCache = () => {
	const caches = (globalThis as { caches?: { default?: Cache } }).caches;
	return caches?.default;
};

export const deleteFromWorkerCache = (urls: ReadonlyArray<string>) =>
	Effect.promise(async () => {
		const cache = workerCache();
		if (!cache) return;
		await Promise.allSettled(
			urls.map((url) => cache.delete(new Request(url, { method: 'GET' })))
		);
	});
