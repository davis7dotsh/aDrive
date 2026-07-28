<script lang="ts">
	import { onMount } from 'svelte';
	import '../app.css';
	import { createDashboardSession } from '$lib/dashboard/session.svelte';

	let { children } = $props();
	const session = createDashboardSession();

	onMount(() => session.restore());
</script>

<svelte:head>
	<meta
		name="description"
		content="A small, self-hosted file drive for agents and scripts."
	/>
</svelte:head>

<div class="min-h-screen">
	<header class="border-b border-zinc-200 bg-white">
		<div
			class="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6"
		>
			<a
				href="/"
				class="flex items-center gap-2 text-sm font-semibold tracking-tight text-zinc-950"
			>
				<span
					class="flex size-7 items-center justify-center rounded-md bg-zinc-950 text-xs font-bold text-white"
					aria-hidden="true">a</span
				>
				adrive
			</a>
			{#if session.token}
				<button
					type="button"
					class="rounded-md px-3 py-2 text-sm text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"
					onclick={session.disconnect}
				>
					Disconnect
				</button>
			{/if}
		</div>
	</header>

	{@render children()}
</div>
