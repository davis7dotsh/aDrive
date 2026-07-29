<script lang="ts">
	import type { Tag } from '@adrive/shared';
	import { formatBytes, isHtmlFile } from '$lib/dashboard/format';
	import type { UploadManager } from '$lib/dashboard/uploads.svelte';
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
		onqueued
	}: {
		open?: boolean;
		uploads: UploadManager;
		token: string;
		tags: ReadonlyArray<Tag>;
		maxUploadBytes: number;
		onqueued?: () => void;
	} = $props();

	let selected = $state<ReadonlyArray<File>>([]);
	let isPublic = $state(true);
	let selectedTags = $state<ReadonlyArray<Tag>>([]);
	let expiresAt = $state('');
	let input = $state<HTMLInputElement>();
	const attachInput: Attachment<HTMLInputElement> = (node) => {
		input = node;
		return () => {
			if (input === node) input = undefined;
		};
	};
	const hasHtml = $derived(
		selected.some((file) => isHtmlFile(file.name, file.type))
	);

	const choose = (files: FileList | null) => {
		if (!files) return;
		selected = Array.from(files);
	};

	const queue = () => {
		if (selected.length === 0) return;
		uploads.enqueue(selected, {
			token,
			public: hasHtml ? true : isPublic,
			tags: selectedTags,
			expiresAt: expiresAt || null
		});
		selected = [];
		expiresAt = '';
		open = false;
		onqueued?.();
	};
</script>

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
			choose(event.dataTransfer?.files ?? null);
		}}
	>
		<span class="text-sm font-medium text-zinc-800">
			{selected.length
				? `${selected.length} ${selected.length === 1 ? 'file' : 'files'} selected`
				: 'Drop files here or browse'}
		</span>
		<span class="mt-1 text-xs text-zinc-400">
			Up to {formatBytes(maxUploadBytes)} each · paste with ⌘V
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

	<div class="mt-5 space-y-5 border-t border-zinc-100 pt-5">
		<fieldset>
			<legend class="text-sm font-medium text-zinc-700">Visibility</legend>
			<div class="mt-2 grid grid-cols-2 gap-2">
				<button
					type="button"
					aria-pressed={isPublic}
					class="rounded-lg border p-3 text-left {isPublic
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
					aria-pressed={!isPublic}
					class="rounded-lg border p-3 text-left disabled:opacity-40 {!isPublic
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
