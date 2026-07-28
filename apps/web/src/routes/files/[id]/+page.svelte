<script lang="ts">
	import { page } from '$app/state';
	import {
		createTag,
		getContentLink,
		getFile,
		getFilePreview,
		mutateFile,
		setFileTags,
		uploadVersion,
		type FileDetailPayload
	} from '$lib/dashboard/api';
	import {
		copyText,
		formatBytes,
		formatDate,
		toLocalDateTimeInput
	} from '$lib/dashboard/format';
	import { renderMarkdown } from '$lib/dashboard/markdown';
	import { getDashboardSession } from '$lib/dashboard/session.svelte';

	const session = getDashboardSession();
	const id = $derived(page.params.id);
	let detail = $state<FileDetailPayload | null>(null);
	let loading = $state(false);
	let error = $state('');
	let message = $state('');
	let refreshing = $state(0);
	let mutating = $state(false);
	let uploading = $state(false);
	let copied = $state('');
	let tagName = $state('');
	let savingTags = $state(false);
	let expirationInput = $state('');
	let run = 0;
	let previewRun = 0;
	let previewText = $state('');
	let previewKind = $state('');
	let previewLoading = $state(false);
	let previewError = $state('');
	const previewHtml = $derived(
		previewKind === 'markdown' ? renderMarkdown(previewText) : ''
	);

	$effect(() => {
		const token = session.token;
		const fileId = id;
		refreshing;
		if (!session.ready || !token || !fileId) {
			detail = null;
			return;
		}

		const mine = ++run;
		const controller = new AbortController();
		loading = true;
		error = '';
		void getFile(token, fileId, controller.signal)
			.then((result) => {
				if (mine === run) {
					detail = result;
					expirationInput = toLocalDateTimeInput(result.file.expiresAt);
				}
			})
			.catch((cause: unknown) => {
				if (mine !== run || controller.signal.aborted) return;
				error = cause instanceof Error ? cause.message : 'Could not load file';
			})
			.finally(() => {
				if (mine === run) loading = false;
			});

		return () => {
			run += 1;
			controller.abort();
		};
	});

	$effect(() => {
		const token = session.token;
		const file = detail?.file;
		if (
			!token ||
			!file ||
			file.deletedAt ||
			file.kind !== 'file' ||
			file.id !== id
		) {
			previewText = '';
			previewKind = '';
			previewError = '';
			previewLoading = false;
			return;
		}
		file.version;

		const mine = ++previewRun;
		const controller = new AbortController();
		previewText = '';
		previewKind = '';
		previewError = '';
		previewLoading = true;
		void getFilePreview(token, file.id, controller.signal)
			.then((result) => {
				if (mine !== previewRun) return;
				previewText = result.text;
				previewKind = result.kind;
			})
			.catch((cause: unknown) => {
				if (mine !== previewRun || controller.signal.aborted) return;
				previewError =
					cause instanceof Error ? cause.message : 'Preview unavailable';
			})
			.finally(() => {
				if (mine === previewRun) previewLoading = false;
			});

		return () => {
			previewRun += 1;
			controller.abort();
		};
	});

	const changeVisibility = async (isPublic: boolean) => {
		if (!detail || mutating) return;
		mutating = true;
		error = '';
		message = '';
		try {
			const result = await mutateFile(session.token, detail.file.id, {
				action: 'visibility',
				public: isPublic
			});
			detail = { ...detail, file: result.file };
			message = result.forcedPublic
				? 'HTML files stay public.'
				: result.file.public
					? 'Public'
					: 'Private';
		} catch (cause) {
			error =
				cause instanceof Error ? cause.message : 'Could not change visibility';
		} finally {
			mutating = false;
		}
	};

	const saveExpiration = async () => {
		if (!detail || mutating) return;
		mutating = true;
		error = '';
		message = '';
		try {
			const expiresAt = expirationInput
				? new Date(expirationInput).toISOString()
				: null;
			const result = await mutateFile(session.token, detail.file.id, {
				action: 'expiration',
				expiresAt
			});
			detail = { ...detail, file: result.file };
			message = expiresAt
				? `Expires ${formatDate(expiresAt)}`
				: 'Expiration removed';
		} catch (cause) {
			error =
				cause instanceof Error ? cause.message : 'Could not update expiration';
		} finally {
			mutating = false;
		}
	};

	const changeTrashState = async (action: 'trash' | 'restore') => {
		if (!detail || mutating) return;
		mutating = true;
		error = '';
		message = '';
		try {
			const result = await mutateFile(session.token, detail.file.id, {
				action
			});
			detail = { ...detail, file: result.file };
			message = action === 'trash' ? 'File moved to trash.' : 'File restored.';
		} catch (cause) {
			error =
				cause instanceof Error ? cause.message : 'Could not update the file';
		} finally {
			mutating = false;
		}
	};

	const reindex = async () => {
		if (!detail || mutating) return;
		mutating = true;
		error = '';
		message = '';
		try {
			const result = await mutateFile(session.token, detail.file.id, {
				action: 'reindex'
			});
			detail = { ...detail, file: result.file };
			message = 'Reindexing';
			refreshing += 1;
		} catch (cause) {
			error =
				cause instanceof Error ? cause.message : 'Could not queue indexing';
		} finally {
			mutating = false;
		}
	};

	const putVersion = async (file: File) => {
		if (!detail || uploading) return;
		if (file.size > detail.maxUploadBytes) {
			error = 'The selected file is larger than the upload limit.';
			return;
		}
		uploading = true;
		error = '';
		message = '';
		try {
			const result = await uploadVersion(session.token, detail.file.id, file);
			message = result.forcedPublic
				? 'Uploaded · public'
				: `Version ${result.file.version} uploaded`;
			refreshing += 1;
		} catch (cause) {
			error =
				cause instanceof Error ? cause.message : 'Could not upload the version';
		} finally {
			uploading = false;
		}
	};

	const copyLink = async (version?: number) => {
		if (!detail) return;
		const fileId = detail.file.id;
		const isSite = detail.file.kind === 'site';
		const isPublic = detail.file.public;
		const suffix = isSite || version === undefined ? '' : `?v=${version}`;
		try {
			const link =
				isSite || isPublic
					? {
							url: `${detail.contentOrigin}/${isSite ? 's' : 'f'}/${fileId}${isSite ? '/' : ''}${suffix}`,
							expiresAt: null
						}
					: await getContentLink(session.token, fileId, version);
			if (detail?.file.id !== fileId) return;
			await copyText(link.url);
			copied = version === undefined ? 'current' : String(version);
			message = link.expiresAt ? 'Link copied · 15 min' : 'Link copied';
			window.setTimeout(() => {
				copied = '';
			}, 1500);
		} catch (cause) {
			error =
				cause instanceof Error ? cause.message : 'Could not copy the link.';
		}
	};

	const downloadPrivate = async (version?: number) => {
		if (!detail) return;
		const fileId = detail.file.id;
		try {
			const link = await getContentLink(session.token, fileId, version);
			if (detail?.file.id !== fileId) return;
			window.location.assign(link.url);
		} catch (cause) {
			error =
				cause instanceof Error ? cause.message : 'Could not download the file.';
		}
	};

	const copyRepublishCommand = async () => {
		if (!detail) return;
		try {
			await copyText(`adrive site put ./dist --id ${detail.file.id}`);
			copied = 'command';
			window.setTimeout(() => {
				copied = '';
			}, 1500);
		} catch {
			error = 'Could not copy the republish command.';
		}
	};

	const fileUrl = (version?: number) => {
		if (!detail) return '';
		const { file, contentOrigin } = detail;
		if (file.kind === 'site') return `${contentOrigin}/s/${file.id}/`;
		return `${contentOrigin}/f/${file.id}${version ? `?v=${version}` : ''}`;
	};

	const toggleTag = async (tagId: string) => {
		if (!detail || savingTags) return;
		savingTags = true;
		error = '';
		message = '';
		try {
			const current = detail.availableTags.find((tag) => tag.id === tagId);
			if (!current) return;
			const selected = detail.file.tags.some((tag) => tag.id === tagId)
				? detail.file.tags.filter((tag) => tag.id !== tagId)
				: [...detail.file.tags, current];
			const file = await setFileTags(session.token, detail.file.id, selected);
			detail = { ...detail, file };
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not update tags';
		} finally {
			savingTags = false;
		}
	};

	const addTag = async () => {
		if (!detail || !tagName.trim() || savingTags) return;
		savingTags = true;
		error = '';
		message = '';
		try {
			const tag = await createTag(session.token, { name: tagName });
			const selected = detail.file.tags.some((current) => current.id === tag.id)
				? detail.file.tags
				: [...detail.file.tags, tag];
			const file = await setFileTags(session.token, detail.file.id, selected);
			detail = {
				...detail,
				file,
				availableTags: detail.availableTags.some(
					(current) => current.id === tag.id
				)
					? detail.availableTags
					: [...detail.availableTags, tag]
			};
			tagName = '';
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Could not add the tag';
		} finally {
			savingTags = false;
		}
	};
