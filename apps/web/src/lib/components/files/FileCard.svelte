<script lang="ts">
	import type { DashboardFile } from '@adrive/shared';
	import { formatBytes, formatDate } from '$lib/dashboard/format';
	import FileMenu from './FileMenu.svelte';
	import FileThumb from './FileThumb.svelte';

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
</script>

<li class="group min-w-0">
	<a href={detailUrl} aria-label={`Open ${file.displayName}`}>
		<FileThumb
			{file}
			{token}
			{contentOrigin}
			unavailable={trashed ||
				file.deletedAt !== null ||
				file.expiresAt !== null}
		/>
	</a>
	<div class="mt-3 flex items-start gap-1">
		{#if onselect}
			<input
				type="checkbox"
				checked={selected}
				aria-label={`Select ${file.displayName}`}
				class="mt-0.5 size-4 shrink-0 rounded border-zinc-300 accent-zinc-950"
				onclick={(event) => {
					event.stopPropagation();
					onselect(event.currentTarget.checked, event.shiftKey);
				}}
			/>
		{/if}
		<div class="min-w-0 flex-1">
			<a
				href={detailUrl}
				class="block truncate text-sm font-medium text-zinc-900 hover:text-accent-600"
			>
				{file.displayName}
			</a>
			<p class="mt-0.5 truncate text-xs text-zinc-400">
				{formatBytes(file.sizeBytes)} · {trashed && file.deletedAt
					? `deleted ${formatDate(file.deletedAt)} · purges after 30 days`
					: formatDate(file.updatedAt)}
			</p>
		</div>
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
	<div class="mt-2 flex min-w-0 items-center gap-1.5">
		<span
			class="size-1.5 shrink-0 rounded-full {file.public
				? 'bg-emerald-500'
				: 'bg-zinc-400'}"
		></span>
		<span class="text-[11px] text-zinc-400">
			{file.public ? 'Public' : 'Private'}
		</span>
		{#each file.tags.slice(0, 2) as tag (tag.id)}
			<span
				class="truncate rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500"
				>{tag.name}</span
			>
		{/each}
		{#if file.indexState === 'failed'}
			<span
				class="truncate rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700"
				title={file.indexError ?? 'Search indexing failed'}
				>Indexing failed</span
			>
		{/if}
	</div>
</li>
