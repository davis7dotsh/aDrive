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

export const sanitizeMatchQuery = (value: string) => {
	const terms = value
		.normalize('NFKC')
		.match(/[\p{L}\p{N}]+/gu)
		?.map((term) => term.slice(0, 64))
		.filter(Boolean)
		.slice(0, 20);
	if (!terms?.length) return null;
	return terms
		.map((term, index) => `"${term}"${index === terms.length - 1 ? '*' : ''}`)
		.join(' ');
};

export const normalizedSearchText = (value: string) =>
	value
		.normalize('NFKC')
		.toLocaleLowerCase('en-US')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();

export const shouldEmbedSearchQuery = (value: string) =>
	normalizedSearchText(value).length >= 3;

export const sanitizeTrigramQuery = (value: string) => {
	const normalized = normalizedSearchText(value);
	if (normalized.length < 3) return null;

	const trigrams = new Set<string>();
	for (let index = 0; index <= normalized.length - 3; index += 1) {
		const trigram = normalized.slice(index, index + 3);
		if (trigram.trim().length === 3) trigrams.add(trigram);
		if (trigrams.size === 32) break;
	}
	return trigrams.size
		? [...trigrams].map((trigram) => `"${trigram}"`).join(' OR ')
		: null;
};

export const reciprocalRankFusion = (
	sources: Readonly<Record<string, FusionSource>>,
	limit = 50
) => {
	const accumulated = new Map<
		string,
		{ score: number; ranks: Record<string, number> }
	>();

	for (const [sourceName, source] of Object.entries(sources)) {
		source.results.slice(0, 50).forEach((result, index) => {
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
