<script lang="ts">
	import Modal from './Modal.svelte';
	import Button from './Button.svelte';

	let {
		open = $bindable(false),
		title,
		message,
		confirmLabel = 'Confirm',
		busy = false,
		onconfirm
	}: {
		open?: boolean;
		title: string;
		message: string;
		confirmLabel?: string;
		busy?: boolean;
		onconfirm: () => void | Promise<void>;
	} = $props();
</script>

<Modal bind:open {title} width="max-w-md">
	<p class="text-sm leading-6 text-zinc-600">{message}</p>
	<div class="mt-5 flex justify-end gap-2">
		<Button variant="secondary" onclick={() => (open = false)}>Cancel</Button>
		<Button variant="danger" disabled={busy} onclick={() => void onconfirm()}>
			{confirmLabel}
		</Button>
	</div>
</Modal>
