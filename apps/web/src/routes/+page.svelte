<script lang="ts">
	import type { ApiKey, DashboardFile, Tag } from '@adrive/shared';
	import { page } from '$app/state';
	import { createSearchParamsSchema, useSearchParams } from 'runed/kit';
	import {
		createTag,
		createApiKey,
		deleteTag,
		approveDevice,
		getContentLink,
		listFiles,
		listApiKeys,
		mutateFile,
		revokeApiKey,
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
	let uploadOpen = $state(false);
	let uploadTagIds = $state<ReadonlyArray<string>>([]);
	let dragging = $state(false);
	let uploadDialog = $state<HTMLDialogElement | null>(null);
	let fileInput = $state<HTMLInputElement | null>(null);
	let copiedId = $state('');
	let keyInput = $state('');
	let localKeyInput = $state('');
	let expiresAtInput = $state('');
	let apiKeys = $state<ReadonlyArray<ApiKey>>([]);
	let apiKeyName = $state('');
	let createdApiKey = $state('');
	let authMessage = $state('');
	let managingAuth = $state(false);
	let newTagName = $state('');
	let newTagColor = $state('#2563eb');
	let tagMessage = $state('');
	let tagManagerOpen = $state(false);
	let tagDialog = $state<HTMLDialogElement | null>(null);
	let manageTagId = $state('');
	let manageName = $state('');
	let manageColor = $state('#2563eb');
	let managing = $state(false);
	let run = 0;
	let dragDepth = 0;
	const deviceCode = $derived(page.url.searchParams.get('device') ?? '');

	$effect(() => {
		return () => params.cleanup();
	});

	$effect(() => {
		const dialog = uploadDialog;
		if (!dialog) return;
		if (uploadOpen && !dialog.open) dialog.showModal();
		if (!uploadOpen && dialog.open) dialog.close();
	});

	$effect(() => {
		const dialog = tagDialog;
		if (!dialog) return;
		if (tagManagerOpen && !dialog.open) dialog.showModal();
		if (!tagManagerOpen && dialog.open) dialog.close();
	});

	$effect(() => {
		const token = session.token;
		if (!token) {
			apiKeys = [];
			return;
		}
		void listApiKeys(token)
			.then((keys) => {
				apiKeys = keys;
			})
			.catch(() => {
				apiKeys = [];
			});
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
		if (nextFiles.length === 0 || uploading) return false;
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
					selectedNames,
					expiresAtInput ? new Date(expiresAtInput).toISOString() : null
				);
				uploadMessage = result.forcedPublic
					? `${file.name} uploaded and made public because HTML is always public.`
					: `${file.name} uploaded.`;
			}
			refresh += 1;
			return true;
		} catch (cause) {
			uploadMessage =
				cause instanceof Error
					? cause.message
					: 'Upload could not be completed';
			return false;
		} finally {
			uploading = false;
		}
	};

	const mintApiKey = async () => {
		if (!apiKeyName.trim() || managingAuth) return;
		managingAuth = true;
		authMessage = '';
		createdApiKey = '';
		try {
			const result = await createApiKey(session.token, apiKeyName);
			apiKeys = [result.key, ...apiKeys];
			createdApiKey = result.token;
			apiKeyName = '';
			authMessage = 'API key created. Copy it now; it will not be shown again.';
		} catch (cause) {
			authMessage =
				cause instanceof Error ? cause.message : 'Could not create the API key';
		} finally {
			managingAuth = false;
		}
	};

	const removeApiKey = async (id: string) => {
		if (managingAuth) return;
		managingAuth = true;
		authMessage = '';
		try {
			await revokeApiKey(session.token, id);
			apiKeys = apiKeys.map((key) =>
				key.id === id ? { ...key, revokedAt: new Date().toISOString() } : key
			);
			authMessage = 'API key revoked.';
		} catch (cause) {
			authMessage =
				cause instanceof Error ? cause.message : 'Could not revoke the API key';
		} finally {
			managingAuth = false;
		}
	};

	const authorizeDevice = async () => {
		if (!deviceCode || managingAuth) return;
		managingAuth = true;
		authMessage = '';
		try {
			await approveDevice(session.token, deviceCode);
			authMessage = `Device ${deviceCode} approved. You can return to the CLI.`;
		} catch (cause) {
			authMessage =
				cause instanceof Error ? cause.message : 'Could not approve the device';
		} finally {
			managingAuth = false;
		}
	};

	const containsFiles = (event: DragEvent) =>
		event.dataTransfer?.types.includes('Files') ?? false;

	const onWindowDragEnter = (event: DragEvent) => {
		if (!session.token || showTrash || uploading || !containsFiles(event))
			return;
		event.preventDefault();
		dragDepth += 1;
		dragging = true;
	};

	const onWindowDragOver = (event: DragEvent) => {
		if (!session.token || showTrash || uploading || !containsFiles(event))
			return;
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
	};

	const onWindowDragLeave = (event: DragEvent) => {
		if (!containsFiles(event)) return;
		dragDepth = Math.max(0, dragDepth - 1);
		if (dragDepth === 0) dragging = false;
	};

	const onWindowDrop = async (event: DragEvent) => {
		if (!session.token || showTrash || uploading || !containsFiles(event))
			return;
		event.preventDefault();
		dragDepth = 0;
		dragging = false;
		const selected = event.dataTransfer?.files;
		if (!selected) return;
		if (await upload(selected)) uploadOpen = false;
	};

	const onWindowPaste = async (event: ClipboardEvent) => {
		if (!session.token || showTrash || uploading) return;
		const selected = event.clipboardData?.files;
		if (!selected || selected.length === 0) return;
		event.preventDefault();
		if (await upload(selected)) uploadOpen = false;
	};

	const onWindowKeyDown = (event: KeyboardEvent) => {
		if (event.key !== 'Escape') return;
		if (uploadOpen) {
			event.preventDefault();
			uploadOpen = false;
			return;
		}
		if (tagManagerOpen) {
			event.preventDefault();
			tagManagerOpen = false;
		}
	};

	const uploadFromPicker = async (selected: FileList | null) => {
		if (!selected) return;
		if (await upload(selected)) uploadOpen = false;
	};

	const fileLabel = (file: DashboardFile) => {
		if (file.kind === 'site') return 'SITE';
		const extension = file.displayName.split('.').pop();
		return extension && extension !== file.displayName
			? extension.slice(0, 5).toUpperCase()
			: 'FILE';
	};

	const copyLink = async (file: DashboardFile) => {
		const fileId = file.id;
		try {
			const url =
				file.kind === 'site' || file.public
					? `${contentOrigin}/${file.kind === 'site' ? 's' : 'f'}/${file.id}${file.kind === 'site' ? '/' : ''}`
					: (await getContentLink(session.token, file.id)).url;
			if (!files.some((candidate) => candidate.id === fileId)) return;
			await copyText(url);
			copiedId = fileId;
			window.setTimeout(() => {
				if (copiedId === fileId) copiedId = '';
			}, 1500);
		} catch {
			loadError =
				'Could not copy the link. Open the file detail to copy it manually.';
		}
	};

	const openLink = async (file: DashboardFile) => {
		const fileId = file.id;
		try {
			const link = await getContentLink(session.token, fileId);
			if (!files.some((candidate) => candidate.id === fileId)) return;
			window.location.assign(link.url);
		} catch (cause) {
			loadError =
				cause instanceof Error ? cause.message : 'Could not download the file';
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

<svelte:window
	ondragenter={onWindowDragEnter}
	ondragover={onWindowDragOver}
	ondragleave={onWindowDragLeave}
	ondrop={onWindowDrop}
	onpaste={onWindowPaste}
	onkeydown={onWindowKeyDown}
/>

{#if dragging}
	<div
		class="pointer-events-none fixed inset-3 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent-500 bg-accent-50/95"
		aria-hidden="true"
	>
		<div class="text-center">
			<svg
				class="mx-auto size-10 text-accent-600"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="1.6"
			>
				<path
					d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"
				/>
			</svg>
			<p class="mt-3 text-base font-medium text-accent-700">Drop to upload</p>
		</div>
	</div>
{/if}

<dialog
	bind:this={uploadDialog}
	class="m-auto w-[min(34rem,calc(100%-2rem))] rounded-xl bg-white p-0 text-zinc-950 shadow-2xl backdrop:bg-zinc-950/30"
	aria-labelledby="upload-title"
	onclose={() => (uploadOpen = false)}
	oncancel={() => (uploadOpen = false)}
	onclick={(event) => {
		if (event.target === event.currentTarget) uploadOpen = false;
	}}
>
	<div class="p-5 sm:p-6">
		<div class="flex items-start justify-between gap-4">
			<h2 id="upload-title" class="text-lg font-semibold tracking-tight">
				Upload files
			</h2>
			<button
				type="button"
				class="rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-800"
				aria-label="Close upload dialog"
				onclick={() => (uploadOpen = false)}
			>
				<svg
					class="size-5"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.8"
					aria-hidden="true"
				>
					<path d="m6 6 12 12M18 6 6 18" />
				</svg>
			</button>
		</div>

		<button
			type="button"
			disabled={uploading}
			class="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-zinc-950 px-4 py-3 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:opacity-50"
			onclick={() => fileInput?.click()}
		>
			{uploading ? 'Uploading…' : 'Choose files'}
		</button>
		<input
			bind:this={fileInput}
			type="file"
			multiple
			class="sr-only"
			disabled={uploading}
			onchange={(event) => {
				const input = event.currentTarget;
				void uploadFromPicker(input.files);
				input.value = '';
			}}
		/>

		<div class="mt-6 space-y-5 border-t border-zinc-100 pt-5">
			<label
				class="flex items-center gap-3 text-sm text-zinc-700"
				title="Anyone with the link can open public files. HTML is always public."
			>
				<input
					type="checkbox"
					bind:checked={isPublic}
					class="size-4 rounded border-zinc-300 accent-accent-600"
				/>
				<span>Public</span>
			</label>

			{#if tags.length > 0}
				<fieldset>
					<legend class="text-sm font-medium text-zinc-700">Tags</legend>
					<div class="mt-2 flex flex-wrap gap-2">
						{#each tags as tag (tag.id)}
							<label
								class="flex items-center gap-1.5 rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-600"
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

			<label class="block text-sm text-zinc-700">
				Expiration
				<input
					type="datetime-local"
					bind:value={expiresAtInput}
					class="mt-2 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
				/>
			</label>
		</div>
	</div>
</dialog>

<dialog
	bind:this={tagDialog}
	class="m-auto w-[min(38rem,calc(100%-2rem))] rounded-xl bg-white p-0 text-zinc-950 shadow-2xl backdrop:bg-zinc-950/30"
	aria-labelledby="tag-manager-title"
	onclose={() => (tagManagerOpen = false)}
	oncancel={() => (tagManagerOpen = false)}
	onclick={(event) => {
		if (event.target === event.currentTarget) tagManagerOpen = false;
	}}
>
	<div class="p-5 sm:p-6">
		<div class="flex items-start justify-between gap-4">
			<h2 id="tag-manager-title" class="text-lg font-semibold tracking-tight">
				Manage tags
			</h2>
			<button
				type="button"
				class="rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-800"
				aria-label="Close tag manager"
				onclick={() => (tagManagerOpen = false)}
			>
				<svg
					class="size-5"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.8"
					aria-hidden="true"
				>
					<path d="m6 6 12 12M18 6 6 18" />
				</svg>
			</button>
		</div>

		<div class="mt-6 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
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
			<div class="mt-6 border-t border-zinc-100 pt-5">
				<div class="flex flex-wrap gap-2">
					{#each tags as tag (tag.id)}
						<button
							type="button"
							aria-pressed={manageTagId === tag.id}
							class="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition {manageTagId ===
							tag.id
								? 'border-accent-500 bg-accent-50 text-accent-700'
								: 'border-zinc-200 bg-zinc-50 text-zinc-700 hover:border-zinc-300'}"
							onclick={() => selectManagedTag(tag.id)}
						>
							<span
								class="size-2.5 rounded-full"
								style={`background:${tag.color ?? '#a1a1aa'}`}
							></span>
							{tag.name}
							<span class="text-xs text-zinc-400">{tag.fileCount}</span>
						</button>
					{/each}
				</div>
			</div>
		{/if}

		{#if manageTagId}
			<div
				class="mt-5 grid gap-2 border-t border-zinc-100 pt-5 sm:grid-cols-[1fr_auto_auto_auto]"
			>
				<input
					aria-label="Tag display name"
					bind:value={manageName}
					class="rounded-md border border-zinc-300 px-3 py-2 text-sm"
				/>
				<input
					aria-label="Tag color"
					type="color"
					bind:value={manageColor}
					class="h-10 w-full rounded-md border border-zinc-300 bg-white p-1 sm:w-12"
				/>
				<button
					type="button"
					disabled={!manageName.trim() || managing}
					class="rounded-md border border-zinc-200 px-3 py-2 text-sm font-medium disabled:opacity-50"
					onclick={() => void saveManagedTag()}>Save</button
				>
				<button
					type="button"
					disabled={managing}
					class="rounded-md px-3 py-2 text-sm font-medium text-red-600 disabled:opacity-50"
					onclick={() => void removeManagedTag()}>Delete</button
				>
			</div>
		{/if}

		{#if tagMessage}
			<p class="mt-4 text-sm text-zinc-600" aria-live="polite">
				{tagMessage}
			</p>
		{/if}
	</div>
</dialog>

<main class="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-10">
	{#if !session.ready}
		<div class="mx-auto max-w-md animate-pulse py-12">
			<div class="h-5 w-28 rounded bg-zinc-200"></div>
			<div class="mt-4 h-10 rounded bg-zinc-100"></div>
		</div>
	{:else if !session.token}
		<section class="mx-auto max-w-md py-10 sm:py-16">
			<h1 class="text-2xl font-semibold tracking-tight text-zinc-950">
				Sign in to your drive
			</h1>
			<form
				class="mt-6"
				onsubmit={(event) => {
					event.preventDefault();
					void session.connect(keyInput);
				}}
			>
				<label for="passcode" class="text-sm font-medium text-zinc-700">
					Passcode
				</label>
				<input
					id="passcode"
					type="password"
					autocomplete="current-password"
					bind:value={keyInput}
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
					{session.connecting ? 'Signing in…' : 'Sign in'}
				</button>
			</form>
			<details class="mt-5 border-t border-zinc-100 pt-4">
				<summary class="text-xs font-medium text-zinc-500"
					>Local HTTP fallback</summary
				>
				<form
					class="mt-3 flex gap-2"
					onsubmit={(event) => {
						event.preventDefault();
						void session.connectApiKey(localKeyInput);
					}}
				>
					<input
						type="password"
						aria-label="Local API key"
						autocomplete="off"
						bind:value={localKeyInput}
						placeholder="adr_…"
						class="min-w-0 flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm"
					/>
					<button
						type="submit"
						disabled={session.connecting || !localKeyInput.trim()}
						class="rounded-md border border-zinc-200 px-3 py-2 text-sm font-medium disabled:opacity-50"
						>Connect</button
					>
				</form>
			</details>
		</section>
	{:else}
		{#if deviceCode}
			<section
				class="mb-7 flex flex-col gap-3 border-b border-accent-100 bg-accent-50/70 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
			>
				<div>
					<p class="text-sm font-semibold text-accent-700">
						Approve CLI device
					</p>
					<p class="mt-1 text-sm text-zinc-600">
						Confirm code <strong class="font-mono">{deviceCode}</strong> only if it
						matches the CLI you started.
					</p>
				</div>
				<button
					type="button"
					disabled={managingAuth}
					class="self-start rounded-md bg-zinc-950 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
					onclick={() => void authorizeDevice()}>Approve device</button
				>
			</section>
		{/if}

		<div
			class="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between"
		>
			<div>
				<h1 class="text-3xl font-semibold tracking-tight text-zinc-950">
					{showTrash ? 'Trash' : 'Files'}
				</h1>
			</div>
			<div class="flex items-center gap-1">
				{#if !showTrash}
					<button
						type="button"
						class="mr-2 inline-flex items-center gap-2 rounded-md bg-zinc-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-800"
						onclick={() => (uploadOpen = true)}
					>
						<svg
							class="size-4"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="1.8"
							aria-hidden="true"
						>
							<path d="M12 5v14M5 12h14" />
						</svg>
						Upload
					</button>
				{/if}
				<button
					type="button"
					aria-pressed={!showTrash}
					class="border-b-2 px-3 py-2 text-sm font-medium {showTrash
						? 'border-transparent text-zinc-400 hover:text-zinc-700'
						: 'border-zinc-950 text-zinc-950'}"
					onclick={() => (params.view = 'files')}>Files</button
				>
				<button
					type="button"
					aria-pressed={showTrash}
					class="border-b-2 px-3 py-2 text-sm font-medium {showTrash
						? 'border-zinc-950 text-zinc-950'
						: 'border-transparent text-zinc-400 hover:text-zinc-700'}"
					onclick={() => (params.view = 'trash')}>Trash</button
				>
			</div>
		</div>

		{#if uploadMessage}
			<p
				class="mt-5 border-l-2 border-accent-500 pl-3 text-sm text-zinc-600"
				aria-live="polite"
			>
				{uploadMessage}
			</p>
		{/if}

		{#if !showTrash}
			<section class="mt-8">
				<div class="relative max-w-2xl">
					<svg
						class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-400"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.8"
						aria-hidden="true"
					>
						<circle cx="11" cy="11" r="7" />
						<path d="m16 16 4 4" />
					</svg>
					<label for="drive-search" class="sr-only">Search files</label>
					<input
						id="drive-search"
						type="search"
						bind:value={params.q}
						placeholder="Search files"
						class="w-full rounded-lg bg-zinc-100 py-2.5 pr-3 pl-10 text-sm outline-none placeholder:text-zinc-400 focus:bg-white focus:ring-2 focus:ring-accent-500"
					/>
				</div>
				<div
					class="mt-5 flex flex-wrap gap-2"
					aria-label="Filter and manage tags"
				>
					{#each tags as tag (tag.id)}
						<button
							type="button"
							aria-pressed={params.tags.includes(tag.id)}
							class="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition {params.tags.includes(
								tag.id
							)
								? 'border-accent-500 bg-accent-50 text-accent-700 ring-1 ring-accent-500'
								: 'border-zinc-200 bg-zinc-50 text-zinc-700 hover:border-zinc-300 hover:bg-white'}"
							onclick={() => toggleFilterTag(tag.id)}
						>
							<span
								class="size-2.5 rounded-full"
								style={`background:${tag.color ?? '#a1a1aa'}`}
							></span>
							{tag.name}
							<span class="text-xs font-normal text-zinc-400">
								{tag.fileCount}
							</span>
						</button>
					{/each}
					<button
						type="button"
						class="inline-flex items-center gap-2 rounded-md border border-dashed border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-500 transition hover:border-zinc-400 hover:text-zinc-800"
						onclick={() => (tagManagerOpen = true)}
					>
						<svg
							class="size-4"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="1.8"
							aria-hidden="true"
						>
							<path d="M12 5v14M5 12h14" />
						</svg>
						Manage tags
					</button>
				</div>
			</section>
		{/if}

		<section class="mt-10">
			<div
				class="flex items-center justify-between border-b border-zinc-200 pb-3"
			>
				<p class="text-sm font-medium text-zinc-700">
					{files.length}
					{files.length === 1 ? 'file' : 'files'}
				</p>
				{#if loading}
					<span class="text-xs text-zinc-400">Searching…</span>
				{/if}
			</div>
			{#if loadError}
				<p
					class="mt-4 border-l-2 border-red-500 pl-3 text-sm text-red-700"
					role="alert"
				>
					{loadError}
				</p>
			{/if}
			{#if !loading && files.length === 0}
				<div class="py-20 text-center">
					<svg
						class="mx-auto size-12 text-zinc-300"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.4"
						aria-hidden="true"
					>
						<path
							d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
						/>
						<path d="M14 2v6h6M8 13h8M8 17h5" />
					</svg>
					<p class="mt-4 text-sm font-medium text-zinc-700">
						{showTrash
							? 'Trash is empty'
							: params.q || params.tags.length
								? 'No matching files'
								: 'No files yet'}
					</p>
				</div>
			{:else}
				<ul
					class="grid grid-cols-2 gap-x-4 gap-y-8 py-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
				>
					{#each files as file (file.id)}
						<li class="group min-w-0">
							<a
								href={`/files/${file.id}`}
								class="flex aspect-[4/3] items-center justify-center rounded-xl bg-zinc-100 transition group-hover:bg-zinc-200/70"
								aria-label={`Open ${file.displayName}`}
							>
								<div class="text-center">
									<svg
										class="mx-auto size-9 text-zinc-400"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="1.4"
										aria-hidden="true"
									>
										{#if file.kind === 'site'}
											<rect x="3" y="4" width="18" height="16" rx="2" />
											<path d="M3 9h18M7 6.5h.01M10 6.5h.01" />
										{:else}
											<path
												d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
											/>
											<path d="M14 2v6h6" />
										{/if}
									</svg>
									<span
										class="mt-2 block text-[10px] font-semibold tracking-wider text-zinc-400"
									>
										{fileLabel(file)}
									</span>
								</div>
							</a>
							<div class="mt-3 flex items-start gap-2">
								<div class="min-w-0 flex-1">
									<a
										href={`/files/${file.id}`}
										class="block truncate text-sm font-medium text-zinc-900 hover:text-accent-600"
									>
										{file.displayName}
									</a>
									<p class="mt-0.5 truncate text-xs text-zinc-400">
										{formatBytes(file.sizeBytes)} · {formatDate(file.updatedAt)}
									</p>
								</div>
								<details class="relative shrink-0">
									<summary
										class="flex size-7 list-none items-center justify-center rounded-md text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-800 [&::-webkit-details-marker]:hidden"
										aria-label={`Actions for ${file.displayName}`}
									>
										<span aria-hidden="true">•••</span>
									</summary>
									<div
										class="absolute top-8 right-0 z-20 w-36 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg"
									>
										{#if !showTrash}
											{#if file.public}
												<a
													href={`${contentOrigin}/${file.kind === 'site' ? 's' : 'f'}/${file.id}${file.kind === 'site' ? '/' : ''}`}
													target="_blank"
													rel="noreferrer"
													class="block px-3 py-2 text-xs text-zinc-700 hover:bg-zinc-50"
													>Open</a
												>
											{:else}
												<button
													type="button"
													class="block w-full px-3 py-2 text-left text-xs text-zinc-700 hover:bg-zinc-50"
													onclick={() => void openLink(file)}>Download</button
												>
											{/if}
											<button
												type="button"
												class="block w-full px-3 py-2 text-left text-xs text-zinc-700 hover:bg-zinc-50"
												onclick={() => void copyLink(file)}
											>
												{copiedId === file.id ? 'Copied' : 'Copy link'}
											</button>
											<button
												type="button"
												class="block w-full px-3 py-2 text-left text-xs text-red-600 hover:bg-red-50"
												onclick={() => void changeState(file, 'trash')}
												>Trash</button
											>
										{:else}
											<button
												type="button"
												class="block w-full px-3 py-2 text-left text-xs text-zinc-700 hover:bg-zinc-50"
												onclick={() => void changeState(file, 'restore')}
												>Restore</button
											>
										{/if}
									</div>
								</details>
							</div>
							<div class="mt-2 flex min-w-0 items-center gap-1.5">
								<span
									class="size-1.5 shrink-0 rounded-full {file.public
										? 'bg-emerald-500'
										: 'bg-zinc-400'}"
								></span>
								<span class="text-[11px] text-zinc-400">
									{file.public ? 'Public' : 'Private'}
								</span>
								{#each file.tags.slice(0, 2) as tag (tag.id)}
									<span
										class="truncate rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500"
										>{tag.name}</span
									>
								{/each}
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		{#if !showTrash}
			<div class="mt-10">
				<details class="border-t border-zinc-200 py-5">
					<summary
						title="API keys have full access"
						class="flex list-none items-center justify-between text-sm font-medium text-zinc-800 [&::-webkit-details-marker]:hidden"
					>
						<span>API keys</span>
						<span class="text-xs font-normal text-zinc-400">Manage</span>
					</summary>
					<div class="mt-5 max-w-3xl">
						<form
							class="flex max-w-xl gap-2"
							onsubmit={(event) => {
								event.preventDefault();
								void mintApiKey();
							}}
						>
							<input
								bind:value={apiKeyName}
								placeholder="Key name, e.g. backup agent"
								class="min-w-0 flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm"
							/>
							<button
								type="submit"
								disabled={!apiKeyName.trim() || managingAuth}
								class="rounded-md bg-zinc-950 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
								>Create key</button
							>
						</form>
						{#if createdApiKey}
							<div class="mt-3 border-l-2 border-amber-400 pl-3">
								<p class="text-xs font-medium text-amber-900">
									Copy this key now
								</p>
								<code class="mt-1 block break-all text-xs text-amber-900"
									>{createdApiKey}</code
								>
							</div>
						{/if}
						{#if apiKeys.length > 0}
							<ul
								class="mt-4 divide-y divide-zinc-100 border-t border-zinc-100"
							>
								{#each apiKeys as key (key.id)}
									<li class="flex items-center justify-between gap-3 py-3">
										<div class="min-w-0">
											<p class="truncate text-sm font-medium text-zinc-800">
												{key.name}
											</p>
											<p class="mt-0.5 text-xs text-zinc-400">
												adr_{key.prefix}_… · created {formatDate(key.createdAt)}
												{key.revokedAt ? ' · revoked' : ''}
											</p>
										</div>
										{#if !key.revokedAt}
											<button
												type="button"
												disabled={managingAuth}
												class="text-xs font-medium text-red-600 disabled:opacity-50"
												onclick={() => void removeApiKey(key.id)}>Revoke</button
											>
										{/if}
									</li>
								{/each}
							</ul>
						{/if}
						{#if authMessage}
							<p class="mt-3 text-sm text-zinc-600" aria-live="polite">
								{authMessage}
							</p>
						{/if}
					</div>
				</details>
			</div>
		{/if}
	{/if}
</main>
