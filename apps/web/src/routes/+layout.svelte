<script lang="ts">
	import '../app.css';
	import { createDashboardSession } from '$lib/dashboard/session.svelte';
	import { createToasts } from '$lib/dashboard/toast.svelte';
	import Toast from '$lib/components/ui/Toast.svelte';

	let { children } = $props();
	const session = createDashboardSession();
	createToasts();

	$effect(() => {
		void session.restore();
	});
</script>

<svelte:head>
	<meta
		name="description"
		content="A small, self-hosted file drive for agents and scripts."
	/>
	<meta name="theme-color" content="#ffffff" />
	<link rel="icon" href="/favicon.svg" />
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
				<nav class="flex items-center gap-1" aria-label="Account">
					<a
						href="/settings"
						class="rounded-md px-3 py-2 text-sm text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"
					>
						Settings
					</a>
					<button
						type="button"
						class="rounded-md px-3 py-2 text-sm text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"
						onclick={session.disconnect}
					>
						Sign out
					</button>
				</nav>
			{/if}
		</div>
	</header>

	<svelte:boundary>
		{@render children()}
		{#snippet failed(error: unknown, reset: () => void)}
			<main class="mx-auto max-w-xl px-6 py-20 text-center">
				<h1 class="text-lg font-semibold text-zinc-950">
					This page could not be displayed
				</h1>
				<p class="mt-2 text-sm text-zinc-500">
					{error instanceof Error
						? error.message
						: 'Unexpected interface error'}
				</p>
				<button
					type="button"
					class="mt-5 rounded-md bg-zinc-950 px-4 py-2 text-sm font-medium text-white"
					onclick={reset}>Try again</button
				>
			</main>
		{/snippet}
	</svelte:boundary>
	<Toast />
</div>
