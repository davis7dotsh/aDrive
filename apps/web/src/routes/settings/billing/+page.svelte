<script lang="ts">
	import {
		getBilling,
		openBillingPortal,
		startCheckout
	} from '$lib/dashboard/api';
	import { formatBytes } from '$lib/dashboard/format';
	import { getDashboardSession } from '$lib/dashboard/session.svelte';
	import { getToasts } from '$lib/dashboard/toast.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import { resource } from 'runed';

	const session = getDashboardSession();
	const toasts = getToasts();
	const billing = resource(
		() => [session.ready, session.token] as const,
		([ready, token], _previous, { signal }) =>
			ready && token ? getBilling(token, signal) : Promise.resolve(null)
	);
	let busy = $state<'checkout' | 'portal' | null>(null);

	const percent = (used: number, limit: number) =>
		limit <= 0 ? 0 : Math.min(100, Math.round((used / limit) * 100));

	const count = new Intl.NumberFormat();

	const follow = async (
		kind: 'checkout' | 'portal',
		start: (token: string) => Promise<string | null>,
		fallback: string
	) => {
		if (busy || !session.token) return;
		busy = kind;
		try {
			const url = await start(session.token);
			if (url) {
				window.location.assign(url);
				return;
			}
			toasts.info(fallback);
			void billing.refetch();
		} catch (cause) {
			toasts.error(cause, 'Billing is unavailable right now');
		} finally {
			busy = null;
		}
	};
</script>

<svelte:head>
	<title>Billing · adrive</title>
</svelte:head>

<main class="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
	<a
		href="/settings"
		class="inline-flex items-center gap-1 text-sm font-medium text-zinc-500 hover:text-zinc-900"
	>
		<Icon name="arrow-left" />
		Settings
	</a>
	<h1 class="mt-5 text-3xl font-semibold tracking-tight text-zinc-950">
		Billing
	</h1>

	{#if !session.ready || (billing.loading && !billing.current)}
		<div class="mt-8 animate-pulse space-y-3">
			<div class="h-5 w-1/3 rounded bg-zinc-100"></div>
			<div class="h-24 rounded bg-zinc-100"></div>
		</div>
	{:else if !session.token}
		<p class="mt-8 text-sm text-zinc-500">
			<a href="/" class="font-medium text-zinc-900">Sign in</a> to see your plan.
		</p>
	{:else if billing.error && !billing.current}
		<div class="mt-8 text-sm" role="alert">
			<p class="text-red-700">{billing.error.message}</p>
			<button
				type="button"
				class="mt-3 font-medium text-zinc-900"
				onclick={() => void billing.refetch()}>Try again</button
			>
		</div>
	{:else if billing.current}
		{@const summary = billing.current}
		<div class="mt-8 flex items-center justify-between gap-4">
			<p class="text-sm text-zinc-500">
				Current plan
				<span class="ml-2 font-medium text-zinc-950">{summary.planName}</span>
			</p>
			<div class="flex gap-2">
				{#if summary.plan !== 'pro'}
					<Button
						disabled={busy !== null || !summary.billingEnabled}
						onclick={() =>
							void follow(
								'checkout',
								startCheckout,
								'Your plan was updated without a checkout step'
							)}
					>
						Upgrade to Pro
					</Button>
				{/if}
				<Button
					variant="secondary"
					disabled={busy !== null || !summary.billingEnabled}
					onclick={() =>
						void follow(
							'portal',
							openBillingPortal,
							'Billing is not configured for this deployment'
						)}
				>
					Manage billing
				</Button>
			</div>
		</div>

		<dl class="mt-8 space-y-6">
			<div>
				<div class="flex justify-between text-sm">
					<dt class="text-zinc-700">Storage</dt>
					<dd class="tabular-nums text-zinc-500">
						{formatBytes(summary.storage.used)} of {formatBytes(
							summary.storage.limit
						)}
					</dd>
				</div>
				<div class="mt-2 h-2 w-full overflow-hidden rounded-full bg-zinc-100">
					<div
						class="h-full rounded-full bg-[#4DABF7]"
						style:width="{percent(
							summary.storage.used,
							summary.storage.limit
						)}%"
					></div>
				</div>
			</div>
			<div>
				<div class="flex justify-between text-sm">
					<dt class="text-zinc-700">AI operations this month</dt>
					<dd class="tabular-nums text-zinc-500">
						{count.format(summary.aiOps.used)} of {count.format(
							summary.aiOps.limit
						)}
					</dd>
				</div>
				<div class="mt-2 h-2 w-full overflow-hidden rounded-full bg-zinc-100">
					<div
						class="h-full rounded-full bg-[#4DABF7]"
						style:width="{percent(summary.aiOps.used, summary.aiOps.limit)}%"
					></div>
				</div>
			</div>
		</dl>
	{/if}
</main>
