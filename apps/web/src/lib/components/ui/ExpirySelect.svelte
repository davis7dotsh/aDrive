<script lang="ts">
	import { onDestroy } from 'svelte';
	import { formatDate } from '$lib/dashboard/format';

	let {
		value = $bindable(''),
		label = 'Expiration',
		disabled = false,
		onchange
	}: {
		value?: string;
		label?: string;
		disabled?: boolean;
		onchange?: (value: string) => void;
	} = $props();

	const presets = [
		{ label: 'Never', hours: 0 },
		{ label: '1 hour', hours: 1 },
		{ label: '1 day', hours: 24 },
		{ label: '7 days', hours: 168 },
		{ label: '30 days', hours: 720 }
	];

	let picked = $state<number | 'custom'>();
	let timer: ReturnType<typeof setTimeout> | undefined;

	onDestroy(() => {
		if (timer) clearTimeout(timer);
	});

	// What the user clicked this session wins; otherwise infer the closest
	// preset from the time remaining on the current expiration.
	const active = $derived.by(() => {
		if (picked !== undefined) return picked;
		if (!value) return 0;
		const remaining = (new Date(value).getTime() - Date.now()) / 3_600_000;
		if (!Number.isFinite(remaining) || remaining <= 0) return 'custom';
		let best: number | 'custom' = 'custom';
		let bestRatio = 1.5;
		for (const preset of presets) {
			if (preset.hours === 0) continue;
			const ratio =
				remaining > preset.hours
					? remaining / preset.hours
					: preset.hours / remaining;
			if (ratio < bestRatio) {
				bestRatio = ratio;
				best = preset.hours;
			}
		}
		return best;
	});

	const choose = (hours: number) => {
		picked = hours;
		value =
			hours === 0
				? ''
				: new Date(Date.now() + hours * 60 * 60 * 1_000).toISOString();
		onchange?.(value);
	};

	const chooseCustom = (raw: string) => {
		picked = 'custom';
		value = raw ? new Date(raw).toISOString() : '';
		if (timer) clearTimeout(timer);
		// datetime-local fires on every field edit — debounce the save.
		timer = setTimeout(() => onchange?.(value), 500);
	};
</script>

<fieldset {disabled}>
	<legend class="text-sm font-medium text-zinc-700">{label}</legend>
	<div class="mt-2 flex flex-wrap gap-1">
		{#each presets as preset (preset.label)}
			<button
				type="button"
				class="rounded-md border px-2.5 py-1.5 text-xs {active === preset.hours
					? 'border-zinc-950 bg-zinc-950 text-white'
					: 'border-zinc-200 text-zinc-600 hover:border-zinc-300'}"
				onclick={() => choose(preset.hours)}>{preset.label}</button
			>
		{/each}
		<button
			type="button"
			class="rounded-md border px-2.5 py-1.5 text-xs {active === 'custom'
				? 'border-zinc-950 bg-zinc-950 text-white'
				: 'border-zinc-200 text-zinc-600 hover:border-zinc-300'}"
			onclick={() => (picked = 'custom')}>Custom</button
		>
	</div>
	{#if active === 'custom'}
		<input
			type="datetime-local"
			class="mt-2 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
			value={value ? value.slice(0, 16) : ''}
			oninput={(event) => chooseCustom(event.currentTarget.value)}
		/>
	{/if}
	{#if value}
		<p class="mt-2 text-xs text-zinc-500">Expires {formatDate(value)}</p>
	{/if}
</fieldset>
