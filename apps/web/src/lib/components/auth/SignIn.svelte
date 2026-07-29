<script lang="ts">
	import type { DashboardSession } from '$lib/dashboard/session.svelte';
	import Button from '$lib/components/ui/Button.svelte';

	let { session }: { session: DashboardSession } = $props();
	let passcode = $state('');
	let apiKey = $state('');
</script>

<section class="mx-auto max-w-md py-10 sm:py-16">
	<h1 class="text-2xl font-semibold tracking-tight text-zinc-950">
		Sign in to your drive
	</h1>
	<form
		class="mt-6"
		onsubmit={(event) => {
			event.preventDefault();
			void session.connect(passcode);
		}}
	>
		<label for="passcode" class="text-sm font-medium text-zinc-700">
			Passcode
		</label>
		<input
			id="passcode"
			type="password"
			autocomplete="current-password"
			bind:value={passcode}
			class="mt-2 w-full rounded-md border border-zinc-300 bg-white px-3 py-2.5 text-sm shadow-sm"
		/>
		{#if session.error}
			<p class="mt-2 text-sm text-red-600" role="alert">{session.error}</p>
		{/if}
		<Button
			type="submit"
			class="mt-4 w-full"
			disabled={session.connecting || !passcode.trim()}
		>
			{session.connecting ? 'Signing in…' : 'Sign in'}
		</Button>
	</form>
	<details class="mt-5 border-t border-zinc-100 pt-4">
		<summary class="cursor-pointer text-xs font-medium text-zinc-500">
			Sign in with an API key
		</summary>
		<p class="mt-2 text-xs leading-5 text-zinc-500">
			Use this on plain-HTTP origins where the secure session cookie cannot be
			set.
		</p>
		<form
			class="mt-3 flex gap-2"
			onsubmit={(event) => {
				event.preventDefault();
				void session.connectApiKey(apiKey);
			}}
		>
			<input
				type="password"
				aria-label="API key"
				autocomplete="off"
				bind:value={apiKey}
				placeholder="adr_…"
				class="min-w-0 flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm"
			/>
			<Button
				variant="secondary"
				type="submit"
				disabled={session.connecting || !apiKey.trim()}>Connect</Button
			>
		</form>
	</details>
</section>
