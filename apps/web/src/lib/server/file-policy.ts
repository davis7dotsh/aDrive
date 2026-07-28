import { InvalidRequest } from './errors';

const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const cleanFileName = (value: string) => {
	const name = value.split(/[\\/]/).at(-1)?.trim() ?? '';
	if (!name || name.length > 255 || /[\u0000-\u001f\u007f]/.test(name)) {
		throw new InvalidRequest({ status: 400, message: 'File name is invalid' });
	}
	return name;
};

export const cleanContentType = (value: string) => {
	const contentType = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
	return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType)
		? contentType
		: 'application/octet-stream';
};

export const contentTypeForUpload = (name: string, supplied: string) =>
	/\.html?$/i.test(name) ? 'text/html' : cleanContentType(supplied);

export const visibilityForFile = (
	name: string,
	contentType: string,
	requestedPublic: boolean
) => {
	const forcedPublic =
		(contentType === 'text/html' || /\.html?$/i.test(name)) && !requestedPublic;
	return {
		public: requestedPublic || forcedPublic,
		forcedPublic
	};
};

export const trashWindow = (existingDeletedAt: string | null, now: Date) => {
	const deletedAt = existingDeletedAt ?? now.toISOString();
	return {
		deletedAt,
		purgeAt: new Date(
			new Date(deletedAt).getTime() + TRASH_RETENTION_MS
		).toISOString()
	};
};
