<script lang="ts">
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import { approveDevice, denyDevice } from '$lib/dashboard/api';
	import { getToasts } from '$lib/dashboard/toast.svelte';
	import Button from '$lib/components/ui/Button.svelte';

	let {
		token,
		code,
		expiresAt
	}: {
		token: string;
		code: string;
		expiresAt?: number;
	} = $props();

	const toasts = getToasts();
	let busy = $state(false);
	let approved = $state(false);
	let deadline = $state(Date.now() + 10 * 60 * 1_000);
	let remainingSeconds = $state(10 * 60);
	const expired = $derived(remainingSeconds <= 0);
	const remainingLabel = $derived(
		`${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, '0')}`
	);

	$effect(() => {
		code;
		deadline =
			expiresAt && Number.isFinite(expiresAt)
				? expiresAt
				: Date.now() + 10 * 60 * 1_000;
		remainingSeconds = 10 * 60;
		approved = false;
		busy = false;
	});

	$effect(() => {
		const updateRemaining = () => {
			remainingSeconds = Math.max(
				0,
				Math.ceil((deadline - Date.now()) / 1_000)
			);
		};
		updateRemaining();
		const timer = setInterval(updateRemaining, 1_000);
		return () => clearInterval(timer);
	});

	const clearCode = () => {
		const url = new URL(page.url);
		url.searchParams.delete('device');
		url.searchParams.delete('expires');
		replaceState(url, page.state);
	};

	const approve = async () => {
		if (expired) return;
		const submittedToken = token;
		const submittedCode = code;
		const isCurrent = () => token === submittedToken && code === submittedCode;
		busy = true;
		try {
			await approveDevice(submittedToken, submittedCode);
			if (!isCurrent()) return;
			approved = true;
			clearCode();
		} catch (cause) {
			if (isCurrent()) {
				toasts.error(cause, 'Could not approve the device');
			}
		} finally {
			if (isCurrent()) busy = false;
		}
	};

	const deny = async () => {
		if (expired) {
			clearCode();
			return;
		}
		const submittedToken = token;
		const submittedCode = code;
		const isCurrent = () => token === submittedToken && code === submittedCode;
		busy = true;
		try {
			await denyDevice(submittedToken, submittedCode);
			if (!isCurrent()) return;
			toasts.info('Device request denied');
			clearCode();
		} catch (cause) {
			if (isCurrent()) {
				toasts.error(cause, 'Could not deny the device');
			}
		} finally {
			if (isCurrent()) busy = false;
		}
	};
</script>

<section
	class="mb-7 flex flex-col gap-3 rounded-lg border border-accent-100 bg-accent-50/70 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
>
	<div>
		<p class="text-sm font-semibold text-accent-700">
			{approved
				? 'Device approved'
				: expired
					? 'Device request expired'
					: 'Approve CLI device'}
		</p>
		<p class="mt-1 text-sm text-zinc-600">
			{#if approved}
				Return to your terminal to continue.
			{:else if expired}
				Start device sign-in again from the CLI.
			{:else}
				Confirm code <strong class="font-mono">{code}</strong> only if it
				matches the CLI you started. Expires in {remainingLabel}.
			{/if}
		</p>
	</div>
	{#if !approved}
		<div class="flex gap-2">
			{#if expired}
				<Button variant="ghost" onclick={clearCode}>Dismiss</Button>
			{:else}
				<Button variant="ghost" disabled={busy} onclick={() => void deny()}>
					Deny
				</Button>
				<Button disabled={busy} onclick={() => void approve()}>
					{busy ? 'Working…' : 'Approve device'}
				</Button>
			{/if}
		</div>
	{/if}
</section>
