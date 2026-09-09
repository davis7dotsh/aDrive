<script lang="ts">
	import type { OrgSettings } from '@adrive/shared';
	import { untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { changeOrgSlug } from '$lib/dashboard/api';
	import { formatDate } from '$lib/dashboard/format';
	import { getToasts } from '$lib/dashboard/toast.svelte';
	import Button from '$lib/components/ui/Button.svelte';

	let { token, org }: { token: string; org: OrgSettings } = $props();
	const toasts = getToasts();
	// The settings page keys this component on the slug, so the prop only
	// seeds local state; a successful change replaces it from the response.
	let current = $state(untrack(() => org));
	let slug = $state(untrack(() => org.slug));
	let busy = $state(false);

	const unchanged = $derived(slug.trim().toLowerCase() === current.slug);
	const locked = $derived(current.nextSlugChangeAt !== null);

	const save = async () => {
		if (unchanged || locked || busy) return;
		busy = true;
		try {
			current = await changeOrgSlug(token, slug);
			slug = current.slug;
			toasts.success(`Content now lives at ${current.contentOrigin}`);
			await invalidateAll();
		} catch (cause) {
			toasts.error(cause, 'Could not change the slug');
		} finally {
			busy = false;
		}
	};
</script>

<form
	class="mt-4 flex max-w-xl items-end gap-2"
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
	{#if current.nextSlugChangeAt}
		Changed recently; it can change again on {formatDate(
			current.nextSlugChangeAt
		)}.
	{:else}
		Once per 30 days. The old address redirects for 30 days.
	{/if}
</p>
