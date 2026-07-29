<script lang="ts">
	import { fly } from 'svelte/transition';
	import { formatBytes } from '$lib/dashboard/format';
	import type { UploadManager } from '$lib/dashboard/uploads.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';

	let { uploads }: { uploads: UploadManager } = $props();
</script>

{#if uploads.items.length > 0}
	<section
		transition:fly={{ y: 16, duration: 200 }}
		class="fixed right-4 bottom-4 z-40 w-[min(26rem,calc(100%-2rem))] rounded-xl border border-zinc-200 bg-white p-3 shadow-xl"
		aria-label="Uploads"
	>
		<header class="mb-2 flex items-center justify-between">
			<p class="text-sm font-semibold text-zinc-900">
				Uploads{uploads.pending ? ` · ${uploads.pending} remaining` : ''}
			</p>
			{#if uploads.pending === 0}
				<button
					type="button"
					class="rounded p-1 text-zinc-400 hover:bg-zinc-100"
					aria-label="Dismiss completed uploads"
					onclick={() => uploads.removeDone()}
				>
					<Icon name="close" />
				</button>
			{/if}
		</header>
		<ul class="max-h-64 space-y-2 overflow-y-auto">
			{#each uploads.items as item (item.id)}
				<li
					transition:fly={{ y: 8, duration: 150 }}
					class="rounded-lg bg-zinc-50 p-2.5"
				>
					<div class="flex items-start gap-2">
						<div class="min-w-0 flex-1">
							<p class="truncate text-xs font-medium text-zinc-800">
								{item.file.name}
							</p>
							<p class="mt-0.5 text-[11px] text-zinc-400">
								{item.status === 'done'
									? item.forcedPublic
										? 'Uploaded · HTML made public'
										: 'Uploaded'
									: item.status === 'error'
										? item.error
										: item.status === 'cancelled'
											? 'Cancelled'
											: `${formatBytes(item.uploaded)} of ${formatBytes(item.total)}`}
							</p>
						</div>
						{#if item.status === 'uploading' || item.status === 'queued'}
							<button
								type="button"
								class="text-xs font-medium text-zinc-500 hover:text-zinc-900"
								onclick={() => uploads.cancel(item.id)}>Cancel</button
							>
						{:else if item.status === 'error'}
							<Button
								variant="ghost"
								class="!px-2 !py-1 text-xs"
								onclick={() => uploads.retry(item.id)}>Retry</Button
							>
						{/if}
					</div>
					{#if item.status === 'uploading' || item.status === 'queued'}
						<div class="mt-2 h-1 overflow-hidden rounded-full bg-zinc-200">
							<div
								class="h-full rounded-full bg-accent-600 transition-[width]"
								style:width={`${item.total > 0 ? Math.round((item.uploaded / item.total) * 100) : 0}%`}
							></div>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	</section>
{/if}
