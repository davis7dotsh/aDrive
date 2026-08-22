import type { DashboardFile } from '@adrive/shared';
import { getContentLink, listFiles, searchFiles } from './api';
import type { FileListPayload } from './api';
import { listingMode, type ListingMode } from '$lib/listing';
import type { Toasts } from './toast.svelte';
import { resource } from 'runed';
import { untrack } from 'svelte';

const fetchListing = (
	mode: ListingMode,
	token: string,
	signal?: AbortSignal,
	cursor?: string
) =>
	mode.kind === 'list'
		? listFiles(token, mode.trashed, signal, cursor)
		: searchFiles(token, mode.query, [...mode.tags], signal, cursor);

const matchListing = (mode: ListingMode, token: string, signal?: AbortSignal) =>
	fetchListing(mode, token, signal);

const emptyList = {
	files: [] as ReadonlyArray<DashboardFile>,
	nextCursor: null,
	tags: [] as ReadonlyArray<never>,
	contentOrigin: '',
	maxUploadBytes: 0,
	semantic: {
		enabled: false,
		indexedChunks: 0,
		dimensions: 0,
		model: '',
		costNotice: ''
	}
};

type FileListDeps = {
	readonly session: {
		readonly ready: boolean;
		readonly token: string;
	};
	readonly toasts: Toasts;
	readonly query: () => string;
	readonly tags: () => ReadonlyArray<string>;
	readonly trashed: () => boolean;
	readonly sort: () => 'name' | 'size' | 'updated';
	readonly initialList?: FileListPayload | null;
	readonly initialError?: string;
};

export const createFileList = ({
	session,
	toasts,
	query,
	tags,
	trashed,
	sort,
	initialList = null,
	initialError = ''
}: FileListDeps) => {
	const ssrList = untrack(() => initialList);
	let hydratedFromServer = false;
	// The mode that produced the current listing, so "load more" follows the
	// same route (list vs search) instead of always paging the plain list.
	let lastMode: ListingMode | null = ssrList
		? listingMode(trashed() ? 'trash' : null, query(), [...tags()])
		: null;
	const list = resource(
		() =>
			[session.ready, session.token, trashed(), query(), [...tags()]] as const,
		async (
			[ready, token, isTrashed, value, selectedTags],
			_previous,
			{ signal }
		) => {
			if (!ready || !token) return emptyList;
			// The page was already rendered server-side with this exact listing
			// (query/trash/tags come from the same URL in both renderers). Skip
			// the duplicate fetch so a dashboard visit costs one API call, not
			// two; the resource still refreshes when params change or on the
			// explicit refetch() that follows uploads and mutations.
			if (ssrList && !hydratedFromServer) {
				hydratedFromServer = true;
				lastMode = listingMode(isTrashed ? 'trash' : null, value, selectedTags);
				return ssrList;
			}
			const mode = listingMode(isTrashed ? 'trash' : null, value, selectedTags);
			const payload = await matchListing(mode, token, signal);
			lastMode = mode;
			return payload;
		},
		{
			// The search input already debounces keystrokes (useSearchParams
			// above), so another debounce here only double-delays tag toggles,
			// refetches after mutations, and the first hydrate. Run promptly.
			initialValue: ssrList ?? emptyList
		}
	);
	let serverLoadError = $state(untrack(() => initialError));
	const listError = $derived(list.error?.message ?? serverLoadError);
	const initialListLoading = $derived(
		!list.current.contentOrigin && !listError
	);
	let loadingMore = $state(false);

	$effect(() => {
		if (list.current.contentOrigin) serverLoadError = '';
	});

	const loadMore = async (showTrash: boolean) => {
		const token = session.token;
		const cursor = list.current.nextCursor;
		if (!token || !cursor || loadingMore) return;
		loadingMore = true;
		try {
			const mode: ListingMode = lastMode ?? {
				kind: 'list',
				trashed: showTrash
			};
			const next = await fetchListing(mode, token, undefined, cursor);
			if (session.token !== token || list.current.nextCursor !== cursor) {
				return;
			}
			const seen = new Set(list.current.files.map((file) => file.id));
			list.mutate({
				...next,
				files: [
					...list.current.files,
					...next.files.filter((file) => !seen.has(file.id))
				],
				tags: list.current.tags,
				semantic: list.current.semantic,
				contentOrigin: list.current.contentOrigin || next.contentOrigin,
				maxUploadBytes: list.current.maxUploadBytes || next.maxUploadBytes
			});
		} catch (cause) {
			toasts.error(cause, 'Could not load more files');
		} finally {
			loadingMore = false;
		}
	};

	const visibleFiles = $derived.by(() => {
		const value = query().trim().toLowerCase();
		const selectedTags = [...tags()];
		const showTrash = trashed();
		if (!showTrash && value) return list.current.files;
		const filtered = showTrash
			? list.current.files.filter(
					(file) =>
						(!value ||
							file.displayName.toLowerCase().includes(value) ||
							file.tags.some((tag) =>
								tag.name.toLowerCase().includes(value)
							)) &&
						(selectedTags.length === 0 ||
							file.tags.some((tag) => selectedTags.includes(tag.id)))
				)
			: list.current.files;
		return [...filtered].sort((left, right) => {
			if (sort() === 'name')
				return left.displayName.localeCompare(right.displayName);
			if (sort() === 'size') return right.sizeBytes - left.sizeBytes;
			return right.updatedAt.localeCompare(left.updatedAt);
		});
	});

	const removeFile = (file: DashboardFile) => {
		list.mutate({
			...list.current,
			files: list.current.files.filter((candidate) => candidate.id !== file.id)
		});
	};

	return {
		list,
		get listError() {
			return listError;
		},
		get initialListLoading() {
			return initialListLoading;
		},
		get loadingMore() {
			return loadingMore;
		},
		loadMore,
		get visibleFiles() {
			return visibleFiles;
		},
		removeFile
	};
};

export const resolveFileLink = async (
	file: DashboardFile,
	token: string,
	contentOrigin: string
) => {
	if (file.public && !isUnavailable(file)) {
		const path = file.kind === 'site' ? `s/${file.id}/` : `f/${file.id}`;
		return `${contentOrigin}/${path}`;
	}
	const link = await getContentLink(
		token,
		file.id,
		undefined,
		undefined,
		isUnavailable(file)
	);
	return link.url;
};

const isUnavailable = (file: DashboardFile) => {
	const expirationTime = file.expiresAt
		? new Date(file.expiresAt).getTime()
		: Number.NaN;
	return (
		file.deletedAt !== null ||
		(Number.isFinite(expirationTime) && expirationTime <= Date.now())
	);
};
