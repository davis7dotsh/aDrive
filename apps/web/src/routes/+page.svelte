<script lang="ts">
	import Dashboard from '$lib/components/Dashboard.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const preloads = data.thumbnailPreloads ?? [];
	const contentOrigin = data.initialList?.contentOrigin ?? '';
</script>

<svelte:head>
	<title>Files · adrive</title>
	{#if contentOrigin}
		<link rel="preconnect" href={contentOrigin} />
		<link rel="dns-prefetch" href={contentOrigin} />
	{/if}
	{#each preloads as href (href)}
		<!-- Preload first-viewport public thumbnails in parallel with the JS. -->
		<link rel="preload" as="image" {href} fetchpriority="high" />
	{/each}
</svelte:head>

<Dashboard initialList={data.initialList} initialError={data.initialError} />
