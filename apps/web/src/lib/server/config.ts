import { Context, Layer } from 'effect';
import { normalizeOrigins } from './host-gate';

export interface AppConfigShape {
	readonly dashboardOrigin: string;
	readonly contentOrigin: string;
	readonly maxUploadBytes: number;
	readonly maxStagedUploadBytes: number;
	readonly maxTotalBytes: number;
	readonly passcode: string;
	readonly semanticSearch: 'off' | 'auto' | 'required';
	readonly embeddingModel: '@cf/baai/bge-small-en-v1.5';
	readonly embeddingPooling: 'cls';
	readonly embeddingDimensions: 384;
}

export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()(
	'app/AppConfig'
) {}

const semanticMode = (value: string) => {
	switch (value) {
		case 'off':
		case 'auto':
		case 'required':
			return value;
		default:
			throw new Error('SEMANTIC_SEARCH must be off, auto, or required');
	}
};

export const configFromEnv = (env: Env) => {
	const origins = normalizeOrigins({
		dashboardOrigin: env.DASHBOARD_ORIGIN,
		contentOrigin: env.CONTENT_ORIGIN
	});
	const maxUploadBytes = Number(env.MAX_UPLOAD_BYTES);
	if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes <= 0) {
		throw new Error('MAX_UPLOAD_BYTES must be a positive safe integer');
	}
	// Per-file ceiling for the staged/resumable multipart flow. Defaults to
	// 500 MiB and must be at least the one-shot cap so staged uploads are
	// never smaller than a single PUT.
	const rawMaxStagedUploadBytes = env.MAX_STAGED_UPLOAD_BYTES as
		| string
		| undefined;
	const maxStagedUploadBytes =
		rawMaxStagedUploadBytes === undefined || rawMaxStagedUploadBytes === ''
			? 500 * 1024 * 1024
			: Number(rawMaxStagedUploadBytes);
	if (
		!Number.isSafeInteger(maxStagedUploadBytes) ||
		maxStagedUploadBytes < maxUploadBytes
	) {
		throw new Error(
			'MAX_STAGED_UPLOAD_BYTES must be a safe integer at least MAX_UPLOAD_BYTES'
		);
	}
	// Global cap on stored bytes across all live file versions. Defaults to
	// 100 GiB when unset so a leaked credential cannot fill the bucket.
	const rawMaxTotalBytes = env.MAX_TOTAL_BYTES as string | undefined;
	const maxTotalBytes =
		rawMaxTotalBytes === undefined || rawMaxTotalBytes === ''
			? 100 * 1024 ** 3
			: Number(rawMaxTotalBytes);
	if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes <= 0) {
		throw new Error('MAX_TOTAL_BYTES must be a positive safe integer');
	}
	if (typeof env.PASSCODE !== 'string' || env.PASSCODE.length < 12) {
		throw new Error('PASSCODE must contain at least 12 characters');
	}
	const semanticSearch = semanticMode(String(env.SEMANTIC_SEARCH));
	if (env.EMBEDDING_MODEL !== '@cf/baai/bge-small-en-v1.5') {
		throw new Error('EMBEDDING_MODEL must stay pinned to bge-small-en-v1.5');
	}
	if (env.EMBEDDING_POOLING !== 'cls') {
		throw new Error('EMBEDDING_POOLING must stay pinned to cls');
	}
	if (env.EMBEDDING_DIMENSIONS !== '384') {
		throw new Error('EMBEDDING_DIMENSIONS must stay pinned to 384');
	}
	return {
		...origins,
		maxUploadBytes,
		maxStagedUploadBytes,
		maxTotalBytes,
		passcode: env.PASSCODE,
		semanticSearch,
		embeddingModel: '@cf/baai/bge-small-en-v1.5',
		embeddingPooling: 'cls',
		embeddingDimensions: 384
	} satisfies AppConfigShape;
};

export const ConfigLive = (env: Env) =>
	Layer.succeed(AppConfig, configFromEnv(env));
