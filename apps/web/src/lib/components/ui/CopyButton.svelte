<script lang="ts">
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import { onDestroy, onMount } from 'svelte';
	import { backOut } from 'svelte/easing';
	import { scale } from 'svelte/transition';
	import { copyText } from '$lib/dashboard/format';
	import { getToasts } from '$lib/dashboard/toast.svelte';
	import Icon from './Icon.svelte';

	type Variant = 'primary' | 'secondary' | 'ghost' | 'menu' | 'inline';

	let {
		resolve,
		label = 'Copy link',
		copiedLabel = 'Copied',
		variant = 'primary',
		class: className = '',
		type = 'button',
		...attributes
	}: HTMLButtonAttributes & {
		resolve: () => string | Promise<string>;
		label?: string;
		copiedLabel?: string;
		variant?: Variant;
	} = $props();

	const toasts = getToasts();
	let copied = $state(false);
	let mounted = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	// Skip the intro transition on first render — only pop on state swaps.
	onMount(() => {
		mounted = true;
	});

	onDestroy(() => {
		if (timer) clearTimeout(timer);
	});

	const styles: Record<Variant, string> = {
		primary:
			'rounded-md bg-zinc-950 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800',
		secondary:
			'rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50',
		ghost:
			'rounded-md px-3 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-950',
		menu: 'w-full justify-start rounded-md px-3 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-50 focus:bg-zinc-50 focus:outline-none',
		inline: 'rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100'
	};

	const run = async () => {
		try {
			await copyText(await resolve());
			if (timer) clearTimeout(timer);
			copied = true;
			timer = setTimeout(() => {
				copied = false;
			}, 1_500);
		} catch (cause) {
			toasts.error(cause, 'Could not copy the link');
		}
	};
</script>

<button
	{type}
	class="inline-flex items-center justify-center gap-1.5 transition disabled:pointer-events-none disabled:opacity-50 {styles[
		variant
	]} {className}"
	{...attributes}
	onclick={() => void run()}
>
	{#key copied}
		<span
			class="inline-flex items-center gap-1.5"
			in:scale={{
				duration: mounted ? 180 : 0,
				start: 0.8,
				easing: backOut
			}}
		>
			{#if copied}
				<Icon name="check" class="size-3.5" />
			{/if}
			{copied ? copiedLabel : label}
		</span>
	{/key}
</button>
