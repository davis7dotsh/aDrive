<script lang="ts">
	import { page } from '$app/state';
	import { getOrgSettings, listFiles } from '$lib/dashboard/api';
	import { formatBytes } from '$lib/dashboard/format';
	import { getDashboardSession } from '$lib/dashboard/session.svelte';
	import ApiKeys from '$lib/components/auth/ApiKeys.svelte';
	import OrgSlug from '$lib/components/auth/OrgSlug.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import { resource } from 'runed';

	const session = getDashboardSession();
	const canChangeSlug = $derived(page.data.session?.role === 'owner');
	const settings = resource(
		() => [session.ready, session.token] as const,
		([ready, token], _previous, { signal }) =>
			ready && token ? listFiles(token, false, signal) : Promise.resolve(null)
	);
	const org = resource(
		() => [session.ready, session.token] as const,
		([ready, token], _previous, { signal }) =>
			ready && token ? getOrgSettings(token, signal) : Promise.resolve(null)
	);
</script>

<svelte:head>
	<title>Settings · adrive</title>
</svelte:head>

<main class="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
	<a
		href="/"
		class="inline-flex items-center gap-1 text-sm font-medium text-zinc-500 hover:text-zinc-900"
	>
		<Icon name="arrow-left" />
		Files
	</a>
	<h1 class="mt-5 text-3xl font-semibold tracking-tight text-zinc-950">
		Settings
	</h1>

	{#if !session.ready || (settings.loading && !settings.current)}
		<div class="mt-8 animate-pulse space-y-3">
			<div class="h-5 w-1/3 rounded bg-zinc-100"></div>
			<div class="h-24 rounded bg-zinc-100"></div>
		</div>
	{:else if !session.token}
		<p class="mt-8 text-sm text-zinc-500">
			<a href="/" class="font-medium text-zinc-900">Sign in</a> to manage settings.
		</p>
	{:else if settings.error && !settings.current}
		<div class="mt-8 text-sm" role="alert">
			<p class="text-red-700">{settings.error.message}</p>
			<button
				type="button"
				class="mt-3 font-medium text-zinc-900"
				onclick={() => void settings.refetch()}>Try again</button
			>
		</div>
	{:else}
		{#if settings.error}
			<div
				class="mt-8 flex items-center justify-between gap-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3"
				role="alert"
			>
				<p class="text-sm text-red-800">{settings.error.message}</p>
				<button
					type="button"
					class="text-sm font-medium text-zinc-900"
					onclick={() => void settings.refetch()}>Try again</button
				>
			</div>
		{/if}
		<section class="mt-8 rounded-xl border border-zinc-200 p-5">
			<h2 class="text-lg font-semibold text-zinc-950">Drive</h2>
			<dl class="mt-4 space-y-3 text-sm">
				<div class="flex justify-between gap-4">
					<dt class="text-zinc-500">Content origin</dt>
					<dd class="break-all text-right text-zinc-800">
						{org.current?.contentOrigin ??
							settings.current?.contentOrigin ??
							'Unavailable'}
					</dd>
				</div>
				<div class="flex justify-between gap-4">
					<dt class="text-zinc-500">Upload limit</dt>
					<dd class="text-zinc-800">
						{formatBytes(settings.current?.maxUploadBytes ?? 0)}
					</dd>
				</div>
				<div class="flex justify-between gap-4">
					<dt class="text-zinc-500">Semantic search</dt>
					<dd class="text-right text-zinc-800">
						{settings.current?.semantic.enabled
							? `${settings.current.semantic.indexedChunks} indexed chunks`
							: 'Disabled'}
					</dd>
				</div>
			</dl>
			{#if settings.current?.semantic.costNotice}
				<p class="mt-3 text-xs leading-5 text-zinc-400">
					{settings.current.semantic.model} · {settings.current.semantic
						.costNotice}
				</p>
			{/if}
			{#if canChangeSlug}
				<div class="mt-4 min-h-28" aria-busy={org.loading}>
					{#if org.current}
						{#key org.current.slug}
							<OrgSlug
								token={session.token}
								org={org.current}
								onchanged={(updated) => org.mutate(updated)}
							/>
						{/key}
					{:else if org.error}
						<div
							class="flex min-h-28 items-center justify-between gap-3"
							role="alert"
						>
							<p class="text-sm text-red-700">{org.error.message}</p>
							<Button
								variant="secondary"
								disabled={org.loading}
								onclick={() => void org.refetch()}>Try again</Button
							>
						</div>
					{:else}
						<div role="status" aria-label="Loading organization settings">
							<span class="sr-only">Loading organization settings</span>
							<div
								class="max-w-xl animate-pulse motion-reduce:animate-none"
								aria-hidden="true"
							>
								<div class="h-5 w-12 rounded bg-zinc-100"></div>
								<div class="mt-2 h-10 rounded-md bg-zinc-100"></div>
								<div class="mt-2 h-5 w-3/4 rounded bg-zinc-100"></div>
							</div>
						</div>
					{/if}
				</div>
			{/if}
			<a
				href="/settings/billing"
				class="mt-5 inline-block text-sm font-medium text-zinc-900 hover:underline"
			>
				Plan and usage
			</a>
		</section>

		<div class="mt-10 border-t border-zinc-200 pt-8">
			<ApiKeys token={session.token} />
		</div>
	{/if}
</main>
