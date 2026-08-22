// Single decision point for "does this listing hit the trash list, the
// plain list, or search?" Shared by the SSR loader and the dashboard's
// client fetcher so the three-way routing can never drift.
export type ListingMode =
	| { readonly kind: 'list'; readonly trashed: boolean }
	| {
			readonly kind: 'search';
			readonly query: string;
			readonly tags: ReadonlyArray<string>;
	  };

export const listingMode = (
	view: string | null | undefined,
	query: string | null | undefined,
	tags: ReadonlyArray<string>
): ListingMode => {
	if (view === 'trash') return { kind: 'list', trashed: true };
	const trimmed = (query ?? '').trim();
	return trimmed || tags.length > 0
		? { kind: 'search', query: trimmed, tags }
		: { kind: 'list', trashed: false };
};
