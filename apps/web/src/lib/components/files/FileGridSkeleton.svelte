<script lang="ts">
	let { view = 'grid' }: { view?: 'grid' | 'list' } = $props();
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
