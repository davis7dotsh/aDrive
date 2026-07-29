<script lang="ts">
	import { onDestroy } from 'svelte';
	import { flip } from 'svelte/animate';
	import { fly } from 'svelte/transition';
	import { getToasts } from '$lib/dashboard/toast.svelte';
	import Icon from './Icon.svelte';

	const toasts = getToasts();
	onDestroy(() => toasts.clear());
</script>

<div
	class="pointer-events-none fixed right-4 bottom-4 z-[100] flex w-[min(24rem,calc(100%-2rem))] flex-col gap-2"
	aria-live="polite"
	aria-atomic="false"
>
	{#each toasts.items as item (item.id)}
		<div
			transition:fly={{ y: 12, duration: 180 }}
			animate:flip={{ duration: 150 }}
			class="pointer-events-auto flex items-start gap-3 rounded-lg border bg-white p-3 shadow-lg {item.tone ===
			'error'
				? 'border-red-200'
				: item.tone === 'success'
					? 'border-emerald-200'
					: 'border-zinc-200'}"
			role={item.tone === 'error' ? 'alert' : 'status'}
		>
			<p class="min-w-0 flex-1 text-sm text-zinc-700">{item.message}</p>
			{#if item.action}
				<button
					type="button"
					class="text-sm font-semibold text-accent-700"
					onclick={() => {
						void item.action?.run();
						toasts.remove(item.id);
					}}>{item.action.label}</button
				>
			{/if}
			<button
				type="button"
				class="text-zinc-400 hover:text-zinc-700"
				aria-label="Dismiss notification"
				onclick={() => toasts.remove(item.id)}
			>
				<Icon name="close" />
			</button>
		</div>
	{/each}
</div>
