<script lang="ts">
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import type { Snippet } from 'svelte';

	let {
		variant = 'primary',
		children,
		class: className = '',
		type = 'button',
		...attributes
	}: HTMLButtonAttributes & {
		variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
		children: Snippet;
	} = $props();

	const styles = {
		primary: 'bg-zinc-950 text-white hover:bg-zinc-800',
		secondary: 'border border-zinc-200 bg-white text-zinc-800 hover:bg-zinc-50',
		ghost: 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-950',
		danger: 'text-red-700 hover:bg-red-50'
	};
</script>

<button
	{type}
	class="inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition disabled:pointer-events-none disabled:opacity-50 {styles[
		variant
	]} {className}"
	{...attributes}
>
	{@render children()}
</button>
