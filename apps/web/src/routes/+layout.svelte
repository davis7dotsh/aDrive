<script lang="ts">
	import '../app.css';
	import { createDashboardSession } from '$lib/dashboard/session.svelte';
	import { createToasts } from '$lib/dashboard/toast.svelte';
	import Toast from '$lib/components/ui/Toast.svelte';
	import type { LayoutProps } from './$types';
	import { untrack } from 'svelte';

	let { children, data }: LayoutProps = $props();
	const session = createDashboardSession(untrack(() => data.browserSession));
	createToasts();
	const authError = $derived(
		session.error || (!session.ready ? data.authError : '')
	);

	$effect(() => {
		if (!session.ready) void session.restore();
	});
</script>

<svelte:head>
	<meta
		name="description"
		content="A small, self-hosted file drive for agents and scripts."
	/>
	<meta name="color-scheme" content="light dark" />
	<meta
		name="theme-color"
		content="#ffffff"
		media="(prefers-color-scheme: light)"
	/>
	<meta
		name="theme-color"
		content="#09090b"
		media="(prefers-color-scheme: dark)"
	/>
	<meta property="og:type" content="website" />
	<meta property="og:site_name" content="adrive" />
	<meta property="og:title" content="adrive" />
	<meta
		property="og:description"
		content="A small, self-hosted file drive for agents and scripts."
	/>
	<meta property="og:image" content={`${data.origin}/og-image.png`} />
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content="adrive" />
	<meta
		name="twitter:description"
		content="A small, self-hosted file drive for agents and scripts."
	/>
	<meta name="twitter:image" content={`${data.origin}/og-image.png`} />
	<meta name="apple-mobile-web-app-title" content="adrive" />
	<link rel="icon" href="/favicon.svg" />
	<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
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
						disabled={session.connecting}
						class="rounded-md px-3 py-2 text-sm text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"
						onclick={() => void session.disconnect()}
					>
						{session.connecting ? 'Signing out…' : 'Sign out'}
					</button>
				</nav>
			{/if}
		</div>
		{#if authError}
			<p
				class="mx-auto max-w-7xl px-4 pb-3 text-right text-xs text-red-700 sm:px-6"
				aria-live="polite"
			>
				{authError}
			</p>
		{/if}
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
