<script lang="ts">
	import type { DashboardFile } from '@adrive/shared';
	import { formatBytes, formatDate } from '$lib/dashboard/format';

	let { file }: { file: DashboardFile } = $props();
</script>

<dl class="space-y-2 text-sm">
	<div class="flex justify-between gap-4">
		<dt class="text-zinc-400">Size</dt>
		<dd class="text-right text-zinc-700">{formatBytes(file.sizeBytes)}</dd>
	</div>
	<div class="flex justify-between gap-4">
		<dt class="text-zinc-400">Type</dt>
		<dd class="truncate text-right text-zinc-700">{file.contentType}</dd>
	</div>
	<div class="flex justify-between gap-4">
		<dt class="text-zinc-400">Modified</dt>
		<dd class="text-right text-zinc-700">{formatDate(file.updatedAt)}</dd>
	</div>
	<div class="flex justify-between gap-4">
		<dt class="text-zinc-400">Downloads</dt>
		<dd class="text-right text-zinc-700">{file.downloadCount}</dd>
	</div>
	<div class="flex justify-between gap-4">
		<dt class="text-zinc-400">Version</dt>
		<dd class="text-right text-zinc-700">v{file.version}</dd>
	</div>
	{#if file.lastDownloadAt}
		<div class="flex justify-between gap-4">
			<dt class="text-zinc-400">Last download</dt>
			<dd class="text-right text-zinc-700">
				{formatDate(file.lastDownloadAt)}
			</dd>
		</div>
	{/if}
	<div>
		<dt class="text-zinc-400">ID</dt>
		<dd class="mt-1 break-all font-mono text-xs text-zinc-500">{file.id}</dd>
	</div>
</dl>
