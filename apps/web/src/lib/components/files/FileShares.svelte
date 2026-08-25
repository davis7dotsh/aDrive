<script lang="ts">
	import type { DashboardFile, FileShare } from '@adrive/shared';
	import { createShare, listShares, revokeShare } from '$lib/dashboard/api';
	import { formatDate } from '$lib/dashboard/format';
	import { getToasts } from '$lib/dashboard/toast.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import CopyButton from '$lib/components/ui/CopyButton.svelte';
	import { resource } from 'runed';

	let { file, token }: { file: DashboardFile; token: string } = $props();
	const toasts = getToasts();
	const shares = resource(
		() => [token, file.id] as const,
		async ([value, fileId], _previous, { signal }) => {
			const result = await listShares(value, fileId, signal);
			signal.throwIfAborted();
			return result;
		}
	);

	let password = $state('');
	let expiry = $state<'7' | '30' | '1' | 'never'>('7');
	let createdUrl = $state('');
	let busy = $state(false);

	const create = async () => {
		if (busy) return;
		busy = true;
		try {
			const result = await createShare(token, file.id, {
				password: password.trim() ? password : null,
				expiresInDays: expiry === 'never' ? null : Number(expiry)
			});
			createdUrl = result.url;
			password = '';
			shares.mutate({
				shares: [result.share, ...(shares.current?.shares ?? [])],
				contentOrigin: shares.current?.contentOrigin ?? ''
			});
			void shares.refetch();
		} catch (cause) {
			toasts.error(cause, 'Could not create the link');
		} finally {
			busy = false;
		}
	};

	const revoke = async (share: FileShare) => {
		if (busy) return;
		busy = true;
		try {
			await revokeShare(token, file.id, share.id);
			shares.mutate({
				shares: (shares.current?.shares ?? []).map((entry) =>
					entry.id === share.id
						? { ...entry, revokedAt: new Date().toISOString() }
						: entry
				),
				contentOrigin: shares.current?.contentOrigin ?? ''
			});
			toasts.success('Link revoked');
		} catch (cause) {
			toasts.error(cause, 'Could not revoke the link');
		} finally {
			busy = false;
		}
	};

	const activeShares = $derived(
		(shares.current?.shares ?? []).filter((share) => !share.revokedAt)
	);
</script>

<section class="rounded-xl border border-zinc-200 p-4">
	<h2 class="text-sm font-semibold text-zinc-900">Durable links</h2>
	<p class="mt-1 text-xs leading-5 text-zinc-500">
		A revocable link that works on your phone or for one recipient, lasting days
		instead of the 15-minute preview link.
	</p>

	<div class="mt-3 space-y-2">
		<input
			bind:value={password}
			type="password"
			placeholder="Optional password"
			autocomplete="off"
			class="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
		/>
		<div class="flex gap-2">
			<select
				bind:value={expiry}
				aria-label="Link lifetime"
				class="flex-1 rounded-md border border-zinc-300 px-2 py-2 text-sm"
			>
				<option value="7">Expires in 7 days</option>
				<option value="30">Expires in 30 days</option>
				<option value="1">Expires in 1 day</option>
				<option value="never">No expiry</option>
			</select>
			<Button disabled={busy} onclick={() => void create()}>Create link</Button>
		</div>
	</div>

	{#if createdUrl}
		<div class="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
			<p class="text-xs font-semibold text-amber-900">
				Copy this link now. The secret is shown only once.
			</p>
			<code class="mt-2 block break-all text-xs text-amber-950"
				>{createdUrl}</code
			>
			<CopyButton
				variant="secondary"
				class="mt-2"
				label="Copy link"
				resolve={() => createdUrl}
			/>
		</div>
	{/if}

	{#if shares.loading && shares.current === undefined}
		<p class="mt-3 text-xs text-zinc-500">Loading links…</p>
	{:else if activeShares.length}
		<ul class="mt-3 divide-y divide-zinc-100 border-t border-zinc-100">
			{#each activeShares as share (share.id)}
				<li class="flex items-center justify-between gap-2 py-2">
					<span class="min-w-0 text-xs text-zinc-500">
						{share.hasPassword ? 'password · ' : ''}{share.expiresAt
							? `expires ${formatDate(share.expiresAt)}`
							: 'no expiry'}
					</span>
					<button
						type="button"
						class="shrink-0 text-xs font-medium text-red-600 hover:text-red-700"
						disabled={busy}
						onclick={() => void revoke(share)}
					>
						Revoke
					</button>
				</li>
			{/each}
		</ul>
	{:else if !shares.error}
		<p class="mt-3 text-xs text-zinc-500">No durable links yet.</p>
	{/if}
</section>
