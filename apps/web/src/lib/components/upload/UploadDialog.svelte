<script lang="ts">
	import type { Tag } from '@adrive/shared';
	import { formatBytes, isHtmlFile } from '$lib/dashboard/format';
	import {
		partitionUploadFiles,
		type RejectedUploadFile,
		type UploadManager
	} from '$lib/dashboard/uploads.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import ExpirySelect from '$lib/components/ui/ExpirySelect.svelte';
	import Modal from '$lib/components/ui/Modal.svelte';
	import TagPicker from '$lib/components/tags/TagPicker.svelte';
	import type { Attachment } from 'svelte/attachments';

	let {
		open = $bindable(false),
		uploads,
		token,
		tags,
		maxUploadBytes,
		maxStagedUploadBytes,
		onqueued
	}: {
		open?: boolean;
		uploads: UploadManager;
		token: string;
		tags: ReadonlyArray<Tag>;
		maxUploadBytes: number;
		maxStagedUploadBytes: number;
		onqueued?: () => void;
	} = $props();

	let selected = $state<ReadonlyArray<File>>([]);
	let rejected = $state.raw<ReadonlyArray<RejectedUploadFile>>([]);
	let isPublic = $state(true);
	let selectedTags = $state<ReadonlyArray<Tag>>([]);
	let expiresAt = $state('');
	let folderError = $state('');
	let input = $state<HTMLInputElement>();
	let dialogIdentity = '';
	let wasOpen = false;
	const attachInput: Attachment<HTMLInputElement> = (node) => {
		input = node;
		return () => {
			if (input === node) input = undefined;
		};
	};
	const hasHtml = $derived(
		selected.some(
			(file) =>
				file.size <= maxStagedUploadBytes && isHtmlFile(file.name, file.type)
		)
	);
	const effectivePublic = $derived(hasHtml || isPublic);

	const reset = () => {
		selected = [];
		rejected = [];
		isPublic = true;
		selectedTags = [];
		expiresAt = '';
		folderError = '';
		if (input) input.value = '';
	};

	$effect(() => {
		const nextIdentity = token;
		const nextOpen = open;
		if (dialogIdentity !== nextIdentity || (wasOpen && !nextOpen)) {
			reset();
		}
		dialogIdentity = nextIdentity;
		wasOpen = nextOpen;
	});

	const choose = (files: FileList | null) => {
		if (!files) return;
		folderError = '';
		const result = partitionUploadFiles(
			Array.from(files),
			maxStagedUploadBytes
		);
		selected = result.accepted;
		rejected = result.rejected;
	};

	const chooseDrop = (transfer: DataTransfer | null) => {
		if (!transfer) return;
		const hasFolder = Array.from(transfer.items).some(
			(item) => item.kind === 'file' && item.webkitGetAsEntry()?.isDirectory
		);
		if (hasFolder) {
			selected = [];
			rejected = [];
			if (input) input.value = '';
			folderError =
				'Folders are not uploaded as files. Use `adrive site put` for a site directory.';
			return;
		}
		choose(transfer.files);
	};

	const queue = () => {
		if (selected.length === 0) return;
		const result = partitionUploadFiles(selected, maxStagedUploadBytes);
		selected = result.accepted;
		rejected = [...rejected, ...result.rejected];
		if (result.accepted.length === 0) return;

		uploads.enqueue(result.accepted, {
			token,
			public: effectivePublic,
			tags: selectedTags,
			expiresAt: expiresAt || null,
			maxUploadBytes
		});
		reset();
		open = false;
		onqueued?.();
	};
</script>

<svelte:window
	onpaste={(event) => {
		if (!open) return;
		const files = event.clipboardData?.files;
		if (files?.length) {
			event.preventDefault();
			choose(files);
		}
	}}
/>

<Modal
	bind:open
	title="Upload files"
	description="Choose the sharing and expiration settings before uploading."
