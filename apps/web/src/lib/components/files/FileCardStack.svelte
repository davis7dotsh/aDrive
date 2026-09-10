<script lang="ts">
	import type { DashboardFile } from '@adrive/shared';
	import { fileFamily } from '$lib/dashboard/file-family';
	import { formatBytes, formatShortDate } from '$lib/dashboard/format';
	import FileMenu from './FileMenu.svelte';
	import FileThumb from './FileThumb.svelte';

	// The "stack" card used by design variant E: the file's facts sit at
	// the top of a soft card and the preview rests below on a small pile.
	let {
		file,
		token,
		contentOrigin,
		trashed,
		returnQuery,
		onopen,
		oncopy,
		ontrash,
		onrestore,
		onpurge,
		selected = false,
		onselect
	}: {
		file: DashboardFile;
		token: string;
		contentOrigin: string;
		trashed: boolean;
		returnQuery: string;
		onopen: () => void;
		oncopy: () => string | Promise<string>;
		ontrash: () => void;
		onrestore: () => void;
		onpurge?: () => void;
		selected?: boolean;
		onselect?: (selected: boolean, shift: boolean) => void;
	} = $props();

	const detailUrl = $derived(
		`/files/${file.id}${returnQuery ? `?from=${encodeURIComponent(returnQuery)}` : ''}`
	);
	const extension = $derived(
		file.kind === 'site'
			? 'site'
			: (file.displayName.split('.').pop()?.slice(0, 4).toLowerCase() ?? 'file')
	);
	const familyLabels = {
		image: 'Image',
		site: 'Site',
		code: 'Code',
		data: 'Data',
		archive: 'Archive',
		doc: 'Document',
		text: 'Text',
		other: 'File'
	} as const;
	const family = $derived(fileFamily(file));
	const secondLine = $derived(
		trashed && file.deletedAt
			? `Deleted ${formatShortDate(file.deletedAt)}`
			: formatShortDate(file.updatedAt)
	);
</script>

<li
	class="stack-card group relative flex min-w-0 flex-col rounded-2xl bg-zinc-50 p-4 transition-colors hover:bg-zinc-100"
	data-selected={selected}
>
	<div class="flex items-center gap-3">
		<a
			href={detailUrl}
			aria-label={`Open ${file.displayName}`}
			class="hex-badge flex size-10 shrink-0 items-center justify-center font-mono text-[10px] font-semibold"
			data-family={family}
		>
			{extension}
		</a>
		<div class="min-w-0 flex-1">
			<a
				href={detailUrl}
				class="file-name block truncate text-sm font-semibold text-zinc-950"
			>
				{file.displayName}
			</a>
			<p
				class="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-xs text-zinc-500"
			>
				<span
					class="vis-dot size-1.5 shrink-0 rounded-full"
					data-public={file.public}
				></span>
				<span class="truncate">
					{file.public ? 'Public' : 'Private'}
					{#if file.tags.length > 0}
						· {file.tags
							.slice(0, 2)
							.map((tag) => tag.name)
							.join(', ')}
					{:else}
						· {familyLabels[family]}
					{/if}
				</span>
				{#if file.indexState === 'failed'}
					<span
						class="shrink-0 text-amber-700"
						title={file.indexError ?? 'Search indexing failed'}
						>· Indexing failed</span
					>
				{/if}
			</p>
		</div>
		{#if onselect}
			<input
				type="checkbox"
				checked={selected}
				aria-label={`Select ${file.displayName}`}
				class="stack-select size-4 shrink-0 rounded border-zinc-300"
				onclick={(event) => {
					event.stopPropagation();
					onselect(event.currentTarget.checked, event.shiftKey);
				}}
			/>
		{/if}
		<div class="-mr-2 shrink-0">
			<FileMenu
				{file}
				{trashed}
				{onopen}
				{oncopy}
				{ontrash}
				{onrestore}
				{onpurge}
			/>
		</div>
	</div>

	<div class="my-3.5 h-px bg-zinc-200"></div>

	<div class="flex items-baseline justify-between gap-3 text-sm">
		<span class="file-meta truncate text-zinc-900"
			>{formatBytes(file.sizeBytes)}</span
		>
		<span class="file-meta shrink-0 text-zinc-400">{secondLine}</span>
	</div>

	<a
		href={detailUrl}
		tabindex="-1"
		aria-hidden="true"
		class="stack relative mt-4 block pb-3"
	>
		<FileThumb
			{file}
			{token}
			{contentOrigin}
			unavailable={trashed ||
				file.deletedAt !== null ||
				file.expiresAt !== null}
		/>
	</a>
</li>
