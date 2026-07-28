<script lang="ts">
	import type { DashboardFile, Tag } from '@adrive/shared';
	import { createSearchParamsSchema, useSearchParams } from 'runed/kit';
	import {
		createTag,
		deleteTag,
		listFiles,
		mutateFile,
		searchFiles,
		updateTag,
		uploadFile,
		type FileListPayload
	} from '$lib/dashboard/api';
	import { copyText, formatBytes, formatDate } from '$lib/dashboard/format';
	import { isCurrentSearchRun } from '$lib/dashboard/search-run';
	import { getDashboardSession } from '$lib/dashboard/session.svelte';

	const searchSchema = createSearchParamsSchema({
		q: { type: 'string', default: '' },
		tags: { type: 'array', default: [], arrayType: '' },
		view: { type: 'string', default: 'files' }
	});
	const params = useSearchParams(searchSchema, {
		debounce: 200,
		pushHistory: true,
		noScroll: true
	});
	const session = getDashboardSession();
	const showTrash = $derived(params.view === 'trash');
	let files = $state<ReadonlyArray<DashboardFile>>([]);
	let tags = $state<ReadonlyArray<Tag>>([]);
	let contentOrigin = $state('');
	let maxUploadBytes = $state(0);
	let refresh = $state(0);
	let loading = $state(false);
	let loadError = $state('');
	let isPublic = $state(true);
	let uploading = $state(false);
	let uploadMessage = $state('');
	let uploadTagIds = $state<ReadonlyArray<string>>([]);
	let dragging = $state(false);
	let copiedId = $state('');
	let keyInput = $state('');
	let newTagName = $state('');
	let newTagColor = $state('#2563eb');
	let tagMessage = $state('');
	let manageTagId = $state('');
	let manageName = $state('');
	let manageColor = $state('#2563eb');
	let managing = $state(false);
	let run = 0;

	$effect(() => {
		return () => params.cleanup();
	});

	$effect(() => {
		const token = session.token;
		const trashed = showTrash;
		const query = params.q;
		const selectedTags = [...params.tags];
		refresh;
		if (!session.ready || !token) {
			files = [];
			tags = [];
			return;
		}

		const mine = ++run;
		const controller = new AbortController();
		const timer = window.setTimeout(() => {
			loading = true;
			loadError = '';
			const request = trashed
				? listFiles(token, true, controller.signal)
				: searchFiles(token, query, selectedTags, controller.signal);
			void request
				.then((result: FileListPayload) => {
					if (!isCurrentSearchRun(run, mine)) return;
					files = result.files;
					tags = result.tags;
					contentOrigin = result.contentOrigin;
					maxUploadBytes = result.maxUploadBytes;
					uploadTagIds = uploadTagIds.filter((id) =>
						result.tags.some((tag) => tag.id === id)
					);
					if (
						manageTagId &&
						!result.tags.some((tag) => tag.id === manageTagId)
					) {
						manageTagId = '';
						manageName = '';
					}
				})
				.catch((cause: unknown) => {
					if (!isCurrentSearchRun(run, mine) || controller.signal.aborted)
						return;
					loadError =
						cause instanceof Error ? cause.message : 'Could not load files';
				})
				.finally(() => {
					if (isCurrentSearchRun(run, mine)) loading = false;
				});
		}, 200);

		return () => {
			window.clearTimeout(timer);
			run += 1;
			controller.abort();
		};
	});

	const upload = async (selected: FileList | ReadonlyArray<File>) => {
		const nextFiles = Array.from(selected);
		if (nextFiles.length === 0 || uploading) return;
		uploading = true;
		uploadMessage = '';
		try {
			const selectedNames = tags
				.filter((tag) => uploadTagIds.includes(tag.id))
				.map((tag) => tag.name);
			for (const file of nextFiles) {
				if (maxUploadBytes > 0 && file.size > maxUploadBytes) {
					throw new Error(`${file.name} is larger than the upload limit`);
				}
				const result = await uploadFile(
					session.token,
					file,
					isPublic,
					selectedNames
				);
				uploadMessage = result.forcedPublic
					? `${file.name} uploaded and made public because HTML is always public.`
					: `${file.name} uploaded.`;
			}
			refresh += 1;
		} catch (cause) {
			uploadMessage =
				cause instanceof Error
					? cause.message
					: 'Upload could not be completed';
		} finally {
			uploading = false;
		}
	};

	const onDrop = (event: DragEvent) => {
		event.preventDefault();
		dragging = false;
		if (event.dataTransfer?.files) void upload(event.dataTransfer.files);
	};

	const copyLink = async (file: DashboardFile) => {
		try {
			await copyText(
				`${contentOrigin}/${file.kind === 'site' ? 's' : 'f'}/${file.id}${file.kind === 'site' ? '/' : ''}`
			);
			copiedId = file.id;
			window.setTimeout(() => {
				if (copiedId === file.id) copiedId = '';
			}, 1500);
		} catch {
			loadError =
				'Could not copy the link. Open the file detail to copy it manually.';
		}
	};

	const changeState = async (
		file: DashboardFile,
		action: 'trash' | 'restore'
	) => {
		loadError = '';
		try {
			await mutateFile(session.token, file.id, { action });
			refresh += 1;
		} catch (cause) {
			loadError =
				cause instanceof Error ? cause.message : 'Could not update the file';
		}
	};

	const toggleFilterTag = (id: string) => {
		params.tags = params.tags.includes(id)
			? params.tags.filter((tagId) => tagId !== id)
			: [...params.tags, id];
	};

	const toggleUploadTag = (id: string) => {
		uploadTagIds = uploadTagIds.includes(id)
			? uploadTagIds.filter((tagId) => tagId !== id)
			: [...uploadTagIds, id];
	};

	const addTag = async () => {
		if (!newTagName.trim() || managing) return;
		managing = true;
		tagMessage = '';
		try {
			const tag = await createTag(session.token, {
				name: newTagName,
				color: newTagColor
			});
			tagMessage = `${tag.name} is ready to use.`;
			newTagName = '';
			refresh += 1;
		} catch (cause) {
			tagMessage =
				cause instanceof Error ? cause.message : 'Could not create the tag';
		} finally {
			managing = false;
		}
	};

	const selectManagedTag = (id: string) => {
		manageTagId = id;
		const tag = tags.find((candidate) => candidate.id === id);
		manageName = tag?.name ?? '';
		manageColor = tag?.color ?? '#71717a';
	};

	const saveManagedTag = async () => {
		if (!manageTagId || !manageName.trim() || managing) return;
		managing = true;
		tagMessage = '';
		try {
			const tag = await updateTag(session.token, manageTagId, {
				name: manageName,
				color: manageColor
			});
			tagMessage = `${tag.name} updated.`;
			refresh += 1;
		} catch (cause) {
			tagMessage =
				cause instanceof Error ? cause.message : 'Could not update the tag';
		} finally {
			managing = false;
		}
	};

	const removeManagedTag = async () => {
		if (!manageTagId || managing) return;
		managing = true;
		tagMessage = '';
		try {
			await deleteTag(session.token, manageTagId);
			tagMessage = 'Tag deleted. Files remain in the drive.';
			manageTagId = '';
			manageName = '';
			refresh += 1;
		} catch (cause) {
			tagMessage =
				cause instanceof Error ? cause.message : 'Could not delete the tag';
		} finally {
			managing = false;
		}
	};
