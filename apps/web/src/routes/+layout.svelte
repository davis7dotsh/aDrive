<script lang="ts">
	import '../app.css';
	import { createDashboardSession } from '$lib/dashboard/session.svelte';
	import { createToasts } from '$lib/dashboard/toast.svelte';
	import Toast from '$lib/components/ui/Toast.svelte';
	import type { LayoutProps } from './$types';
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import {
		DESIGN_VARIANTS as VARIANTS,
		parseDesignVariant,
		provideDesignVariant
	} from '$lib/dashboard/design-variant';

	let { children, data }: LayoutProps = $props();
	// /A … /E render the files page under one of the design variants.
	const variant = $derived(parseDesignVariant(page.params.design));
	provideDesignVariant(() => variant);
	const variantNames = {
		a: 'Ember',
		b: 'Iris',
		c: 'Terminal',
		d: 'Tide',
		e: 'Sage'
	} as const;
	const session = createDashboardSession(untrack(() => data.session !== null));
	createToasts();

	// A stale page whose cookie expired shows the sign-in state after the
	// next check instead of a wall of 401 toasts.
	$effect(() => {
		if (data.session === null && session.token) void session.restore();
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

<div class="min-h-screen bg-white" data-theme={variant ?? undefined}>
	<header class="border-b border-zinc-200 bg-white">
		<div
			class="mx-auto flex min-h-16 max-w-7xl flex-wrap items-center justify-between gap-y-2 px-4 py-3 sm:h-16 sm:flex-nowrap sm:px-6 sm:py-0"
		>
			<div class="flex items-center gap-5">
				<a
					href={variant ? `/${variant.toUpperCase()}` : '/'}
					class="inline-flex items-center gap-2 text-sm font-semibold tracking-tight text-zinc-950"
				>
					<span class="brand-dot size-2.5 rounded-full" aria-hidden="true"
					></span>
					adrive
				</a>
				{#if variant}
					<nav
						class="segment inline-flex rounded-lg bg-zinc-100 p-0.5 text-xs font-medium"
						aria-label="Design variant"
					>
						{#each VARIANTS as candidate (candidate)}
							<a
								href={`/${candidate.toUpperCase()}`}
								aria-current={candidate === variant ? 'page' : undefined}
								title={variantNames[candidate]}
								class="rounded-md px-2 py-1 font-mono uppercase {candidate ===
								variant
									? 'bg-white text-zinc-950 shadow-sm'
									: 'text-zinc-500 hover:text-zinc-900'}"
							>
								{candidate}
							</a>
						{/each}
					</nav>
				{/if}
			</div>
			{#if data.session}
				<nav
					class="flex w-full min-w-0 items-center justify-end gap-1 sm:w-auto"
					aria-label="Account"
				>
					<span class="min-w-0 flex-1 truncate px-3 py-2 text-sm text-zinc-500">
						{data.session.org.name}
					</span>
					{#if data.session.user.admin}
						<a
							href="/admin"
							class="shrink-0 rounded-md px-3 py-2 text-sm text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"
						>
							Admin
						</a>
					{/if}
					<a
						href="/settings"
						class="shrink-0 rounded-md px-3 py-2 text-sm text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"
					>
						Settings
					</a>
					<form
						class="shrink-0"
						method="post"
						action="/auth/sign-out"
						data-sveltekit-reload
					>
						<button
							type="submit"
							class="rounded-md px-3 py-2 text-sm text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"
						>
							Sign out
						</button>
					</form>
				</nav>
			{/if}
		</div>
		{#if session.error}
			<p
				class="mx-auto max-w-7xl px-4 pb-3 text-right text-xs text-red-700 sm:px-6"
				aria-live="polite"
			>
				{session.error}
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
