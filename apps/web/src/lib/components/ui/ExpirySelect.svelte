<script lang="ts">
	import { formatDate, toLocalDateTimeInput } from '$lib/dashboard/format';

	let {
		value = $bindable(''),
		identity,
		label = 'Expiration',
		disabled = false,
		onchange
	}: {
		value?: string;
		identity?: string;
		label?: string;
		disabled?: boolean;
		onchange?: (value: string) => void | boolean | Promise<void | boolean>;
	} = $props();

	const presets = [
		{ label: 'Never', hours: 0 },
		{ label: '1 hour', hours: 1 },
		{ label: '1 day', hours: 24 },
		{ label: '7 days', hours: 168 },
		{ label: '30 days', hours: 720 }
	];

	type Interaction = {
		readonly sourceKey: string;
		readonly picked: number | 'custom';
		readonly draft?: string;
	};

	const makeSourceKey = (id: string | undefined, sourceValue: string) =>
		`${id ?? ''}\u0000${sourceValue}`;
	const sourceKey = $derived(makeSourceKey(identity, value));
	let interaction = $state<Interaction>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let generation = 0;

	const clearTimer = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	};

	$effect(() => {
		const currentSourceKey = sourceKey;
		return () => {
			void currentSourceKey;
			generation += 1;
			clearTimer();
		};
	});

	const currentInteraction = $derived(
		interaction?.sourceKey === sourceKey ? interaction : undefined
	);
	const currentValue = $derived(currentInteraction?.draft ?? value);

	// What the user clicked this session wins; otherwise infer the closest
	// preset from the time remaining on the current expiration.
	const active = $derived.by(() => {
		if (currentInteraction) return currentInteraction.picked;
		if (!currentValue) return 0;
		const remaining =
			(new Date(currentValue).getTime() - Date.now()) / 3_600_000;
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

	const commitLocal = (next: string, nextPicked: Interaction['picked']) => {
		value = next;
		interaction = {
			sourceKey: makeSourceKey(identity, next),
			picked: nextPicked
		};
	};

	const persist = async (
		next: string,
		nextPicked: Interaction['picked'],
		requestSourceKey: string,
		ownGeneration: number
	) => {
		try {
			const result = await onchange?.(next);
			if (ownGeneration !== generation || requestSourceKey !== sourceKey) {
				return;
			}
			if (result === false) {
				interaction = undefined;
				return;
			}
			commitLocal(next, nextPicked);
		} catch {
			if (ownGeneration === generation && requestSourceKey === sourceKey) {
				interaction = undefined;
			}
		}
	};

	const apply = (next: string, nextPicked: number | 'custom') => {
		clearTimer();
		if (!onchange) {
			commitLocal(next, nextPicked);
			return;
		}
		const requestSourceKey = sourceKey;
		interaction = {
			sourceKey: requestSourceKey,
			picked: nextPicked,
			draft: next
		};
		const ownGeneration = ++generation;
		void persist(next, nextPicked, requestSourceKey, ownGeneration);
	};

	const choose = (hours: number) => {
		const next =
			hours === 0
				? ''
				: new Date(Date.now() + hours * 60 * 60 * 1_000).toISOString();
		apply(next, hours);
	};

	const chooseCustom = (raw: string) => {
		const nextDate = raw ? new Date(raw) : null;
		if (nextDate && Number.isNaN(nextDate.getTime())) return;
		const next = nextDate?.toISOString() ?? '';
		clearTimer();
		if (!onchange) {
			commitLocal(next, 'custom');
			return;
		}
		const requestSourceKey = sourceKey;
		interaction = {
			sourceKey: requestSourceKey,
			picked: 'custom',
			draft: next
		};
		const ownGeneration = ++generation;
		// datetime-local fires on every field edit — debounce the save.
		timer = setTimeout(() => {
			timer = undefined;
			void persist(next, 'custom', requestSourceKey, ownGeneration);
		}, 500);
	};

	const showCustom = () => {
		clearTimer();
		generation += 1;
		interaction = {
			sourceKey,
			picked: 'custom',
			draft: currentValue
		};
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
			onclick={showCustom}>Custom</button
		>
	</div>
	{#if active === 'custom'}
		<input
			type="datetime-local"
			class="mt-2 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
			value={toLocalDateTimeInput(currentValue)}
			oninput={(event) => chooseCustom(event.currentTarget.value)}
		/>
	{/if}
	{#if currentValue}
		<p class="mt-2 text-xs text-zinc-500">
			Expires {formatDate(currentValue)}
		</p>
	{/if}
</fieldset>
