import { Context, Layer } from 'effect';
import { normalizeOrigins } from './host-gate';

export interface AppConfigShape {
	readonly dashboardOrigin: string;
	readonly contentOrigin: string;
	readonly maxUploadBytes: number;
}

export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()(
	'app/AppConfig'
) {}

export const configFromEnv = (env: Env) => {
	const origins = normalizeOrigins({
		dashboardOrigin: env.DASHBOARD_ORIGIN,
		contentOrigin: env.CONTENT_ORIGIN
	});
	const maxUploadBytes = Number(env.MAX_UPLOAD_BYTES);
	if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes <= 0) {
		throw new Error('MAX_UPLOAD_BYTES must be a positive safe integer');
	}
	return { ...origins, maxUploadBytes };
};

export const ConfigLive = (env: Env) =>
	Layer.succeed(AppConfig, configFromEnv(env));
