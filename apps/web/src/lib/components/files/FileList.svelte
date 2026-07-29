<script lang="ts">
	import type { DashboardFile } from '@adrive/shared';
	import { formatBytes, formatDate } from '$lib/dashboard/format';
	import FileMenu from './FileMenu.svelte';

	let {
		files,
		trashed,
		returnQuery,
		actions
	}: {
		files: ReadonlyArray<DashboardFile>;
		trashed: boolean;
		returnQuery: string;
		actions: {
			open: (file: DashboardFile) => void;
			copy: (file: DashboardFile) => string | Promise<string>;
			trash: (file: DashboardFile) => void;
			restore: (file: DashboardFile) => void;
			purge: (file: DashboardFile) => void;
		};
	} = $props();
</script>

<div class="overflow-x-auto py-4">
	<table class="w-full min-w-[42rem] text-left text-sm">
		<thead class="text-xs font-medium text-zinc-400">
			<tr>
				<th class="pb-2 font-medium">Name</th>
				<th class="pb-2 font-medium">Tags</th>
				<th class="pb-2 font-medium">Size</th>
				<th class="pb-2 font-medium">Modified</th>
				<th class="pb-2 font-medium">Access</th>
				<th class="pb-2"><span class="sr-only">Actions</span></th>
			</tr>
		</thead>
		<tbody class="divide-y divide-zinc-100">
			{#each files as file (file.id)}
				<tr>
					<td class="py-3 pr-4">
						<a
							href={`/files/${file.id}${returnQuery ? `?from=${encodeURIComponent(returnQuery)}` : ''}`}
							class="font-medium text-zinc-900 hover:text-accent-700"
							>{file.displayName}</a
						>
					</td>
					<td class="py-3 pr-4 text-xs text-zinc-500">
						{file.tags.map((tag) => tag.name).join(', ') || '—'}
					</td>
					<td class="py-3 pr-4 text-zinc-500">{formatBytes(file.sizeBytes)}</td>
					<td class="py-3 pr-4 text-zinc-500">
						{formatDate(file.updatedAt)}
					</td>
					<td class="py-3 pr-4 text-zinc-500">
						{file.public ? 'Public' : 'Private'}
					</td>
					<td class="py-3 text-right">
						<FileMenu
							{file}
							{trashed}
							onopen={() => actions.open(file)}
							oncopy={() => actions.copy(file)}
							ontrash={() => actions.trash(file)}
							onrestore={() => actions.restore(file)}
							onpurge={() => actions.purge(file)}
						/>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>
