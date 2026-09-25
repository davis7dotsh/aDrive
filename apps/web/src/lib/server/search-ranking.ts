export interface RankedFile {
	readonly fileId: string;
}

export interface FusionSource {
	readonly results: ReadonlyArray<RankedFile>;
	readonly weight: number;
}

export interface FusedFile extends RankedFile {
	readonly score: number;
	readonly ranks: Readonly<Record<string, number>>;
}

export const normalizedSearchText = (value: string) =>
	value
		.normalize('NFKC')
		.toLocaleLowerCase('en-US')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();

// Embeddings and trigram matching both need a few real characters before
// they say anything useful; shorter queries run keyword search only.
const MIN_FUZZY_QUERY_LENGTH = 3;

export const shouldEmbedSearchQuery = (value: string) =>
	normalizedSearchText(value).length >= MIN_FUZZY_QUERY_LENGTH;

export const shouldFuzzyMatchQuery = shouldEmbedSearchQuery;

// Postgres websearch_to_tsquery handles quoting and operators itself, so
// the only guard left is "is there anything to search for": a query of pure
// punctuation falls back to the recent-files listing.
export const hasSearchableQuery = (value: string) =>
	normalizedSearchText(value).length > 0;

export const reciprocalRankFusion = (
	sources: Readonly<Record<string, FusionSource>>,
	limit = 50
) => {
	const accumulated = new Map<
		string,
		{ score: number; ranks: Record<string, number> }
	>();

	for (const [sourceName, source] of Object.entries(sources)) {
		source.results.forEach((result, index) => {
			const rank = index + 1;
			const entry = accumulated.get(result.fileId) ?? {
				score: 0,
				ranks: {}
			};
			entry.score += source.weight / (60 + rank);
			entry.ranks[sourceName] = rank;
			accumulated.set(result.fileId, entry);
		});
	}

	return [...accumulated.entries()]
		.map(([fileId, value]): FusedFile => ({ fileId, ...value }))
		.sort(
			(left, right) =>
				right.score - left.score ||
				Math.min(...Object.values(left.ranks)) -
					Math.min(...Object.values(right.ranks)) ||
				left.fileId.localeCompare(right.fileId)
		)
		.slice(0, limit);
};

const normalizedExactName = (value: string) =>
	value.normalize('NFKC').trim().toLocaleLowerCase('en-US');

export const pinExactName = <File extends { readonly displayName: string }>(
	query: string,
	files: ReadonlyArray<File>
) => {
	const normalized = normalizedExactName(query);
	if (!normalized) return [...files];
	const exactIndex = files.findIndex(
		(file) => normalizedExactName(file.displayName) === normalized
	);
	if (exactIndex <= 0) return [...files];
	return [
		files[exactIndex]!,
		...files.slice(0, exactIndex),
		...files.slice(exactIndex + 1)
	];
};

export const matchesAnyTag = (
	fileTagIds: ReadonlyArray<string>,
	filterTagIds: ReadonlyArray<string>
) =>
	filterTagIds.length === 0 ||
	filterTagIds.some((tagId) => fileTagIds.includes(tagId));
