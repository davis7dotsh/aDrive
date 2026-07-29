<script lang="ts">
	import type { FileMutation, Tag } from '@adrive/shared';
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
				: Promise.resolve(null)
	);
	let busy = $state(false);

	const update = async (mutation: FileMutation, success: string) => {
		if (!detail.current || busy) return;
		busy = true;
		try {
			const result = await mutateFile(
				session.token,
				detail.current.file.id,
				mutation
			);
			detail.mutate({ ...detail.current, file: result.file });
			toasts.success(result.forcedPublic ? 'HTML files stay public' : success);
		} catch (cause) {
			toasts.error(cause, 'Could not update the file');
		} finally {
			busy = false;
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
		return current.file.public
			? { url: fileUrl(version), expiresAt: null }
			: getContentLink(session.token, current.file.id, version);
	};

	const resolveLink = async (version?: number) => (await linkFor(version)).url;

	const openLink = async (version?: number) => {
		try {
			const current = detail.current;
			if (!current) return;
			const link = await linkFor(version);
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
		busy = true;
		try {
			const selected = current.file.tags.some((item) => item.id === tag.id)
				? current.file.tags.filter((item) => item.id !== tag.id)
				: [...current.file.tags, tag];
			const file = await setFileTags(session.token, current.file.id, selected);
			detail.mutate({ ...current, file });
		} catch (cause) {
			toasts.error(cause, 'Could not update tags');
		} finally {
			busy = false;
		}
	};

	const addTag = async (name: string) => {
		const current = detail.current;
		if (!current || busy) return;
		busy = true;
		try {
			const tag = await createTag(session.token, { name });
			const selected = current.file.tags.some((item) => item.id === tag.id)
				? current.file.tags
				: [...current.file.tags, tag];
			const file = await setFileTags(session.token, current.file.id, selected);
			detail.mutate({
				...current,
				file,
				availableTags: current.availableTags.some((item) => item.id === tag.id)
					? current.availableTags
					: [...current.availableTags, tag]
			});
		} catch (cause) {
			toasts.error(cause, 'Could not create the tag');
		} finally {
			busy = false;
		}
	};

	const putVersion = async (file: File) => {
		const current = detail.current;
		if (!current || busy) return;
		if (file.size > current.maxUploadBytes) {
			toasts.error(
				new Error('The selected file is larger than the upload limit')
			);
			return;
		}
		busy = true;
		try {
			await uploadVersion(session.token, current.file.id, file);
			await detail.refetch();
			toasts.success('New version uploaded');
		} catch (cause) {
			toasts.error(cause, 'Could not upload the version');
		} finally {
			busy = false;
		}
	};
</script>

<svelte:head>
	<title>{detail.current?.file.displayName ?? 'File'} · adrive</title>
</svelte:head>

<main class="mx-auto max-w-7xl px-4 py-5 sm:px-6 sm:py-8">
	{#if !session.ready || detail.loading}
		<div class="animate-pulse py-12">
			<div class="h-8 w-1/2 rounded bg-zinc-100"></div>
			<div class="mt-8 h-[30rem] rounded-xl bg-zinc-100"></div>
		</div>
	{:else if !session.token}
		<div class="py-20 text-center">
			<a href="/" class="text-sm font-medium text-zinc-900">Sign in</a>
		</div>
	{:else if detail.error}
		<div class="py-20 text-center">
			<p class="text-sm text-red-700">{detail.error.message}</p>
			<a href={backHref} class="mt-3 inline-block text-sm font-medium">
				Files
			</a>
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
					void update(
						{ action: 'expiration', expiresAt },
						expiresAt ? 'Expiration updated' : 'Expiration removed'
					)}
				ontag={(tag) => void toggleTag(tag)}
				oncreatetag={(name) => void addTag(name)}
				onversion={(file) => void putVersion(file)}
				oncopyversion={(version) => resolveLink(version)}
				onopenversion={(version) => void openLink(version)}
				onreindex={() =>
					void update({ action: 'reindex' }, 'Reindexing queued')}
				ontrash={() => void update({ action: 'trash' }, 'File moved to trash')}
				onrestore={() => void update({ action: 'restore' }, 'File restored')}
			/>
		</div>
	{/if}
</main>
