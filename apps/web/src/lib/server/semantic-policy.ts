import { searchTextLimit } from './search-text';

export const CHUNK_CHARACTERS = 2_000;
export const CHUNK_OVERLAP_CHARACTERS = 240;
export const MAX_INDEX_ATTEMPTS = 5;

export interface TextChunk {
	readonly ordinal: number;
	readonly charStart: number;
	readonly charEnd: number;
	readonly text: string;
}

export const chunkSearchText = (
	displayName: string,
	text: string
): ReadonlyArray<TextChunk> => {
	const normalized = text
		.replaceAll('\u0000', '')
		.replace(/\r\n?/g, '\n')
		.slice(0, searchTextLimit);
	const content = normalized.trim() || displayName;
	const chunks: TextChunk[] = [];
	const step = CHUNK_CHARACTERS - CHUNK_OVERLAP_CHARACTERS;

	for (
		let charStart = 0, ordinal = 0;
		charStart < content.length;
		charStart += step, ordinal += 1
	) {
		const charEnd = Math.min(content.length, charStart + CHUNK_CHARACTERS);
		chunks.push({
			ordinal,
			charStart,
			charEnd,
			text: `${displayName}\n\n${content.slice(charStart, charEnd)}`
		});
		if (charEnd === content.length) break;
	}

	return chunks;
};

export const newIndexLeaseToken = () => {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '');
};

export const vectorIdForChunk = (
	fileId: string,
	leaseToken: string,
	ordinal: number
) => `${fileId}:${leaseToken}:${ordinal.toString(36)}`;

export const fileIdFromVectorId = (vectorId: string) => {
	const last = vectorId.lastIndexOf(':');
	if (last < 0) return null;
	const version = vectorId.lastIndexOf(':', last - 1);
	return version < 0 ? null : vectorId.slice(0, version);
};

export const collapseVectorMatches = (
	matches: ReadonlyArray<{ readonly id: string; readonly score: number }>
) => {
	const best = new Map<string, number>();
	for (const match of matches) {
		const fileId = fileIdFromVectorId(match.id);
		if (!fileId) continue;
		best.set(fileId, Math.max(best.get(fileId) ?? -Infinity, match.score));
	}
	return [...best.entries()]
		.sort(
			([leftId, leftScore], [rightId, rightScore]) =>
				rightScore - leftScore || leftId.localeCompare(rightId)
		)
		.map(([fileId]) => ({ fileId }));
};

export const retryAt = (attempt: number, now = new Date()) =>
	new Date(
		now.getTime() + Math.min(60 * 2 ** Math.max(0, attempt - 1), 3_600) * 1_000
	).toISOString();

export const indexFailureDisposition = (attempt: number, now = new Date()) =>
	attempt >= MAX_INDEX_ATTEMPTS
		? { state: 'failed' as const, nextRunAt: null }
		: { state: 'pending' as const, nextRunAt: retryAt(attempt, now) };

export const safeIndexError = (cause: unknown) => {
	const value = cause instanceof Error ? cause.message : String(cause);
	return value
		.replace(/adr_[A-Za-z0-9_-]+/g, '[credential]')
		.replace(/[A-Fa-f0-9]{64}/g, '[digest]')
		.slice(0, 500);
};