</script>

<svelte:head>
	<title>Files · adrive</title>
</svelte:head>

<main class="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
	{#if !session.ready}
		<div
			class="mx-auto max-w-md animate-pulse rounded-lg border border-zinc-200 bg-white p-8"
		>
			<div class="h-5 w-28 rounded bg-zinc-200"></div>
			<div class="mt-4 h-10 rounded bg-zinc-100"></div>
		</div>
	{:else if !session.token}
		<section
			class="mx-auto max-w-md rounded-lg border border-zinc-200 bg-white p-6 shadow-sm sm:p-8"
		>
			<p
				class="text-xs font-semibold tracking-widest text-accent-600 uppercase"
			>
				Private dashboard
			</p>
			<h1 class="mt-3 text-2xl font-semibold tracking-tight text-zinc-950">
				Connect to your drive
			</h1>
			<p class="mt-2 text-sm leading-6 text-zinc-500">
				Use an existing adrive API key. It stays in this browser tab and is sent
				only to the dashboard origin.
			</p>
			<form
				class="mt-6"
				onsubmit={(event) => {
					event.preventDefault();
					void session.connect(keyInput);
				}}
			>
				<label for="api-key" class="text-sm font-medium text-zinc-700">
					API key
				</label>
				<input
					id="api-key"
					type="password"
					autocomplete="off"
					bind:value={keyInput}
					placeholder="adr_…"
					class="mt-2 w-full rounded-md border border-zinc-300 bg-white px-3 py-2.5 text-sm shadow-sm placeholder:text-zinc-400"
				/>
				{#if session.error}
					<p class="mt-2 text-sm text-red-600" role="alert">{session.error}</p>
				{/if}
				<button
					type="submit"
					disabled={session.connecting || !keyInput.trim()}
					class="mt-4 w-full rounded-md bg-zinc-950 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
				>
					{session.connecting ? 'Checking…' : 'Connect'}
				</button>
			</form>
		</section>
	{:else}
		<div
			class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"
		>
			<div>
				<p class="text-sm font-medium text-accent-600">Dashboard</p>
				<h1 class="mt-1 text-3xl font-semibold tracking-tight text-zinc-950">
					{showTrash ? 'Trash' : 'Files'}
				</h1>
				<p class="mt-2 text-sm text-zinc-500">
					{showTrash
						? 'Restore files before their purge window ends.'
						: 'Search names, tags, and text content without folders.'}
				</p>
			</div>
			<div class="flex rounded-md border border-zinc-200 bg-white p-1">
				<button
					type="button"
					aria-pressed={!showTrash}
					class="rounded px-3 py-1.5 text-sm font-medium {showTrash
						? 'text-zinc-500'
						: 'bg-zinc-100 text-zinc-950'}"
					onclick={() => (params.view = 'files')}>Files</button
				>
				<button
					type="button"
					aria-pressed={showTrash}
					class="rounded px-3 py-1.5 text-sm font-medium {showTrash
						? 'bg-zinc-100 text-zinc-950'
						: 'text-zinc-500'}"
					onclick={() => (params.view = 'trash')}>Trash</button
				>
			</div>
		</div>

		{#if !showTrash}
			<section
				class="mt-8 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm sm:p-6"
			>
				<label for="drive-search" class="text-sm font-medium text-zinc-900">
					Search
				</label>
				<input
					id="drive-search"
					type="search"
					bind:value={params.q}
					placeholder="Filename, tag, or text inside a file"
					class="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2.5 text-sm shadow-sm"
				/>
				{#if tags.length > 0}
					<div class="mt-3 flex flex-wrap gap-2" aria-label="Filter by any tag">
						{#each tags as tag (tag.id)}
							<button
								type="button"
								aria-pressed={params.tags.includes(tag.id)}
								class="rounded-full border px-2.5 py-1 text-xs font-medium {params.tags.includes(
									tag.id
								)
									? 'border-accent-500 bg-accent-50 text-accent-700'
									: 'border-zinc-200 text-zinc-600'}"
								onclick={() => toggleFilterTag(tag.id)}
							>
								<span
									class="mr-1 inline-block size-2 rounded-full"
									style={`background:${tag.color ?? '#a1a1aa'}`}
								></span>
								{tag.name} ({tag.fileCount})
							</button>
						{/each}
					</div>
					{#if params.tags.length > 1}
						<p class="mt-2 text-xs text-zinc-400">
							Tags use OR: a file matching any selected tag is included.
						</p>
					{/if}
				{/if}
			</section>

			<section
				class="mt-6 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm sm:p-6"
			>
				<div
					role="button"
					tabindex="0"
					aria-label="Upload files"
					class="rounded-md border border-dashed px-6 py-9 text-center transition {dragging
						? 'border-accent-500 bg-accent-50'
						: 'border-zinc-300 bg-zinc-50/60'}"
					ondragenter={(event) => {
						event.preventDefault();
						dragging = true;
					}}
					ondragover={(event) => event.preventDefault()}
					ondragleave={() => (dragging = false)}
					ondrop={onDrop}
					onkeydown={(event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault();
							document.getElementById('file-upload')?.click();
						}
					}}
					onclick={() => document.getElementById('file-upload')?.click()}
				>
					<p class="text-sm font-medium text-zinc-900">
						{uploading ? 'Uploading…' : 'Drop files here or choose files'}
					</p>
					<p class="mt-1 text-xs text-zinc-500">
						{maxUploadBytes > 0
							? `Up to ${formatBytes(maxUploadBytes)} per file`
							: 'Uploads are streamed directly to storage'}
					</p>
					<input
						id="file-upload"
						type="file"
						multiple
						class="sr-only"
						disabled={uploading}
						onchange={(event) => {
							const input = event.currentTarget;
							if (input.files) void upload(input.files);
							input.value = '';
						}}
					/>
				</div>
				<div class="mt-4 grid gap-4 sm:grid-cols-2">
					<label class="flex items-start gap-3 text-sm text-zinc-600">
						<input
							type="checkbox"
							bind:checked={isPublic}
							class="mt-0.5 size-4 rounded border-zinc-300 accent-accent-600"
						/>
						<span>
							Public — anyone with the link can open it.
							<span class="block text-xs text-zinc-400"
								>HTML is always public.</span
							>
						</span>
					</label>
					{#if tags.length > 0}
						<fieldset>
							<legend class="text-sm font-medium text-zinc-700"
								>Upload tags</legend
							>
							<div class="mt-2 flex flex-wrap gap-2">
								{#each tags as tag (tag.id)}
									<label
										class="flex items-center gap-1.5 text-xs text-zinc-600"
									>
										<input
											type="checkbox"
											checked={uploadTagIds.includes(tag.id)}
											onchange={() => toggleUploadTag(tag.id)}
											class="size-3.5 accent-accent-600"
										/>
										{tag.name}
									</label>
								{/each}
							</div>
						</fieldset>
					{/if}
				</div>
				{#if uploadMessage}
					<p class="mt-4 text-sm text-zinc-600" aria-live="polite">
						{uploadMessage}
					</p>
				{/if}
			</section>

			<section
				class="mt-6 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm sm:p-6"
			>
				<h2 class="text-sm font-semibold text-zinc-900">Manage tags</h2>
				<div class="mt-3 grid gap-3 sm:grid-cols-[1fr_auto_auto]">
					<input
						aria-label="New tag name"
						bind:value={newTagName}
						placeholder="New tag name"
						class="rounded-md border border-zinc-300 px-3 py-2 text-sm"
					/>
					<input
						aria-label="New tag color"
						type="color"
						bind:value={newTagColor}
						class="h-10 w-full rounded-md border border-zinc-300 bg-white p-1 sm:w-12"
					/>
					<button
						type="button"
						disabled={!newTagName.trim() || managing}
						class="rounded-md bg-zinc-950 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
						onclick={() => void addTag()}>Create</button
					>
				</div>
				{#if tags.length > 0}
					<div
						class="mt-4 grid gap-3 border-t border-zinc-100 pt-4 sm:grid-cols-[1fr_1fr_auto_auto_auto]"
					>
						<select
							aria-label="Tag to edit"
							value={manageTagId}
							class="rounded-md border border-zinc-300 px-3 py-2 text-sm"
							onchange={(event) => selectManagedTag(event.currentTarget.value)}
						>
							<option value="">Choose a tag</option>
							{#each tags as tag (tag.id)}
								<option value={tag.id}>{tag.name}</option>
							{/each}
						</select>
						<input
							aria-label="Tag display name"
							bind:value={manageName}
							disabled={!manageTagId}
							class="rounded-md border border-zinc-300 px-3 py-2 text-sm disabled:bg-zinc-50"
						/>
						<input
							aria-label="Tag color"
							type="color"
							bind:value={manageColor}
							disabled={!manageTagId}
							class="h-10 w-full rounded-md border border-zinc-300 bg-white p-1 sm:w-12"
						/>
						<button
							type="button"
							disabled={!manageTagId || !manageName.trim() || managing}
							class="rounded-md border border-zinc-200 px-3 py-2 text-sm font-medium disabled:opacity-50"
							onclick={() => void saveManagedTag()}>Save</button
						>
						<button
							type="button"
							disabled={!manageTagId || managing}
							class="rounded-md px-3 py-2 text-sm font-medium text-red-600 disabled:opacity-50"
							onclick={() => void removeManagedTag()}>Delete</button
						>
					</div>
				{/if}
				{#if tagMessage}
					<p class="mt-3 text-sm text-zinc-600" aria-live="polite">
						{tagMessage}
					</p>
				{/if}
			</section>
		{/if}

		<section
			class="mt-8 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm"
		>
			<div
				class="flex items-center justify-between border-b border-zinc-200 px-4 py-3 sm:px-5"
			>
				<p class="text-sm font-medium text-zinc-900">
					{files.length}
					{files.length === 1 ? 'file' : 'files'}
				</p>
				{#if loading}
					<span class="text-xs text-zinc-400">Searching…</span>
				{/if}
			</div>
			{#if loadError}
				<div
					class="border-b border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700"
					role="alert"
				>
					{loadError}
				</div>
			{/if}
			{#if !loading && files.length === 0}
				<div class="px-6 py-16 text-center">
					<p class="text-sm font-medium text-zinc-700">
						{showTrash
							? 'Trash is empty'
							: params.q || params.tags.length
								? 'No matching files'
								: 'No files yet'}
					</p>
				</div>
			{:else}
				<ul class="divide-y divide-zinc-100">
					{#each files as file (file.id)}
						<li
							class="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:px-5"
						>
							<div class="min-w-0 flex-1">
								<a
									href={`/files/${file.id}`}
									class="block truncate text-sm font-medium text-zinc-900 hover:text-accent-600"
								>
									{file.displayName}
								</a>
								<div
									class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-400"
								>
									<span>{formatBytes(file.sizeBytes)}</span>
									<span>· v{file.version} ·</span>
									<span>{formatDate(file.updatedAt)}</span>
									{#if file.kind === 'site'}
										<span
											class="rounded-full bg-accent-50 px-2 py-0.5 text-accent-700"
											>Site</span
										>
									{/if}
									<span
										class="rounded-full px-2 py-0.5 {file.public
											? 'bg-emerald-50 text-emerald-700'
											: 'bg-zinc-100 text-zinc-600'}"
										>{file.public ? 'Public' : 'Private'}</span
									>
									{#each file.tags as tag (tag.id)}
										<span
											class="rounded-full bg-zinc-100 px-2 py-0.5 text-zinc-600"
											>{tag.name}</span
										>
									{/each}
								</div>
							</div>
							<div class="flex items-center gap-2">
								{#if !showTrash}
									<button
										type="button"
										class="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600"
										onclick={() => void copyLink(file)}
									>
										{copiedId === file.id ? 'Copied' : 'Copy link'}
									</button>
									{#if file.public}
										<a
											href={`${contentOrigin}/${file.kind === 'site' ? 's' : 'f'}/${file.id}${file.kind === 'site' ? '/' : ''}`}
											target="_blank"
											rel="noreferrer"
											class="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600"
											>Open</a
										>
									{/if}
									<button
										type="button"
										class="rounded-md px-3 py-1.5 text-xs font-medium text-zinc-500 hover:bg-red-50 hover:text-red-700"
										onclick={() => void changeState(file, 'trash')}
										>Trash</button
									>
								{:else}
									<button
										type="button"
										class="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700"
										onclick={() => void changeState(file, 'restore')}
										>Restore</button
									>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}
</main>
