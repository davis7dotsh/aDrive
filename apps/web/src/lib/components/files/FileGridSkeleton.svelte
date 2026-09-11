<script lang="ts">
	import { useDesignVariant } from '$lib/dashboard/design-variant';

	let { view = 'grid' }: { view?: 'grid' | 'list' } = $props();
	const variant = useDesignVariant();
</script>

<div class="animate-pulse motion-reduce:animate-none" aria-hidden="true">
	{#if view === 'list'}
		<div class="overflow-hidden py-4">
			<div
				class="grid grid-cols-[minmax(12rem,2fr)_1fr_5rem_7rem_5rem_2rem] gap-4 border-b border-zinc-100 pb-2"
			>
				{#each Array(6) as _, index (index)}
					<div class="h-3 rounded bg-zinc-100"></div>
				{/each}
			</div>
			{#each Array(4) as _, index (index)}
				<div
					class="grid grid-cols-[minmax(12rem,2fr)_1fr_5rem_7rem_5rem_2rem] gap-4 border-b border-zinc-100 py-4"
				>
					<div class="h-3 w-2/3 rounded bg-zinc-100"></div>
					<div class="h-3 w-1/2 rounded bg-zinc-100"></div>
					<div class="h-3 rounded bg-zinc-100"></div>
					<div class="h-3 rounded bg-zinc-100"></div>
					<div class="h-3 rounded bg-zinc-100"></div>
					<div class="h-3 rounded bg-zinc-100"></div>
				</div>
			{/each}
		</div>
	{:else if variant() === 'e'}
		<ul class="file-grid grid grid-cols-2 gap-4 py-6">
			{#each Array(6) as _, index (index)}
				<li class="rounded-2xl bg-zinc-50 p-4">
					<div class="flex items-center gap-3">
						<div class="size-10 rounded-full bg-zinc-200/60"></div>
						<div class="flex-1">
							<div class="h-3 w-2/3 rounded bg-zinc-200/60"></div>
							<div class="mt-2 h-2.5 w-1/2 rounded bg-zinc-200/60"></div>
						</div>
					</div>
					<div class="my-3.5 h-px bg-zinc-200"></div>
					<div class="flex h-5 items-center justify-between">
						<div class="h-3 w-16 rounded bg-zinc-200/60"></div>
						<div class="h-3 w-12 rounded bg-zinc-200/60"></div>
					</div>
					<div class="mt-4 aspect-square rounded-xl bg-zinc-200/60"></div>
				</li>
			{/each}
		</ul>
	{:else}
		<ul
			class="grid grid-cols-2 gap-x-4 gap-y-8 py-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6"
		>
			{#each Array(6) as _, index (index)}
				<li>
					<div class="aspect-[4/3] rounded-xl bg-zinc-100"></div>
					<div class="mt-3 h-3 w-2/3 rounded bg-zinc-100"></div>
					<div class="mt-2 h-2.5 w-1/2 rounded bg-zinc-100"></div>
					<div class="mt-3 h-2.5 w-16 rounded bg-zinc-100"></div>
				</li>
			{/each}
		</ul>
	{/if}
</div>
