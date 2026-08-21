<script lang="ts">
	import FileDetailView from '$lib/components/FileDetailView.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const contentOrigin = data.initialDetail?.contentOrigin ?? '';
</script>

<svelte:head>
	{#if contentOrigin}
		<!-- The preview image/media streams from the content origin; open the
		     connection while the page renders instead of after. -->
		<link rel="preconnect" href={contentOrigin} />
		<link rel="dns-prefetch" href={contentOrigin} />
	{/if}
</svelte:head>

<FileDetailView
	initialDetail={data.initialDetail}
	initialError={data.initialError}
/>
