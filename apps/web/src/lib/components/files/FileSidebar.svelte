<script lang="ts">
	import type { DashboardFile, FileVersion, Tag } from '@adrive/shared';
	import Button from '$lib/components/ui/Button.svelte';
	import CopyButton from '$lib/components/ui/CopyButton.svelte';
	import ExpirySelect from '$lib/components/ui/ExpirySelect.svelte';
	import TagPicker from '$lib/components/tags/TagPicker.svelte';
	import FileMeta from './FileMeta.svelte';
	import VersionList from './VersionList.svelte';

	let {
		file,
		versions,
		availableTags,
		busy,
		oncopy,
		ondownload,
		onvisibility,
		onexpiration,
		ontag,
		oncreatetag,
		onversion,
		oncopyversion,
		onopenversion,
		onrestoreversion,
		onreindex,
		ontrash,
		onrestore
	}: {
		file: DashboardFile;
		versions: ReadonlyArray<FileVersion>;
		availableTags: ReadonlyArray<Tag>;
		busy: boolean;
		oncopy: () => string | Promise<string>;
		ondownload: () => void;
		onvisibility: (value: boolean) => void;
		onexpiration: (
			value: string | null
		) => void | boolean | Promise<void | boolean>;
		ontag: (tag: Tag) => void;
		oncreatetag: (name: string) => void | Promise<void>;
		onversion: (file: File) => void;
		oncopyversion: (version: number) => string | Promise<string>;
		onopenversion: (version: number) => void;
		onrestoreversion: (version: number) => void;
		onreindex: () => void;
		ontrash: () => void;
		onrestore: () => void;
	} = $props();
</script>

<aside class="space-y-6">
	<section class="rounded-xl border border-zinc-200 p-4">
		<h2 class="text-sm font-semibold text-zinc-900">Share</h2>
		<div class="mt-3 flex gap-2">
			<CopyButton resolve={oncopy} />
			<Button variant="secondary" onclick={ondownload}>
				{file.public ? 'Open' : 'Download'}
			</Button>
		</div>
		<div class="mt-4 grid grid-cols-2 gap-2">
			<button
				type="button"
				disabled={busy}
				aria-pressed={file.public}
				class="rounded-lg border p-2 text-left text-xs {file.public
					? 'border-accent-500 bg-accent-50 text-accent-800'
					: 'border-zinc-200 text-zinc-500'}"
				onclick={() => onvisibility(true)}
				>Public<br />Anyone with the link</button
			>
			<button
				type="button"
				disabled={busy || file.htmlForcedPublic || file.kind === 'site'}
				aria-pressed={!file.public}
				class="rounded-lg border p-2 text-left text-xs disabled:opacity-40 {!file.public
					? 'border-accent-500 bg-accent-50 text-accent-800'
					: 'border-zinc-200 text-zinc-500'}"
				onclick={() => onvisibility(false)}
			>
				Private<br />Signed temporary links
			</button>
		</div>
	</section>

	<section class="rounded-xl border border-zinc-200 p-4">
		<h2 class="text-sm font-semibold text-zinc-900">Details</h2>
		<div class="mt-3"><FileMeta {file} /></div>
		{#if file.indexState === 'failed'}
			<p class="mt-3 rounded-md bg-amber-50 p-2 text-xs text-amber-800">
				Indexing failed: {file.indexError ?? 'Unknown indexing error'}
			</p>
		{/if}
		<Button
			variant="ghost"
			class="mt-2 !px-0 text-xs"
			disabled={busy}
			onclick={onreindex}>Reindex search</Button
		>
	</section>

	<section class="rounded-xl border border-zinc-200 p-4">
		<h2 class="text-sm font-semibold text-zinc-900">Tags</h2>
		<div class="mt-3">
			<TagPicker
				tags={availableTags}
				selected={file.tags}
				{busy}
				ontoggle={ontag}
				oncreate={oncreatetag}
			/>
		</div>
	</section>

	<section class="rounded-xl border border-zinc-200 p-4">
		<ExpirySelect
			identity={file.id}
			value={file.expiresAt ?? ''}
			disabled={busy}
			onchange={(next) => onexpiration(next || null)}
		/>
	</section>

	<section class="rounded-xl border border-zinc-200 p-4">
		<div class="flex items-center justify-between gap-2">
			<h2 class="text-sm font-semibold text-zinc-900">Versions</h2>
			{#if file.kind === 'file'}
				<label
					class="cursor-pointer rounded-md border border-zinc-200 px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
				>
					New version
					<input
						type="file"
						class="sr-only"
						disabled={busy}
						onchange={(event) => {
							const next = event.currentTarget.files?.[0];
							if (next) onversion(next);
							event.currentTarget.value = '';
						}}
					/>
				</label>
			{/if}
		</div>
		<div class="mt-2">
			<VersionList
				{file}
				{versions}
				oncopy={oncopyversion}
				onopen={onopenversion}
				onrestore={onrestoreversion}
			/>
		</div>
	</section>

	<section class="rounded-xl border border-red-100 p-4">
		<h2 class="text-sm font-semibold text-red-800">
			{file.deletedAt ? 'In trash' : 'Danger zone'}
		</h2>
		<p class="mt-1 text-xs leading-5 text-zinc-500">
			{file.deletedAt
				? 'Restore this file before its 30-day trash window ends.'
				: 'Move this file to trash. It can be restored for 30 days.'}
		</p>
		<Button
			variant={file.deletedAt ? 'secondary' : 'danger'}
			class="mt-3"
			disabled={busy}
			onclick={file.deletedAt ? onrestore : ontrash}
		>
			{file.deletedAt ? 'Restore file' : 'Move to trash'}
		</Button>
	</section>
</aside>
