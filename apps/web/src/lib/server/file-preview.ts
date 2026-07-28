export const maxPreviewBytes = 1024 * 1024;

const markdownExtensions = /\.(?:md|markdown|mdown|mkd)$/i;
const textExtensions =
	/\.(?:txt|csv|tsv|json|jsonl|xml|ya?ml|toml|ini|log|css|js|mjs|cjs|ts|mts|cts|jsx|tsx|svelte|html?|svg|sh|zsh|bash|fish|py|rb|rs|go|java|kt|swift|sql)$/i;

export const previewKind = (displayName: string, contentType: string) => {
	const normalizedType = contentType.split(';', 1)[0]?.trim().toLowerCase();
	if (
		normalizedType === 'text/markdown' ||
		normalizedType === 'text/x-markdown' ||
		markdownExtensions.test(displayName)
	) {
		return 'markdown';
	}
	if (
		normalizedType?.startsWith('text/') ||
		normalizedType === 'application/json' ||
		normalizedType === 'application/xml' ||
		textExtensions.test(displayName)
	) {
		return 'text';
	}
	return null;
};
