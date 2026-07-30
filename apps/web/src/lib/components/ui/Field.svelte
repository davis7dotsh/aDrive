<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';

	let {
		id,
		label,
		value = $bindable(''),
		error = '',
		description = '',
		class: className = '',
		...attributes
	}: Omit<HTMLInputAttributes, 'value'> & {
		id: string;
		label: string;
		value?: string;
		error?: string;
		description?: string;
	} = $props();

	const descriptionId = $derived(description ? `${id}-description` : undefined);
	const errorId = $derived(error ? `${id}-error` : undefined);
	const describedBy = $derived(
		[descriptionId, errorId].filter(Boolean).join(' ') || undefined
	);
</script>

<div>
	<label for={id} class="text-sm font-medium text-zinc-700">{label}</label>
	<input
		{id}
		bind:value
		aria-describedby={describedBy}
		aria-invalid={error ? 'true' : undefined}
		class="mt-2 w-full rounded-md border border-zinc-300 bg-white px-3 py-2.5 text-sm shadow-sm {className}"
		{...attributes}
	/>
	{#if description}
		<p id={descriptionId} class="mt-2 text-xs leading-5 text-zinc-500">
			{description}
		</p>
	{/if}
	{#if error}
		<p id={errorId} class="mt-2 text-sm text-red-600" role="alert">
			{error}
		</p>
	{/if}
</div>
