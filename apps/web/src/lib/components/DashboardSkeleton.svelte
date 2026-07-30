<script lang="ts">
	import FileGridSkeleton from './files/FileGridSkeleton.svelte';

	let { view }: { view: 'grid' | 'list' } = $props();
</script>

<div aria-busy="true" aria-label="Loading drive">
	<p class="sr-only">Loading drive</p>
	<div class="animate-pulse motion-reduce:animate-none" aria-hidden="true">
		<header class="flex items-center justify-between gap-4">
			<div class="h-9 w-32 rounded-lg bg-zinc-100"></div>
			<div class="h-9 w-24 rounded-md bg-zinc-100"></div>
		</header>

		<section class="mt-7">
			<div class="flex flex-wrap items-center gap-2">
				<div class="h-10 min-w-[16rem] flex-1 rounded-lg bg-zinc-100"></div>
				<div class="h-9 w-20 rounded-md bg-zinc-100"></div>
				<div class="h-9 w-24 rounded-md bg-zinc-100"></div>
			</div>
			<div class="mt-5 flex items-center gap-2">
				<div class="h-7 w-20 rounded-full bg-zinc-100"></div>
				<div class="h-7 w-24 rounded-full bg-zinc-100"></div>
				<div class="h-7 w-16 rounded-full bg-zinc-100"></div>
				<div class="ml-auto h-8 w-20 rounded-md bg-zinc-100"></div>
			</div>
		</section>

		<section class="mt-8">
			<div
				class="flex items-center justify-between border-b border-zinc-200 pb-3"
			>
				<div class="h-3 w-20 rounded bg-zinc-100"></div>
				<div class="h-3 w-14 rounded bg-zinc-100"></div>
			</div>
			<FileGridSkeleton {view} />
		</section>
	</div>
</div>
