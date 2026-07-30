<script lang="ts">
	import type { ApiKey } from '@adrive/shared';
	import { createApiKey, listApiKeys, revokeApiKey } from '$lib/dashboard/api';
	import { formatDate } from '$lib/dashboard/format';
	import { getToasts } from '$lib/dashboard/toast.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Confirm from '$lib/components/ui/Confirm.svelte';
	import CopyButton from '$lib/components/ui/CopyButton.svelte';
	import { resource } from 'runed';

	let { token }: { token: string } = $props();
	const toasts = getToasts();
	const keys = resource(
		() => token,
		async (value, _previous, { signal }) => {
			const result = await listApiKeys(value, signal);
			signal.throwIfAborted();
			return result;
		}
	);
	let name = $state('');
	let created = $state('');
	let revoking = $state<ApiKey>();
	let revokeOpen = $state(false);
	let busy = $state(false);

	const create = async () => {
		if (!name.trim() || busy) return;
		busy = true;
		try {
			const result = await createApiKey(token, name);
			created = result.token;
			name = '';
			keys.mutate([result.key, ...(keys.current ?? [])]);
			void keys.refetch();
		} catch (cause) {
			toasts.error(cause, 'Could not create the API key');
		} finally {
			busy = false;
		}
	};

	const revoke = async () => {
		const target = revoking;
		if (!target || busy) return;
		busy = true;
		try {
			await revokeApiKey(token, target.id);
			keys.mutate(
				(keys.current ?? []).map((key) =>
					key.id === target.id
						? { ...key, revokedAt: new Date().toISOString() }
						: key
				)
			);
			toasts.success('API key revoked');
			revokeOpen = false;
			revoking = undefined;
		} catch (cause) {
			toasts.error(cause, 'Could not revoke the API key');
		} finally {
			busy = false;
		}
	};

	const openRevoke = (key: ApiKey) => {
		revoking = key;
		revokeOpen = true;
	};
</script>

<section>
	<h2 class="text-lg font-semibold text-zinc-950">API keys</h2>
	<p class="mt-1 text-sm text-zinc-500">
		API keys have full access to this drive. Store them like passwords.
	</p>
	<form
		class="mt-5 flex max-w-xl gap-2"
		onsubmit={(event) => {
			event.preventDefault();
			void create();
		}}
	>
		<input
			bind:value={name}
			placeholder="Key name, e.g. backup agent"
			class="min-w-0 flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm"
		/>
		<Button type="submit" disabled={!name.trim() || busy}>Create key</Button>
	</form>

	{#if created}
		<div class="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
			<p class="text-xs font-semibold text-amber-900">
				Copy this key now. It will not be shown again.
			</p>
			<code class="mt-2 block break-all text-xs text-amber-950">{created}</code>
			<CopyButton
				variant="secondary"
				class="mt-3"
				label="Copy key"
				resolve={() => created}
			/>
		</div>
	{/if}

	{#if keys.error}
		<div
			class="mt-5 flex max-w-xl items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2"
			role="alert"
		>
			<p class="text-sm text-red-700">{keys.error.message}</p>
			<Button variant="secondary" onclick={() => void keys.refetch()}>
				Try again
			</Button>
		</div>
	{/if}

	{#if keys.loading && keys.current === undefined}
		<p class="mt-6 text-sm text-zinc-500">Loading API keys…</p>
	{:else if keys.current?.length}
		<ul class="mt-6 divide-y divide-zinc-100 border-t border-zinc-100">
			{#each keys.current as key (key.id)}
				<li class="flex items-center justify-between gap-3 py-3">
					<div class="min-w-0">
						<p class="truncate text-sm font-medium text-zinc-800">{key.name}</p>
						<p class="mt-0.5 text-xs text-zinc-400">
							adr_{key.prefix}_… · created {formatDate(key.createdAt)}
							{key.revokedAt ? ' · revoked' : ''}
						</p>
					</div>
					{#if !key.revokedAt}
						<Button
							variant="danger"
							disabled={busy}
							onclick={() => openRevoke(key)}
						>
							Revoke
						</Button>
					{/if}
				</li>
			{/each}
		</ul>
	{:else if !keys.error}
		<p class="mt-6 text-sm text-zinc-500">No API keys yet.</p>
	{/if}
</section>

<Confirm
	bind:open={revokeOpen}
	title="Revoke API key?"
	message={`${revoking?.name ?? 'This key'} will stop working immediately.`}
	confirmLabel="Revoke key"
	{busy}
	onconfirm={revoke}
/>