</script>

<svelte:head>
	<title>{detail?.file.displayName ?? 'File'} · adrive</title>
</svelte:head>

<main class="mx-auto max-w-7xl px-4 py-5 sm:px-6">
	{#if !session.ready || loading}
		<div class="mx-auto max-w-3xl animate-pulse py-16">
			<div class="h-8 w-2/3 rounded bg-zinc-100"></div>
			<div class="mt-8 h-4 w-full rounded bg-zinc-100"></div>
			<div class="mt-3 h-4 w-5/6 rounded bg-zinc-100"></div>
		</div>
	{:else if !session.token}
		<div class="py-20 text-center">
			<a href="/" class="text-sm font-medium text-zinc-900">Sign in</a>
		</div>
	{:else if error && !detail}
		<div class="py-20 text-center">
			<p class="text-sm text-red-700">{error}</p>
			<a href="/" class="mt-3 inline-block text-sm font-medium text-zinc-900">
				Files
			</a>
		</div>
	{:else if detail}
		<header
			class="relative z-30 flex min-h-10 flex-wrap items-center gap-2 border-b border-zinc-100 pb-4"
		>
			<a
				href="/"
				class="flex size-9 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
				aria-label="Back to files"
			>
				<span aria-hidden="true">←</span>
			</a>
			<p class="min-w-0 flex-1 truncate text-sm font-medium text-zinc-900">
				{detail.file.displayName}
			</p>

			{#if detail.file.deletedAt}
				<span class="text-xs text-amber-700">In trash</span>
				<button
					type="button"
					disabled={mutating}
					class="rounded-md px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-50"
					onclick={() => void changeTrashState('restore')}>Restore</button
				>
			{:else}
				{#if detail.file.public}
					<a
						href={fileUrl()}
						target="_blank"
						rel="noreferrer"
						class="rounded-md px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100"
					>
						Open
					</a>
				{:else}
					<button
						type="button"
						class="rounded-md px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100"
						onclick={() => void downloadPrivate()}>Download</button
					>
				{/if}

				<details name="file-toolbar" class="group relative">
					<summary
						class="list-none rounded-md px-3 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 [&::-webkit-details-marker]:hidden"
					>
						Tags{#if detail.file.tags.length > 0}
							· {detail.file.tags.length}{/if}
					</summary>
					<div
						class="absolute top-11 right-0 z-40 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-zinc-200 bg-white p-4 shadow-xl"
					>
						{#if detail.availableTags.length > 0}
							<div class="flex flex-wrap gap-2">
								{#each detail.availableTags as tag (tag.id)}
									<button
										type="button"
										disabled={savingTags}
										aria-pressed={detail.file.tags.some(
											(current) => current.id === tag.id
										)}
										class="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium disabled:opacity-50 {detail.file.tags.some(
											(current) => current.id === tag.id
										)
											? 'border-accent-500 bg-accent-50 text-accent-700'
											: 'border-zinc-200 text-zinc-600 hover:border-zinc-300'}"
										onclick={() => void toggleTag(tag.id)}
									>
										<span
											class="size-2 rounded-full"
											style:background={tag.color ?? '#a1a1aa'}
										></span>
										{tag.name}
									</button>
								{/each}
							</div>
						{/if}
						<form
							class="flex gap-2 {detail.availableTags.length > 0 ? 'mt-4' : ''}"
							onsubmit={(event) => {
								event.preventDefault();
								void addTag();
							}}
						>
							<input
								aria-label="New tag"
								bind:value={tagName}
								placeholder="New tag"
								class="min-w-0 flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm"
							/>
							<button
								type="submit"
								disabled={!tagName.trim() || savingTags}
								class="rounded-md bg-zinc-950 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
								>Add</button
							>
						</form>
					</div>
				</details>

				<details name="file-toolbar" class="group relative">
					<summary
						class="list-none rounded-md px-3 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 [&::-webkit-details-marker]:hidden"
					>
						History
					</summary>
					<ol
						class="absolute top-11 right-0 z-40 max-h-[70vh] w-[min(28rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-zinc-200 bg-white p-2 shadow-xl"
					>
						{#each detail.versions as version (version.version)}
							<li
								class="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-zinc-50"
							>
								<div class="min-w-0">
									<p class="text-sm font-medium text-zinc-800">
										v{version.version}{version.version === detail.file.version
											? ' · current'
											: ''}
									</p>
									<p class="truncate text-xs text-zinc-400">
										{formatBytes(version.sizeBytes)} · {formatDate(
											version.createdAt
										)}
									</p>
								</div>
								{#if detail.file.kind === 'file' || version.version === detail.file.version}
									<div class="flex shrink-0 items-center">
										<button
											type="button"
											class="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
											onclick={() => void copyLink(version.version)}
										>
											{copied === String(version.version) ? 'Copied' : 'Copy'}
										</button>
										{#if detail.file.public}
											<a
												href={fileUrl(version.version)}
												target="_blank"
												rel="noreferrer"
												class="rounded px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
												>Open</a
											>
										{:else}
											<button
												type="button"
												class="rounded px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
												onclick={() => void downloadPrivate(version.version)}
												>Get</button
											>
										{/if}
									</div>
								{/if}
							</li>
						{/each}
					</ol>
				</details>

				<details name="file-toolbar" class="group relative">
					<summary
						class="flex size-9 list-none items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 [&::-webkit-details-marker]:hidden"
						aria-label="File settings"
					>
						<span aria-hidden="true">•••</span>
					</summary>
					<div
						class="absolute top-11 right-0 z-40 max-h-[75vh] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-zinc-200 bg-white p-4 shadow-xl"
					>
						<button
							type="button"
							class="mb-4 w-full rounded-md border border-zinc-200 px-3 py-2 text-left text-sm font-medium text-zinc-700 hover:bg-zinc-50"
							onclick={() => void copyLink()}
						>
							{copied === 'current' ? 'Copied' : 'Copy link'}
						</button>

						<label
							class="flex items-center justify-between border-t border-zinc-100 py-3 text-sm text-zinc-700"
							title={detail.file.htmlForcedPublic
								? 'HTML files are always public'
								: undefined}
						>
							<span>Public</span>
							<input
								type="checkbox"
								checked={detail.file.public}
								disabled={mutating ||
									detail.file.htmlForcedPublic ||
									detail.file.kind === 'site'}
								class="size-4 accent-accent-600 disabled:opacity-50"
								onchange={(event) =>
									void changeVisibility(event.currentTarget.checked)}
							/>
						</label>

						<div class="border-t border-zinc-100 py-3">
							<label for="file-expiration" class="text-sm text-zinc-700">
								Expires
							</label>
							<div class="mt-2 flex gap-2">
								<input
									id="file-expiration"
									type="datetime-local"
									bind:value={expirationInput}
									class="min-w-0 flex-1 rounded-md border border-zinc-300 px-2 py-1.5 text-xs"
								/>
								<button
									type="button"
									disabled={mutating}
									class="rounded-md border border-zinc-200 px-2.5 py-1.5 text-xs font-medium disabled:opacity-50"
									onclick={() => void saveExpiration()}>Save</button
								>
							</div>
						</div>

						<div
							class="flex items-center justify-between border-t border-zinc-100 py-3"
						>
							<span class="text-sm text-zinc-700">
								{detail.file.kind === 'site' ? 'Republish' : 'New version'}
							</span>
							{#if detail.file.kind === 'site'}
								<button
									type="button"
									class="rounded-md border border-zinc-200 px-2.5 py-1.5 text-xs font-medium"
									onclick={() => void copyRepublishCommand()}
								>
									{copied === 'command' ? 'Copied' : 'Copy command'}
								</button>
							{:else}
								<label
									class="rounded-md border border-zinc-200 px-2.5 py-1.5 text-xs font-medium"
								>
									{uploading ? 'Uploading…' : 'Choose'}
									<input
										type="file"
										class="sr-only"
										disabled={uploading}
										onchange={(event) => {
											const input = event.currentTarget;
											const file = input.files?.[0];
											if (file) void putVersion(file);
											input.value = '';
										}}
									/>
								</label>
							{/if}
						</div>

						<div
							class="flex items-center justify-between border-t border-zinc-100 py-3"
						>
							<span class="text-sm text-zinc-700">
								Index · {detail.file.indexState}
							</span>
							<button
								type="button"
								disabled={mutating}
								class="rounded-md border border-zinc-200 px-2.5 py-1.5 text-xs font-medium disabled:opacity-50"
								onclick={() => void reindex()}>Reindex</button
							>
						</div>

						<dl
							class="space-y-1 border-t border-zinc-100 py-3 text-xs text-zinc-400"
						>
							<div class="flex justify-between gap-3">
								<dt>Size</dt>
								<dd>{formatBytes(detail.file.sizeBytes)}</dd>
							</div>
							<div class="flex justify-between gap-3">
								<dt>Updated</dt>
								<dd>{formatDate(detail.file.updatedAt)}</dd>
							</div>
							<div class="flex justify-between gap-3">
								<dt>Downloads</dt>
								<dd>{detail.file.downloadCount}</dd>
							</div>
							<div class="flex justify-between gap-3">
								<dt>Version</dt>
								<dd>{detail.file.version}</dd>
							</div>
							<div class="mt-2 break-all font-mono">{detail.file.id}</div>
						</dl>

						<button
							type="button"
							disabled={mutating}
							class="w-full border-t border-zinc-100 pt-3 text-left text-sm font-medium text-red-600 disabled:opacity-50"
							onclick={() => void changeTrashState('trash')}
						>
							Move to trash
						</button>
					</div>
				</details>
			{/if}

			{#if detail.file.tags.length > 0}
				<div
					class="flex w-full flex-wrap gap-2 pt-2 sm:pl-11"
					aria-label="File tags"
				>
					{#each detail.file.tags as tag (tag.id)}
						<span
							class="inline-flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm font-medium text-zinc-700"
						>
							<span
								class="size-2.5 rounded-full"
								style:background={tag.color ?? '#a1a1aa'}
							></span>
							{tag.name}
						</span>
					{/each}
				</div>
			{/if}
		</header>

		{#if error}
			<p class="mt-3 text-sm text-red-700" role="alert">{error}</p>
		{/if}
		{#if message}
			<p class="mt-3 text-sm text-zinc-500" aria-live="polite">{message}</p>
		{/if}

		{#if !detail.file.deletedAt}
			<div class="mx-auto max-w-3xl py-10 sm:py-14">
				{#if previewLoading}
					<div class="animate-pulse space-y-4">
						<div class="h-9 w-2/3 rounded bg-zinc-100"></div>
						<div class="h-4 w-full rounded bg-zinc-100"></div>
						<div class="h-4 w-5/6 rounded bg-zinc-100"></div>
						<div class="h-4 w-4/5 rounded bg-zinc-100"></div>
					</div>
				{:else if previewKind === 'markdown'}
					<article class="markdown-preview">
						{@html previewHtml}
					</article>
				{:else if previewKind === 'text'}
					<pre
						class="overflow-x-auto whitespace-pre-wrap font-mono text-sm leading-7 text-zinc-800">{previewText}</pre>
				{:else if detail.file.kind === 'site'}
					<a
						href={fileUrl()}
						target="_blank"
						rel="noreferrer"
						class="text-sm font-medium text-zinc-900 underline decoration-zinc-300 underline-offset-4"
						>Open site</a
					>
				{:else if previewError}
					<p class="text-sm text-zinc-400">{previewError}</p>
				{/if}
			</div>
		{/if}
	{/if}
</main>
