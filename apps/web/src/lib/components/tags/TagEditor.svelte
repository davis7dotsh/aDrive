<script lang="ts">
	import type { Tag } from '@adrive/shared';
	import { deleteTag, updateTag } from '$lib/dashboard/api';
	import { getToasts } from '$lib/dashboard/toast.svelte';
	import Confirm from '$lib/components/ui/Confirm.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import Swatch from '$lib/components/ui/Swatch.svelte';

	let {
		tag,
		token,
		onchanged
	}: {
		tag: Tag;
		token: string;
		onchanged: (tag?: Tag) => void;
	} = $props();

	const toasts = getToasts();
	let name = $derived(tag.name);
	let busy = $state(false);
	let confirmOpen = $state(false);

	const saveName = async () => {
		const next = name.trim();
		if (!next || next === tag.name || busy) {
			name = tag.name;
			return;
		}
		busy = true;
		try {
			const updated = await updateTag(token, tag.id, { name: next });
			name = updated.name;
			onchanged(updated);
			toasts.success(`${updated.name} updated`);
		} catch (cause) {
			name = tag.name;
			toasts.error(cause, 'Could not rename the tag');
		} finally {
			busy = false;
		}
	};

	const saveColor = async (color: string) => {
		if (busy) return false;
		busy = true;
		try {
			onchanged(await updateTag(token, tag.id, { color }));
			return true;
		} catch (cause) {
			toasts.error(cause, 'Could not update the tag color');
			return false;
		} finally {
			busy = false;
		}
	};

	const remove = async () => {
		busy = true;
		try {
			await deleteTag(token, tag.id);
			onchanged();
			confirmOpen = false;
			toasts.success(`${tag.name} deleted. Files kept their other tags.`);
		} catch (cause) {
			toasts.error(cause, 'Could not delete the tag');
		} finally {
			busy = false;
		}
	};
</script>

<div
	class="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 py-2.5"
>
	<Swatch value={tag.color ?? '#71717a'} onchange={saveColor} />
	<input
		aria-label={`Rename ${tag.name}`}
		bind:value={name}
		disabled={busy}
		class="min-w-0 rounded-md border border-transparent px-2 py-1.5 text-sm font-medium text-zinc-800 hover:border-zinc-200 focus:border-zinc-300 focus:outline-none"
		onblur={() => void saveName()}
		onkeydown={(event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				event.currentTarget.blur();
			} else if (event.key === 'Escape') {
				name = tag.name;
				event.currentTarget.blur();
			}
		}}
	/>
	<span class="whitespace-nowrap text-xs text-zinc-400">
		{tag.fileCount}
		{tag.fileCount === 1 ? 'file' : 'files'}
	</span>
	<button
		type="button"
		class="rounded-md p-2 text-zinc-400 hover:bg-red-50 hover:text-red-700"
		aria-label={`Delete ${tag.name}`}
		onclick={() => (confirmOpen = true)}
	>
		<Icon name="trash" />
	</button>
</div>

<Confirm
	bind:open={confirmOpen}
	title={`Delete ${tag.name}?`}
	message={`${tag.fileCount} ${tag.fileCount === 1 ? 'file keeps' : 'files keep'} its other tags. This cannot be undone.`}
	confirmLabel="Delete tag"
	{busy}
	onconfirm={remove}
/>
