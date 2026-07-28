<script lang="ts">
	import { onMount } from 'svelte';
	import '../app.css';
	import { createDashboardSession } from '$lib/dashboard/session.svelte';

	let { children } = $props();
	const session = createDashboardSession();

	onMount(() => {
		void session.restore();
	});
</script>

<svelte:head>
	<meta
		name="description"
		content="A small, self-hosted file drive for agents and scripts."
	/>
</svelte:head>

<div class="min-h-screen bg-white">
	<header class="border-b border-zinc-200 bg-white">
		<div
			class="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6"
		>
			<a href="/" class="text-sm font-semibold tracking-tight text-zinc-950">
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
