<script lang="ts">
	import Dashboard from '$lib/components/Dashboard.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Files · adrive</title>
</svelte:head>

<Dashboard initialList={data.initialList} initialError={data.initialError} />
