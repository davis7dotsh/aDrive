<script lang="ts">
	import type { ApiKey, Tag } from '@adrive/shared';
	import { createApiKey, listApiKeys, revokeApiKey } from '$lib/dashboard/api';
	import { formatDate } from '$lib/dashboard/format';
	import { getToasts } from '$lib/dashboard/toast.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Confirm from '$lib/components/ui/Confirm.svelte';
	import CopyButton from '$lib/components/ui/CopyButton.svelte';
	import { resource } from 'runed';

	let { token, tags = [] }: { token: string; tags?: ReadonlyArray<Tag> } =
		$props();
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
	let scope = $state<'read-only' | 'read-write'>('read-write');
	let expiry = $state<'never' | '1' | '7' | '30'>('never');
	let selectedTags = $state<ReadonlyArray<string>>([]);
	let fileIdsInput = $state('');
	let created = $state('');
	let revoking = $state<ApiKey>();
	let revokeOpen = $state(false);
	let busy = $state(false);

	const tagById = $derived(new Map(tags.map((tag) => [tag.id, tag.name])));

	const toggleTag = (id: string) => {
		selectedTags = selectedTags.includes(id)
			? selectedTags.filter((value) => value !== id)
			: [...selectedTags, id];
	};

	const expiresAtIso = () => {
		if (expiry === 'never') return null;
		const days = Number(expiry);
		return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
	};

	const parseFileIds = () =>
		fileIdsInput
			.split(/[\s,]+/)
			.map((value) => value.trim())
			.filter((value) => value !== '');

	const create = async () => {
		if (!name.trim() || busy) return;
		busy = true;
		try {
			const fileIds = parseFileIds();
			const result = await createApiKey(token, name, scope, {
				expiresAt: expiresAtIso(),
				allowedTagIds: selectedTags.length > 0 ? selectedTags : null,
				allowedFileIds: fileIds.length > 0 ? fileIds : null
			});
			created = result.token;
			name = '';
			expiry = 'never';
			selectedTags = [];
			fileIdsInput = '';
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

	const scopeSummary = (key: ApiKey) => {
		const parts: string[] = [];
		if (key.allowedTagIds) {
			const names = key.allowedTagIds.map((id) => tagById.get(id) ?? id);
			parts.push(`tags: ${names.join(', ')}`);
		}
		if (key.allowedFileIds) {
			parts.push(`${key.allowedFileIds.length} file id(s)`);
		}
		return parts.length > 0 ? `scoped to ${parts.join(' · ')}` : null;
	};
</script>

<section>
	<h2 class="text-lg font-semibold text-zinc-950">API keys</h2>
	<p class="mt-1 text-sm text-zinc-500">
		Read/write keys have full access to this drive; read-only keys can list and
		download but not change anything. Scope a token to specific tags or file IDs
		to hand out narrow, revocable access. Store them like passwords.
	</p>
	<form
		class="mt-5 space-y-3"
		onsubmit={(event) => {
			event.preventDefault();
			void create();
		}}
	>
		<div class="flex max-w-xl flex-wrap gap-2">
			<input
				bind:value={name}
				placeholder="Key name, e.g. backup agent"
				class="min-w-0 flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm"
			/>
			<select
				bind:value={scope}
				aria-label="Key scope"
				class="rounded-md border border-zinc-300 px-2 py-2 text-sm"
			>
				<option value="read-write">Read/write</option>
				<option value="read-only">Read-only</option>
			</select>
			<select
				bind:value={expiry}
				aria-label="Key expiry"
				class="rounded-md border border-zinc-300 px-2 py-2 text-sm"
			>
				<option value="never">No expiry</option>
				<option value="1">Expires in 1 day</option>
				<option value="7">Expires in 7 days</option>
				<option value="30">Expires in 30 days</option>
			</select>
			<Button type="submit" disabled={!name.trim() || busy}>Create key</Button>
		</div>
		<details class="max-w-xl text-sm text-zinc-600">
			<summary class="cursor-pointer text-zinc-500">Limit scope (optional)</summary>
			<div class="mt-3 space-y-3">
				{#if tags.length > 0}
					<div class="flex flex-wrap gap-2">
						{#each tags as tag (tag.id)}
							<label
								class="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 px-2 py-1 text-xs"
							>
								<input
									type="checkbox"
									checked={selectedTags.includes(tag.id)}
									onchange={() => toggleTag(tag.id)}
								/>
								{tag.name}
							</label>
						{/each}
					</div>
				{/if}
				<input
					bind:value={fileIdsInput}
					placeholder="Or paste file IDs, separated by spaces"
					class="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
				/>
				<p class="text-xs text-zinc-400">
					A scoped token only reads and edits files that carry one of the chosen
					tags or appear in the file list. Leave both empty for a full-drive key.
				</p>
			</div>
		</details>
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
							adr_{key.prefix}_… · {key.scope} · created {formatDate(
								key.createdAt
							)}
							{key.expiresAt ? ` · expires ${formatDate(key.expiresAt)}` : ''}
							{key.lastUsedAt
								? ` · last used ${formatDate(key.lastUsedAt)}`
								: ''}
							{key.revokedAt ? ' · revoked' : ''}
						</p>
						{#if scopeSummary(key)}
							<p class="mt-0.5 text-xs text-zinc-400">{scopeSummary(key)}</p>
						{/if}
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
