<script lang="ts">
	import type { Tag } from '@adrive/shared';
	import { createTag } from '$lib/dashboard/api';
	import { getToasts } from '$lib/dashboard/toast.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Modal from '$lib/components/ui/Modal.svelte';
	import Swatch from '$lib/components/ui/Swatch.svelte';
	import TagEditor from './TagEditor.svelte';

	let {
		open = $bindable(false),
		tags,
		token,
		onchanged
	}: {
		open?: boolean;
		tags: ReadonlyArray<Tag>;
		token: string;
		onchanged: () => void;
	} = $props();

	const toasts = getToasts();
	let name = $state('');
	let color = $state('#2563eb');
	let busy = $state(false);

	const create = async () => {
		if (!name.trim() || busy) return;
		busy = true;
		try {
			const tag = await createTag(token, { name, color });
			name = '';
			onchanged();
			toasts.success(`${tag.name} is ready to use`);
		} catch (cause) {
			toasts.error(cause, 'Could not create the tag');
		} finally {
			busy = false;
		}
	};
</script>

<Modal
	bind:open
	title="Manage tags"
	description="Rename, recolor, and remove the tags used to organize files."
	width="max-w-2xl"
>
	<form
		class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-b border-zinc-100 pb-4"
		onsubmit={(event) => {
			event.preventDefault();
			void create();
		}}
	>
		<Swatch bind:value={color} />
		<input
			data-autofocus
			aria-label="New tag name"
			bind:value={name}
			placeholder="New tag name"
			class="min-w-0 rounded-md border border-zinc-300 px-3 py-2 text-sm"
		/>
		<Button type="submit" disabled={!name.trim() || busy}>Create</Button>
	</form>

	{#if tags.length === 0}
		<p class="py-10 text-center text-sm leading-6 text-zinc-500">
			No tags yet. Tags are how you organize — files can have as many as you
			like.
		</p>
	{:else}
		<div class="divide-y divide-zinc-100">
			{#each tags as tag (tag.id)}
				<TagEditor {tag} {token} {onchanged} />
			{/each}
		</div>
	{/if}
</Modal>
