<script lang="ts">
	import type { FileDetailResponse, FileMutation, Tag } from '@adrive/shared';
	import { page } from '$app/state';
	import {
		createTag,
		getContentLink,
		getFile,
		mutateFile,
		setFileTags,
		uploadVersion
	} from '$lib/dashboard/api';
	import { getDashboardSession } from '$lib/dashboard/session.svelte';
	import { getToasts } from '$lib/dashboard/toast.svelte';
	import CopyButton from './ui/CopyButton.svelte';
	import Icon from './ui/Icon.svelte';
	import FileName from './files/FileName.svelte';
	import FilePreview from './files/FilePreview.svelte';
	import FileSidebar from './files/FileSidebar.svelte';
	import { resource } from 'runed';
	import { untrack } from 'svelte';

	let {
		initialDetail = null,
		initialError = ''
	}: {
		initialDetail?: FileDetailResponse | null;
		initialError?: string;
	} = $props();
	const session = getDashboardSession();
	const toasts = getToasts();
	const id = $derived(page.params.id);
	const from = $derived(page.url.searchParams.get('from') ?? '');
	const backHref = $derived(from.startsWith('?') ? `/${from}` : '/');
	const detail = resource(
		() => [session.ready, session.token, id] as const,
		([ready, token, fileId], _previous, { signal }) =>
			ready && token && fileId
				? getFile(token, fileId, signal)
				: Promise.resolve(null),
		{ initialValue: untrack(() => initialDetail) }
	);
	let busy = $state(false);
	let operation = 0;
	let serverLoadError = $state(untrack(() => initialError));
	const detailError = $derived(detail.error?.message ?? serverLoadError);

	$effect(() => {
		id;
		operation += 1;
		busy = false;
	});

	$effect(() => {
		if (detail.current) serverLoadError = '';
	});

	const update = async (mutation: FileMutation, success: string) => {
		const current = detail.current;
		if (!current || busy) return false;
		const fileId = current.file.id;
		const currentOperation = ++operation;
		busy = true;
		try {
			const result = await mutateFile(session.token, fileId, mutation);
			if (
				operation !== currentOperation ||
				detail.current?.file.id !== fileId
			) {
				return false;
			}
			detail.mutate({ ...detail.current, file: result.file });
			if (mutation.action === 'restore-version') {
				await detail.refetch();
				if (
					operation !== currentOperation ||
					detail.current?.file.id !== fileId
				) {
					return false;
				}
			}
			toasts.success(result.forcedPublic ? 'HTML files stay public' : success);
			return true;
		} catch (cause) {
			if (
				operation === currentOperation &&
				detail.current?.file.id === fileId
			) {
				toasts.error(cause, 'Could not update the file');
			}
			return false;
		} finally {
			if (operation === currentOperation) busy = false;
		}
	};

	const fileUrl = (version?: number) => {
		const current = detail.current;
		if (!current) return '';
		if (current.file.kind === 'site')
			return `${current.contentOrigin}/s/${current.file.id}/`;
		return `${current.contentOrigin}/f/${current.file.id}${version ? `?v=${version}` : ''}`;
	};

	const linkFor = async (version?: number) => {
		const current = detail.current;
		if (!current) return { url: '', expiresAt: null };
		const fileId = current.file.id;
		const expirationTime = current.file.expiresAt
			? new Date(current.file.expiresAt).getTime()
			: Number.NaN;
		const unavailable =
			current.file.deletedAt !== null ||
			(Number.isFinite(expirationTime) && expirationTime <= Date.now());
		const link =
			current.file.public && !unavailable
				? { url: fileUrl(version), expiresAt: null }
				: getContentLink(
						session.token,
						current.file.id,
						version,
						undefined,
						unavailable
					);
		const resolved = await link;
		if (detail.current?.file.id !== fileId) {
			throw new Error('The selected file changed before the link was ready');
		}
		return resolved;
	};

	const resolveLink = async (version?: number) => (await linkFor(version)).url;

	const openLink = async (version?: number) => {
		try {
			const current = detail.current;
			if (!current) return;
			const fileId = current.file.id;
			const link = await linkFor(version);
			if (detail.current?.file.id !== fileId) return;
			if (current.file.public) {
				window.open(link.url, '_blank', 'noopener');
			} else {
				const anchor = document.createElement('a');
				anchor.href = link.url;
				anchor.download = current.file.displayName;
				document.body.appendChild(anchor);
				anchor.click();
				anchor.remove();
			}
		} catch (cause) {
			toasts.error(cause, 'Could not open the file');
		}
	};

	const toggleTag = async (tag: Tag) => {
		const current = detail.current;
		if (!current || busy) return;
		const fileId = current.file.id;
		const currentOperation = ++operation;
		busy = true;
		try {
			const selected = current.file.tags.some((item) => item.id === tag.id)
				? current.file.tags.filter((item) => item.id !== tag.id)
				: [...current.file.tags, tag];
			const file = await setFileTags(session.token, current.file.id, selected);
			if (
				operation !== currentOperation ||
				detail.current?.file.id !== fileId
			) {
				return;
			}
			detail.mutate({ ...current, file });
		} catch (cause) {
			if (
				operation === currentOperation &&
				detail.current?.file.id === fileId
			) {
				toasts.error(cause, 'Could not update tags');
			}
		} finally {
			if (operation === currentOperation) busy = false;
		}
	};

	const addTag = async (name: string) => {
		const current = detail.current;
		if (!current || busy) return;
		const fileId = current.file.id;
		const currentOperation = ++operation;
		busy = true;
		try {
			const tag = await createTag(session.token, { name });
			const selected = current.file.tags.some((item) => item.id === tag.id)
				? current.file.tags
				: [...current.file.tags, tag];
			const file = await setFileTags(session.token, current.file.id, selected);
			if (
				operation !== currentOperation ||
				detail.current?.file.id !== fileId
			) {
				return;
			}
			detail.mutate({
				...current,
				file,
				availableTags: current.availableTags.some((item) => item.id === tag.id)
					? current.availableTags
					: [...current.availableTags, tag]
			});
		} catch (cause) {
			if (
				operation === currentOperation &&
				detail.current?.file.id === fileId
			) {
				toasts.error(cause, 'Could not create the tag');
			}
			throw cause;
		} finally {
			if (operation === currentOperation) busy = false;
		}
	};

	const putVersion = async (file: File) => {
		const current = detail.current;
		if (!current || busy) return;
		const fileId = current.file.id;
		const currentOperation = ++operation;
		if (file.size > current.maxUploadBytes) {
			toasts.error(
				new Error('The selected file is larger than the upload limit')
			);
			return;
		}
		busy = true;
		try {
			await uploadVersion(session.token, current.file.id, file);
			if (
				operation !== currentOperation ||
				detail.current?.file.id !== fileId
			) {
				return;
			}
			await detail.refetch();
			if (
				operation === currentOperation &&
				detail.current?.file.id === fileId
			) {
				toasts.success('New version uploaded');
			}
		} catch (cause) {
			if (
				operation === currentOperation &&
				detail.current?.file.id === fileId
			) {
				toasts.error(cause, 'Could not upload the version');
			}
		} finally {
			if (operation === currentOperation) busy = false;
		}
	};
