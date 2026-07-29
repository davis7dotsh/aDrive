<script lang="ts">
	import type { DashboardFile, FileVersion } from '@adrive/shared';
	import CopyButton from '$lib/components/ui/CopyButton.svelte';
	import { formatBytes, formatDate } from '$lib/dashboard/format';

	let {
		file,
		versions,
		oncopy,
		onopen
	}: {
		file: DashboardFile;
		versions: ReadonlyArray<FileVersion>;
		oncopy: (version: number) => string | Promise<string>;
		onopen: (version: number) => void;
	} = $props();
</script>

<ol class="max-h-64 divide-y divide-zinc-100 overflow-y-auto">
	{#each versions as version (version.version)}
		<li class="flex items-center justify-between gap-3 py-2.5">
			<div class="min-w-0">
				<p class="text-sm font-medium text-zinc-800">
					v{version.version}
					{#if version.version === file.version}
						<span
							class="ml-1 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500"
							>Current</span
						>
					{/if}
				</p>
				<p class="truncate text-xs text-zinc-400">
					{formatBytes(version.sizeBytes)} · {formatDate(version.createdAt)}
				</p>
			</div>
			<div class="flex shrink-0">
				<CopyButton variant="inline" resolve={() => oncopy(version.version)} />
				<button
					type="button"
					class="rounded px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100"
					onclick={() => onopen(version.version)}
				>
					{file.public ? 'Open' : 'Download'}
				</button>
			</div>
		</li>
	{/each}
</ol>
