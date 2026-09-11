<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { deviceApprovalParams } from '$lib/device-approval';

	const signInQuery = $derived(
		deviceApprovalParams(page.url.searchParams).toString()
	);
</script>

<section class="mx-auto max-w-md py-10 sm:py-16">
	<h1 class="text-2xl font-semibold tracking-tight text-zinc-950">
		Sign in to your drive
	</h1>
	<a
		href={`${resolve('/auth/sign-in')}${signInQuery ? `?${signInQuery}` : ''}`}
		data-sveltekit-reload
		class="mt-6 inline-flex w-full items-center justify-center rounded-md bg-zinc-950 px-3 py-2 text-sm font-medium text-white transition hover:bg-zinc-800"
	>
		Sign in
	</a>
</section>
