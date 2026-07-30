<script lang="ts">
	import FileDetailView from '$lib/components/FileDetailView.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<FileDetailView
	initialDetail={data.initialDetail}
	initialError={data.initialError}
/>
