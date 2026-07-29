<script lang="ts">
	import { fade } from 'svelte/transition';
	import Icon from '$lib/components/ui/Icon.svelte';

	let {
		active,
		disabled = false
	}: {
		active: boolean;
		disabled?: boolean;
	} = $props();
</script>

{#if active}
	<div
		transition:fade={{ duration: 150 }}
		class="pointer-events-none fixed inset-3 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent-500 bg-accent-50/95"
		aria-hidden="true"
	>
		<div class="text-center text-accent-700">
			<Icon name="upload" class="mx-auto size-10" />
			<p class="mt-3 text-base font-medium">
				{disabled ? 'Switch to Files to upload' : 'Drop to upload'}
			</p>
		</div>
	</div>
{/if}
