<script lang="ts">
	import type { DashboardFile } from '@adrive/shared';
	import {
		listFiles,
		mutateFile,
		uploadFile,
		type FileListPayload
	} from '$lib/dashboard/api';
	import { copyText, formatBytes, formatDate } from '$lib/dashboard/format';
	import { getDashboardSession } from '$lib/dashboard/session.svelte';

	const session = getDashboardSession();
	let files = $state<ReadonlyArray<DashboardFile>>([]);
	let contentOrigin = $state('');
	let maxUploadBytes = $state(0);
	let showTrash = $state(false);
	let refresh = $state(0);
	let loading = $state(false);
	let loadError = $state('');
	let isPublic = $state(true);
	let uploading = $state(false);
	let uploadMessage = $state('');
	let dragging = $state(false);
	let copiedId = $state('');
	let keyInput = $state('');
	let run = 0;

	$effect(() => {
		const token = session.token;
		const trashed = showTrash;
		refresh;
		if (!session.ready || !token) {
			files = [];
			return;
		}

		const mine = ++run;
		const controller = new AbortController();
		loading = true;
		loadError = '';
		void listFiles(token, trashed, controller.signal)
			.then((result: FileListPayload) => {
				if (mine !== run) return;
				files = result.files;
				contentOrigin = result.contentOrigin;
				maxUploadBytes = result.maxUploadBytes;
			})
			.catch((cause: unknown) => {
				if (mine !== run || controller.signal.aborted) return;
				loadError =
					cause instanceof Error ? cause.message : 'Could not load files';
			})
			.finally(() => {
				if (mine === run) loading = false;
			});

		return () => {
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
			for (const file of nextFiles) {
				if (maxUploadBytes > 0 && file.size > maxUploadBytes) {
					throw new Error(`${file.name} is larger than the upload limit`);
				}
				const result = await uploadFile(session.token, file, isPublic);
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
			await copyText(`${contentOrigin}/f/${file.id}`);
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
					name="api-key"
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
					class="mt-4 w-full rounded-md bg-zinc-950 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
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
						: 'Upload, share, and keep every version in one place.'}
				</p>
			</div>
			<div class="flex rounded-md border border-zinc-200 bg-white p-1">
				<button
					type="button"
					aria-pressed={!showTrash}
					class="rounded px-3 py-1.5 text-sm font-medium {showTrash
						? 'text-zinc-500'
						: 'bg-zinc-100 text-zinc-950'}"
					onclick={() => (showTrash = false)}>Files</button
				>
				<button
					type="button"
					aria-pressed={showTrash}
					class="rounded px-3 py-1.5 text-sm font-medium {showTrash
						? 'bg-zinc-100 text-zinc-950'
						: 'text-zinc-500'}"
					onclick={() => (showTrash = true)}>Trash</button
				>
			</div>
		</div>

		{#if !showTrash}
			<section
				class="mt-8 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm sm:p-6"
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
				<div class="mt-4 flex items-start gap-3">
					<input
						id="upload-public"
						type="checkbox"
						bind:checked={isPublic}
						class="mt-0.5 size-4 rounded border-zinc-300 accent-accent-600"
					/>
					<label for="upload-public" class="text-sm text-zinc-600">
						Public — anyone with the link can open it.
						<span class="block text-xs text-zinc-400">
							HTML is always public, even when this is off.
						</span>
					</label>
				</div>
				{#if uploadMessage}
					<p class="mt-4 text-sm text-zinc-600" aria-live="polite">
						{uploadMessage}
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
					<span class="text-xs text-zinc-400">Refreshing…</span>
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
						{showTrash ? 'Trash is empty' : 'No files yet'}
					</p>
					<p class="mt-1 text-sm text-zinc-400">
						{showTrash
							? 'Trashed files will appear here.'
							: 'Drop a file above to create your first share link.'}
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
									<span aria-hidden="true">·</span>
									<span>v{file.version}</span>
									<span aria-hidden="true">·</span>
									<span>{formatDate(file.updatedAt)}</span>
									<span
										class="rounded-full px-2 py-0.5 {file.public
											? 'bg-emerald-50 text-emerald-700'
											: 'bg-zinc-100 text-zinc-600'}"
									>
										{file.public ? 'Public' : 'Private'}
									</span>
									{#if file.htmlForcedPublic}
										<span class="text-amber-700">HTML</span>
									{/if}
								</div>
							</div>
							<div class="flex items-center gap-2">
								{#if !showTrash}
									<button
										type="button"
										class="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 transition hover:border-zinc-300 hover:text-zinc-900"
										onclick={() => void copyLink(file)}
									>
										{copiedId === file.id ? 'Copied' : 'Copy link'}
									</button>
									<button
										type="button"
										class="rounded-md px-3 py-1.5 text-xs font-medium text-zinc-500 transition hover:bg-red-50 hover:text-red-700"
										onclick={() => void changeState(file, 'trash')}
									>
										Trash
									</button>
								{:else}
									<button
										type="button"
										class="rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 transition hover:border-zinc-300 hover:bg-zinc-50"
										onclick={() => void changeState(file, 'restore')}
									>
										Restore
									</button>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}
</main>
