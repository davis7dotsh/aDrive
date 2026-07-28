const INLINE_TYPES = [
	/^text\//,
	/^image\//,
	/^audio\//,
	/^video\//,
	/^application\/pdf$/,
	/^application\/json$/,
	/^application\/xml$/,
	/^application\/javascript$/
];

const asciiFilename = (name: string) =>
	name
		.replace(/[^\x20-\x7e]/g, '_')
		.replace(/["\\]/g, '_')
		.slice(0, 180) || 'download';

const encodedFilename = (name: string) =>
	encodeURIComponent(name).replace(
		/['()*]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
	);

export const contentDisposition = (
	name: string,
	contentType: string,
	forceAttachment = false
) => {
	const disposition =
		!forceAttachment &&
		INLINE_TYPES.some((pattern) => pattern.test(contentType))
			? 'inline'
			: 'attachment';
	return `${disposition}; filename="${asciiFilename(name)}"; filename*=UTF-8''${encodedFilename(name)}`;
};

export const contentSecurityPolicy = (contentType: string) =>
	contentType === 'text/html'
		? "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
		: "default-src 'none'; frame-ancestors 'none'; sandbox";
