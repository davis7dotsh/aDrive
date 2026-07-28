<script lang="ts">
	import { page } from '$app/state';
	import {
		createTag,
		getFile,
		mutateFile,
		setFileTags,
		uploadVersion,
		type FileDetailPayload
	} from '$lib/dashboard/api';
	import { copyText, formatBytes, formatDate } from '$lib/dashboard/format';
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
					expirationInput = result.file.expiresAt
						? result.file.expiresAt.slice(0, 16)
						: '';
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
				? 'HTML is always public, so this file stayed public.'
				: `File is now ${result.file.public ? 'public' : 'private'}.`;
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
				? `File expires ${formatDate(expiresAt)}.`
				: 'File expiration removed.';
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
			message =
				'Indexing queued. Extracted-text search updates in the background.';
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
				? 'New version uploaded. This file is now public because HTML is always public.'
				: `Version ${result.file.version} uploaded.`;
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
		const isSite = detail.file.kind === 'site';
		const suffix = isSite || version === undefined ? '' : `?v=${version}`;
		try {
			await copyText(
				`${detail.contentOrigin}/${isSite ? 's' : 'f'}/${detail.file.id}${isSite ? '/' : ''}${suffix}`
			);
			copied = version === undefined ? 'current' : String(version);
			window.setTimeout(() => {
				copied = '';
			}, 1500);
		} catch {
			error = 'Could not copy the link.';
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
			message = 'Tags updated.';
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
			message = `${tag.name} added.`;
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

<main class="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
	<a
		href="/"
		class="inline-flex items-center gap-1 text-sm text-zinc-500 transition hover:text-zinc-900"
	>
		<span aria-hidden="true">←</span>
		All files
	</a>

	{#if !session.ready || loading}
		<div
			class="mt-6 animate-pulse rounded-lg border border-zinc-200 bg-white p-8"
		>
			<div class="h-7 w-1/2 rounded bg-zinc-200"></div>
			<div class="mt-4 h-4 w-1/3 rounded bg-zinc-100"></div>
		</div>
	{:else if !session.token}
		<section
			class="mt-6 rounded-lg border border-zinc-200 bg-white p-8 text-center"
		>
			<h1 class="text-lg font-semibold text-zinc-900">Connect first</h1>
			<p class="mt-2 text-sm text-zinc-500">
				Use the dashboard home page to connect an existing API key.
			</p>
			<a
				href="/"
				class="mt-5 inline-flex rounded-md bg-zinc-950 px-4 py-2 text-sm font-medium text-white"
			>
				Go to dashboard
			</a>
		</section>
	{:else if error && !detail}
		<section class="mt-6 rounded-lg border border-red-200 bg-red-50 p-6">
			<h1 class="font-semibold text-red-900">File unavailable</h1>
			<p class="mt-1 text-sm text-red-700">{error}</p>
		</section>
	{:else if detail}
		{#if detail.file.deletedAt}
			<div
				class="mt-6 flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
			>
				<p class="text-sm text-amber-900">
					This file is in trash. Its content links are unavailable until
					restored.
				</p>
				<button
					type="button"
					disabled={mutating}
					class="self-start rounded-md bg-white px-3 py-1.5 text-sm font-medium text-amber-900 shadow-sm ring-1 ring-amber-200 disabled:opacity-50"
					onclick={() => void changeTrashState('restore')}
				>
					Restore
				</button>
			</div>
		{/if}

		<section
			class="mt-6 rounded-lg border border-zinc-200 bg-white p-5 shadow-sm sm:p-7"
		>
			<div
				class="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between"
			>
				<div class="min-w-0">
					<div class="flex flex-wrap items-center gap-2">
						<h1
							class="break-all text-2xl font-semibold tracking-tight text-zinc-950"
						>
							{detail.file.displayName}
						</h1>
						<span
							class="rounded-full px-2 py-0.5 text-xs font-medium {detail.file
								.public
								? 'bg-emerald-50 text-emerald-700'
								: 'bg-zinc-100 text-zinc-600'}"
						>
							{detail.file.public ? 'Public' : 'Private'}
						</span>
						{#if detail.file.kind === 'site'}
							<span
								class="rounded-full bg-accent-50 px-2 py-0.5 text-xs font-medium text-accent-700"
								>Site</span
							>
						{/if}
					</div>
					<p class="mt-2 text-sm text-zinc-500">
						{formatBytes(detail.file.sizeBytes)} · Version {detail.file.version}
						· Updated {formatDate(detail.file.updatedAt)}
					</p>
					<p class="mt-1 text-xs text-zinc-400">
						{detail.file.downloadCount}
						{detail.file.downloadCount === 1 ? 'download' : 'downloads'}
						{detail.file.lastDownloadAt
							? ` · last ${formatDate(detail.file.lastDownloadAt)}`
							: ''}
						{detail.file.expiresAt
							? ` · expires ${formatDate(detail.file.expiresAt)}`
							: ''}
					</p>
					<p class="mt-1 font-mono text-xs break-all text-zinc-400">
						{detail.file.id}
					</p>
					{#if !detail.file.public && !detail.file.deletedAt}
						<p class="mt-2 text-xs text-zinc-500">
							The share link returns 404 while this file is private.
						</p>
					{/if}
				</div>
				{#if !detail.file.deletedAt}
					<div class="flex shrink-0 items-center gap-2">
						<button
							type="button"
							class="rounded-md border border-zinc-200 px-3 py-2 text-sm font-medium text-zinc-700 transition hover:border-zinc-300"
							onclick={() => void copyLink()}
						>
							{copied === 'current' ? 'Copied' : 'Copy link'}
						</button>
						{#if detail.file.public}
							<a
								href={`${detail.contentOrigin}/${detail.file.kind === 'site' ? 's' : 'f'}/${detail.file.id}${detail.file.kind === 'site' ? '/' : ''}`}
								target="_blank"
								rel="noreferrer"
								class="rounded-md bg-zinc-950 px-3 py-2 text-sm font-medium text-white transition hover:bg-zinc-800"
							>
								Open
							</a>
						{/if}
					</div>
				{/if}
			</div>

			{#if error}
				<p
					class="mt-5 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
					role="alert"
				>
					{error}
				</p>
			{/if}
			{#if message}
				<p
					class="mt-5 rounded-md bg-zinc-50 px-3 py-2 text-sm text-zinc-700"
					aria-live="polite"
				>
					{message}
				</p>
			{/if}

			{#if !detail.file.deletedAt}
				<div
					class="mt-7 grid gap-5 border-t border-zinc-100 pt-6 sm:grid-cols-2"
				>
					<div>
						<p class="text-sm font-medium text-zinc-900">Visibility</p>
						<p class="mt-1 text-xs leading-5 text-zinc-500">
							{detail.file.kind === 'site'
								? 'Sites are always public.'
								: 'Public files work for anyone with the content link.'}
						</p>
						<label
							class="mt-3 inline-flex items-center gap-3 text-sm text-zinc-700"
						>
							<input
								type="checkbox"
								checked={detail.file.public}
								disabled={mutating ||
									detail.file.htmlForcedPublic ||
									detail.file.kind === 'site'}
								class="size-4 rounded border-zinc-300 accent-accent-600 disabled:opacity-50"
								onchange={(event) =>
									void changeVisibility(event.currentTarget.checked)}
							/>
							Public
						</label>
						{#if detail.file.htmlForcedPublic}
							<p class="mt-2 text-xs text-amber-700">
								HTML is forced public so executable content never crosses the
								private-file auth boundary.
							</p>
						{/if}
					</div>
					<div>
						<p class="text-sm font-medium text-zinc-900">
							{detail.file.kind === 'site' ? 'Republish site' : 'New version'}
						</p>
						{#if detail.file.kind === 'site'}
							<p class="mt-1 text-xs leading-5 text-zinc-500">
								Publish a new directory version from the CLI. Only the newest
								site remains servable.
							</p>
							<button
								type="button"
								class="mt-3 inline-flex rounded-md border border-zinc-200 px-3 py-2 font-mono text-xs font-medium text-zinc-700 transition hover:border-zinc-300"
								onclick={() => void copyRepublishCommand()}
							>
								{copied === 'command'
									? 'Copied'
									: `adrive site put ./dist --id ${detail.file.id}`}
							</button>
						{:else}
							<p class="mt-1 text-xs leading-5 text-zinc-500">
								Replaces the current bytes while preserving every prior version.
							</p>
							<label
								class="mt-3 inline-flex rounded-md border border-zinc-200 px-3 py-2 text-sm font-medium text-zinc-700 transition hover:border-zinc-300"
							>
								{uploading ? 'Uploading…' : 'Choose file'}
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
					<div class="sm:col-span-2">
						<p class="text-sm font-medium text-zinc-900">Expiration</p>
						<p class="mt-1 text-xs leading-5 text-zinc-500">
							Expired content becomes unavailable immediately. The background
							sweeper later removes stored bytes.
						</p>
						<div class="mt-3 flex flex-wrap gap-2">
							<input
								type="datetime-local"
								bind:value={expirationInput}
								class="rounded-md border border-zinc-300 px-3 py-2 text-sm"
							/>
							<button
								type="button"
								disabled={mutating}
								class="rounded-md border border-zinc-200 px-3 py-2 text-sm font-medium disabled:opacity-50"
								onclick={() => void saveExpiration()}>Save expiration</button
							>
						</div>
					</div>
					<div class="sm:col-span-2">
						<div class="flex flex-wrap items-start justify-between gap-3">
							<div>
								<p class="text-sm font-medium text-zinc-900">Search index</p>
								<p class="mt-1 text-xs leading-5 text-zinc-500">
									{detail.file.indexState === 'ready'
										? `Semantic index ready for version ${detail.file.indexedVersion}.`
										: detail.file.indexState === 'disabled'
											? 'Extracted-text search is ready. Semantic search is disabled because AI bindings are absent.'
											: detail.file.indexState === 'failed'
												? `Indexing stopped after ${detail.file.indexAttempts} attempts.`
												: 'Extraction and semantic enrichment are queued in the background.'}
								</p>
								{#if detail.file.indexError}
									<p class="mt-1 max-w-2xl text-xs text-amber-700">
										{detail.file.indexError}
									</p>
								{/if}
								{#if detail.semanticEnabled}
									<p class="mt-1 text-xs text-zinc-400">
										Vectorize queries are usage-billed against stored vectors ×
										384 dimensions.
									</p>
								{/if}
							</div>
							<div class="flex items-center gap-2">
								<span
									class="rounded-full bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-600"
								>
									{detail.file.indexState}
								</span>
								<button
									type="button"
									disabled={mutating}
									class="rounded-md border border-zinc-200 px-3 py-2 text-sm font-medium disabled:opacity-50"
									onclick={() => void reindex()}>Reindex</button
								>
							</div>
						</div>
					</div>
				</div>
				<div class="mt-6 border-t border-zinc-100 pt-5">
					<div class="mb-6">
						<p class="text-sm font-medium text-zinc-900">Tags</p>
						<p class="mt-1 text-xs leading-5 text-zinc-500">
							Select any existing tag, or type a new one to create it on use.
						</p>
						{#if detail.availableTags.length > 0}
							<div class="mt-3 flex flex-wrap gap-2">
								{#each detail.availableTags as tag (tag.id)}
									<button
										type="button"
										disabled={savingTags}
										aria-pressed={detail.file.tags.some(
											(current) => current.id === tag.id
										)}
										class="rounded-full border px-2.5 py-1 text-xs font-medium disabled:opacity-50 {detail.file.tags.some(
											(current) => current.id === tag.id
										)
											? 'border-accent-500 bg-accent-50 text-accent-700'
											: 'border-zinc-200 text-zinc-600'}"
										onclick={() => void toggleTag(tag.id)}
									>
										<span
											class="mr-1 inline-block size-2 rounded-full"
											style={`background:${tag.color ?? '#a1a1aa'}`}
										></span>
										{tag.name}
									</button>
								{/each}
							</div>
						{/if}
						<form
							class="mt-3 flex max-w-md gap-2"
							onsubmit={(event) => {
								event.preventDefault();
								void addTag();
							}}
						>
							<input
								aria-label="New tag name"
								bind:value={tagName}
								placeholder="Create and assign a tag"
								class="min-w-0 flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm"
							/>
							<button
								type="submit"
								disabled={!tagName.trim() || savingTags}
								class="rounded-md border border-zinc-200 px-3 py-2 text-sm font-medium disabled:opacity-50"
								>Add</button
							>
						</form>
					</div>
					<button
						type="button"
						disabled={mutating}
						class="text-sm font-medium text-red-600 transition hover:text-red-800 disabled:opacity-50"
						onclick={() => void changeTrashState('trash')}
					>
						Move to trash
					</button>
				</div>
			{/if}
		</section>

		<section
			class="mt-6 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm"
		>
			<div class="border-b border-zinc-200 px-5 py-4">
				<h2 class="text-sm font-semibold text-zinc-900">Version history</h2>
				<p class="mt-1 text-xs text-zinc-500">
					{detail.file.kind === 'site'
						? 'Audit history. Prior site assets are removed and cannot be served.'
						: 'Append-only history. Individual versions cannot be deleted.'}
				</p>
			</div>
			<ol class="divide-y divide-zinc-100">
				{#each detail.versions as version}
					<li
						class="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
					>
						<div>
							<div class="flex items-center gap-2">
								<p class="text-sm font-medium text-zinc-900">
									Version {version.version}
								</p>
								{#if version.version === detail.file.version}
									<span
										class="rounded bg-accent-50 px-1.5 py-0.5 text-[11px] font-medium text-accent-700"
									>
										Current
									</span>
								{/if}
							</div>
							<p class="mt-1 text-xs text-zinc-400">
								{formatBytes(version.sizeBytes)} · {version.contentType} ·
								{formatDate(version.createdAt)}
							</p>
						</div>
						{#if !detail.file.deletedAt && (detail.file.kind === 'file' || version.version === detail.file.version)}
							<div class="flex items-center gap-2">
								<button
									type="button"
									class="rounded-md px-2.5 py-1.5 text-xs font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
									onclick={() => void copyLink(version.version)}
								>
									{copied === String(version.version) ? 'Copied' : 'Copy link'}
								</button>
								{#if detail.file.public}
									<a
										href={`${detail.contentOrigin}/${detail.file.kind === 'site' ? 's' : 'f'}/${detail.file.id}${detail.file.kind === 'site' ? '/' : `?v=${version.version}`}`}
										target="_blank"
										rel="noreferrer"
										class="rounded-md border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:border-zinc-300"
									>
										Open
									</a>
								{/if}
							</div>
						{/if}
					</li>
				{/each}
			</ol>
		</section>
	{/if}
</main>
