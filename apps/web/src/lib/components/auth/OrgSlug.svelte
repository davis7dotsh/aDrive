<script lang="ts">
	import type { OrgSettings } from '@adrive/shared';
	import { untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { changeOrgSlug } from '$lib/dashboard/api';
	import { formatDate } from '$lib/dashboard/format';
	import { getToasts } from '$lib/dashboard/toast.svelte';
	import Button from '$lib/components/ui/Button.svelte';

	let {
		token,
		org,
		onchanged
	}: {
		token: string;
		org: OrgSettings;
		onchanged: (updated: OrgSettings) => void;
	} = $props();
	const toasts = getToasts();
	// The settings page keys this component on the slug, so the prop only
	// seeds local state; a successful change replaces it from the response.
	let current = $state(untrack(() => org));
	let slug = $state(untrack(() => org.slug));
	let busy = $state(false);
	let cooldownTick = $state(0);

	const unchanged = $derived(slug.trim().toLowerCase() === current.slug);
	const cooldownEndsAt = $derived(
		current.nextSlugChangeAt ? Date.parse(current.nextSlugChangeAt) : 0
	);
	const locked = $derived.by(() => {
		cooldownTick;
		return cooldownEndsAt > Date.now();
	});

	$effect(() => {
		const target = cooldownEndsAt;
		const remaining = target - Date.now();
		if (!Number.isFinite(target) || remaining <= 0) return;
		// Thirty days exceeds the browser's signed 32-bit timer limit.
		const boundedDelay = (delay: number) => Math.min(delay, 2_147_000_000);
		let timer = setTimeout(checkCooldown, boundedDelay(remaining));
		function checkCooldown() {
			const remaining = target - Date.now();
			if (remaining <= 0) {
				cooldownTick += 1;
				return;
			}
			timer = setTimeout(checkCooldown, boundedDelay(remaining));
		}
		return () => clearTimeout(timer);
	});

	const save = async () => {
		if (unchanged || locked || busy) return;
		busy = true;
		try {
			current = await changeOrgSlug(token, slug);
			slug = current.slug;
			onchanged(current);
			toasts.success(`Content now lives at ${current.contentOrigin}`);
			await invalidateAll().catch((cause) => {
				toasts.error(cause, 'Could not refresh the page');
			});
		} catch (cause) {
			toasts.error(cause, 'Could not change the slug');
		} finally {
			busy = false;
		}
	};
</script>

<form
	class="flex max-w-xl items-end gap-2"
	onsubmit={(event) => {
		event.preventDefault();
		void save();
	}}
>
	<label class="min-w-0 flex-1 text-sm">
		<span class="font-medium text-zinc-700">Slug</span>
		<input
			bind:value={slug}
			disabled={locked || busy}
			autocapitalize="off"
			autocorrect="off"
			spellcheck="false"
			class="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm disabled:bg-zinc-50 disabled:text-zinc-500"
		/>
	</label>
	<Button type="submit" disabled={unchanged || locked || busy}>
		Change slug
	</Button>
</form>
<p class="mt-2 text-xs leading-5 text-zinc-500">
	{#if locked && current.nextSlugChangeAt}
		Changed recently; it can change again on {formatDate(
			current.nextSlugChangeAt
		)}.
	{:else}
		Once per 30 days. The old address redirects for 30 days.
	{/if}
</p>
