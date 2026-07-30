import { InvalidRequest } from './errors';

export const SESSION_COOKIE = '__Host-adrive-session';
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
export const DEVICE_CODE_TTL_SECONDS = 10 * 60;
export const DEVICE_POLL_INTERVAL_SECONDS = 5;

export const normalizeApiKeyName = (value: string) => {
	const name = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
	if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
		throw new InvalidRequest({
			status: 400,
			message: 'Credential name is invalid'
		});
	}
	return name;
};

export const normalizeUserCode = (value: string) => {
	const code = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
	if (!/^[A-Z0-9]{8}$/.test(code)) {
		throw new InvalidRequest({
			status: 400,
			message: 'Device approval code is invalid'
		});
	}
	return `${code.slice(0, 4)}-${code.slice(4)}`;
};

export const validateExpiration = (value: string | null, now = new Date()) => {
	if (value === null || value.trim() === '') return null;
	const date = new Date(value);
	if (!Number.isFinite(date.getTime()) || date.getTime() <= now.getTime()) {
		throw new InvalidRequest({
			status: 400,
			message: 'Expiration must be a future ISO-8601 timestamp'
		});
	}
	return date.toISOString();
};

export const shouldCountDownload = (rangeHeader: string | null) => {
	if (rangeHeader === null) return true;
	return /^bytes=0-(?:\d*)$/i.test(rangeHeader.trim());
};

export const allowsCredentialOrigin = (
	method: string,
	origin: string | null,
	dashboardOrigin: string
) => ['GET', 'HEAD'].includes(method) || origin === dashboardOrigin;