</script>

<svelte:head>
	<title>{detail.current?.file.displayName ?? 'File'} · adrive</title>
</svelte:head>

<main class="mx-auto max-w-7xl px-4 py-5 sm:px-6 sm:py-8">
	{#if !session.ready || (detail.loading && !detail.current)}
		<div class="animate-pulse py-12">
			<div class="h-8 w-1/2 rounded bg-zinc-100"></div>
			<div class="mt-8 h-[30rem] rounded-xl bg-zinc-100"></div>
		</div>
	{:else if !session.token}
		<div class="py-20 text-center">
			<a href="/" class="text-sm font-medium text-zinc-900">Sign in</a>
		</div>
	{:else if detailError}
		<div class="py-20 text-center">
			<p class="text-sm text-red-700">{detailError}</p>
			<div class="mt-4 flex justify-center gap-3">
				<button
					type="button"
					class="text-sm font-medium text-zinc-900"
					onclick={() => void detail.refetch()}>Try again</button
				>
				<a href={backHref} class="text-sm font-medium">Files</a>
			</div>
		</div>
	{:else if detail.current}
		<header class="mb-6 flex min-w-0 items-center gap-2">
			<a
				href={backHref}
				class="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-2 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
			>
				<Icon name="arrow-left" />
				Files
			</a>
			<FileName
				file={detail.current.file}
				{busy}
				onrename={(displayName) =>
					void update({ action: 'rename', displayName }, 'File renamed')}
			/>
			{#if detail.current.file.deletedAt}
				<span class="rounded-full bg-amber-50 px-2 py-1 text-xs text-amber-700">
					In trash
				</span>
			{/if}
			<CopyButton variant="ghost" resolve={() => resolveLink()} />
		</header>

		<div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
			<FilePreview
				file={detail.current.file}
				token={session.token}
				contentOrigin={detail.current.contentOrigin}
				ondownload={() => void openLink()}
			/>
			<FileSidebar
				file={detail.current.file}
				versions={detail.current.versions}
				availableTags={detail.current.availableTags}
				{busy}
				oncopy={() => resolveLink()}
				ondownload={() => void openLink()}
				onvisibility={(value) =>
					void update(
						{ action: 'visibility', public: value },
						value ? 'File is public' : 'File is private'
					)}
				onexpiration={(expiresAt) =>
					update(
						{ action: 'expiration', expiresAt },
						expiresAt ? 'Expiration updated' : 'Expiration removed'
					)}
				ontag={(tag) => void toggleTag(tag)}
				oncreatetag={addTag}
				onversion={(file) => void putVersion(file)}
				oncopyversion={(version) => resolveLink(version)}
				onopenversion={(version) => void openLink(version)}
				onrestoreversion={(version) =>
					void update(
						{ action: 'restore-version', version },
						`Version ${version} restored as a new version`
					)}
				onreindex={() =>
					void update({ action: 'reindex' }, 'Reindexing queued')}
				ontrash={() => void update({ action: 'trash' }, 'File moved to trash')}
				onrestore={() => void update({ action: 'restore' }, 'File restored')}
			/>
		</div>
	{/if}
</main>
