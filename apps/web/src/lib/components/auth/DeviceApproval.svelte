<script lang="ts">
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import { approveDevice } from '$lib/dashboard/api';
	import { getToasts } from '$lib/dashboard/toast.svelte';
	import Button from '$lib/components/ui/Button.svelte';

	let {
		token,
		code
	}: {
		token: string;
		code: string;
	} = $props();

	const toasts = getToasts();
	let busy = $state(false);
	let approved = $state(false);

	const clearCode = () => {
		const url = new URL(page.url);
		url.searchParams.delete('device');
		replaceState(url, page.state);
	};

	const approve = async () => {
		busy = true;
		try {
			await approveDevice(token, code);
			approved = true;
			clearCode();
		} catch (cause) {
			toasts.error(cause, 'Could not approve the device');
		} finally {
			busy = false;
		}
	};
</script>

<section
	class="mb-7 flex flex-col gap-3 rounded-lg border border-accent-100 bg-accent-50/70 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
>
	<div>
		<p class="text-sm font-semibold text-accent-700">
			{approved ? 'Device approved' : 'Approve CLI device'}
		</p>
		<p class="mt-1 text-sm text-zinc-600">
			{#if approved}
				Return to your terminal to continue.
			{:else}
				Confirm code <strong class="font-mono">{code}</strong> only if it matches
				the CLI you started. The request expires after 10 minutes.
			{/if}
		</p>
	</div>
	{#if !approved}
		<div class="flex gap-2">
			<Button variant="ghost" disabled={busy} onclick={clearCode}>Deny</Button>
			<Button disabled={busy} onclick={() => void approve()}>
				{busy ? 'Approving…' : 'Approve device'}
			</Button>
		</div>
	{/if}
</section>