>
	<button
		type="button"
		data-autofocus
		class="flex w-full flex-col items-center rounded-lg border-2 border-dashed border-zinc-200 px-5 py-8 text-center hover:border-zinc-300 hover:bg-zinc-50"
		onclick={() => input?.click()}
		ondragover={(event) => event.preventDefault()}
		ondrop={(event) => {
			event.preventDefault();
			event.stopPropagation();
			chooseDrop(event.dataTransfer);
		}}
	>
		<span class="text-sm font-medium text-zinc-800">
			{selected.length
				? `${selected.length} ${selected.length === 1 ? 'file' : 'files'} selected`
				: 'Drop files here or browse'}
		</span>
		<span class="mt-1 text-xs text-zinc-400">
			Up to {formatBytes(maxStagedUploadBytes)} each · files over {formatBytes(
				maxUploadBytes
			)} upload in parts · paste with ⌘V
		</span>
	</button>
	<input
		{@attach attachInput}
		type="file"
		multiple
		class="sr-only"
		onchange={(event) => {
			choose(event.currentTarget.files);
			event.currentTarget.value = '';
		}}
	/>
	{#if folderError}
		<p
			class="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
			role="alert"
		>
			{folderError}
		</p>
	{/if}
	{#if rejected.length > 0}
		<div
			class="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
			role="alert"
		>
			<p class="font-medium">
				{rejected.length === 1
					? `${rejected[0]?.name ?? 'This file'} is too large`
					: `${rejected.length} files are too large`}
			</p>
			<p class="mt-1 text-xs">
				The limit is {formatBytes(maxStagedUploadBytes)} per file. Choose smaller
				files or reduce their size.
			</p>
			<ul class="mt-1 space-y-0.5 text-xs">
				{#each rejected.slice(0, 3) as file (file)}
					<li>{file.name} · {formatBytes(file.size)}</li>
				{/each}
				{#if rejected.length > 3}
					<li>and {rejected.length - 3} more</li>
				{/if}
			</ul>
		</div>
	{/if}

	<div class="mt-5 space-y-5 border-t border-zinc-100 pt-5">
		<fieldset>
			<legend class="text-sm font-medium text-zinc-700">Visibility</legend>
			<div class="mt-2 grid grid-cols-2 gap-2">
				<button
					type="button"
					aria-pressed={effectivePublic}
					class="rounded-lg border p-3 text-left {effectivePublic
						? 'border-accent-500 bg-accent-50'
						: 'border-zinc-200'}"
					onclick={() => (isPublic = true)}
				>
					<span class="block text-sm font-medium text-zinc-800">Public</span>
					<span class="mt-1 block text-xs text-zinc-500">
						Anyone with the link
					</span>
				</button>
				<button
					type="button"
					disabled={hasHtml}
					aria-pressed={!effectivePublic}
					class="rounded-lg border p-3 text-left disabled:opacity-40 {!effectivePublic
						? 'border-accent-500 bg-accent-50'
						: 'border-zinc-200'}"
					onclick={() => (isPublic = false)}
				>
					<span class="block text-sm font-medium text-zinc-800">Private</span>
					<span class="mt-1 block text-xs text-zinc-500">
						Signed 15-minute links
					</span>
				</button>
			</div>
			{#if hasHtml}
				<p class="mt-2 text-xs text-amber-700">
					HTML is always public so it can render safely on the content origin.
				</p>
			{/if}
		</fieldset>

		{#if tags.length > 0}
			<div>
				<p class="mb-2 text-sm font-medium text-zinc-700">Tags</p>
				<TagPicker
					{tags}
					selected={selectedTags}
					ontoggle={(tag) => {
						selectedTags = selectedTags.some((item) => item.id === tag.id)
							? selectedTags.filter((item) => item.id !== tag.id)
							: [...selectedTags, tag];
					}}
				/>
			</div>
		{/if}

		<ExpirySelect bind:value={expiresAt} />
	</div>

	<footer class="mt-6 flex justify-end gap-2">
		<Button variant="secondary" onclick={() => (open = false)}>Cancel</Button>
		<Button disabled={selected.length === 0} onclick={queue}>
			Upload {selected.length || ''}
		</Button>
	</footer>
</Modal>
