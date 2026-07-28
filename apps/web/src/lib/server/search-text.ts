const SEARCH_TEXT_BYTES = 65_536;

const TEXT_EXTENSIONS =
	/\.(?:c|cc|cpp|cs|css|csv|go|h|hpp|html?|java|js|json|jsx|md|mjs|py|rb|rs|sh|sql|svelte|toml|ts|tsx|txt|xml|yaml|yml)$/i;

export const searchTextLimit = SEARCH_TEXT_BYTES;

export const isSearchableText = (name: string, contentType: string) =>
	contentType.startsWith('text/') ||
	/^(?:application\/(?:json|javascript|xml|xhtml\+xml)|image\/svg\+xml)$/.test(
		contentType
	) ||
	TEXT_EXTENSIONS.test(name);
