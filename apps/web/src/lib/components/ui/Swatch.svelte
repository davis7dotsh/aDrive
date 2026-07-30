<script lang="ts">
	import { onDestroy } from 'svelte';
	import Menu from './Menu.svelte';

	let {
		value = $bindable('#2563eb'),
		onchange
	}: {
		value?: string;
		onchange?: (value: string) => void | boolean | Promise<void | boolean>;
	} = $props();

	const colors = [
		'#2563eb',
		'#7c3aed',
		'#db2777',
		'#dc2626',
		'#ea580c',
		'#ca8a04',
		'#059669',
		'#71717a'
	];

	let optimistic = $state<{
		readonly sourceValue: string;
		readonly nextValue: string;
	}>();
	let pending = $state(false);
	let generation = 0;
	const currentValue = $derived(
		optimistic?.sourceValue === value ? optimistic.nextValue : value
	);

	onDestroy(() => {
		generation += 1;
	});

	const select = async (color: string) => {
		if (pending || color === currentValue) return;
		if (!onchange) {
			value = color;
			return;
		}

		const sourceValue = value;
		const ownGeneration = ++generation;
		optimistic = { sourceValue, nextValue: color };
		pending = true;
		try {
			const result = await onchange(color);
			if (ownGeneration !== generation) return;
			if (value !== sourceValue) {
				optimistic = undefined;
				return;
			}
			if (result === false) {
				optimistic = undefined;
				return;
			}
			value = color;
			optimistic = undefined;
		} catch {
			if (ownGeneration === generation) optimistic = undefined;
		} finally {
			if (ownGeneration === generation) pending = false;
		}
	};
</script>

<Menu label="Choose tag color" align="start">
	{#snippet trigger()}
		<span
			class="size-6 rounded-full border border-black/10"
			style:background={currentValue}
		></span>
	{/snippet}
	<div class="grid grid-cols-4 gap-1 p-1.5">
		{#each colors as color (color)}
			<button
				type="button"
				role="menuitemradio"
				aria-checked={currentValue === color}
				disabled={pending}
				class="size-7 rounded-full border border-black/10 ring-offset-2 hover:ring-2 hover:ring-zinc-300"
				style:background={color}
				aria-label={`Use ${color}`}
				onclick={() => void select(color)}
			></button>
		{/each}
	</div>
	<label
		class="flex items-center gap-2 border-t border-zinc-100 px-2 py-2 text-xs text-zinc-600"
	>
		Custom
		<input
			type="color"
			value={currentValue}
			disabled={pending}
			class="ml-auto size-7 rounded border border-zinc-200 bg-white p-0.5"
			onchange={(event) => void select(event.currentTarget.value)}
		/>
	</label>
</Menu>
