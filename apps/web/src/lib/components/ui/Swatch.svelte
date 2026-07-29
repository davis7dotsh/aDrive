<script lang="ts">
	import Menu from './Menu.svelte';

	let {
		value = $bindable('#2563eb'),
		onchange
	}: {
		value?: string;
		onchange?: (value: string) => void | Promise<void>;
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

	const select = (color: string) => {
		value = color;
		void onchange?.(color);
	};
</script>

<Menu label="Choose tag color" align="start">
	{#snippet trigger()}
		<span
			class="size-6 rounded-full border border-black/10"
			style:background={value}
		></span>
	{/snippet}
	<div class="grid grid-cols-4 gap-1 p-1.5">
		{#each colors as color (color)}
			<button
				type="button"
				role="menuitem"
				class="size-7 rounded-full border border-black/10 ring-offset-2 hover:ring-2 hover:ring-zinc-300"
				style:background={color}
				aria-label={`Use ${color}`}
				onclick={() => select(color)}
			></button>
		{/each}
	</div>
	<label
		class="flex items-center gap-2 border-t border-zinc-100 px-2 py-2 text-xs text-zinc-600"
	>
		Custom
		<input
			type="color"
			{value}
			class="ml-auto size-7 rounded border border-zinc-200 bg-white p-0.5"
			oninput={(event) => select(event.currentTarget.value)}
		/>
	</label>
</Menu>
