<script lang="ts">
	let {
		name,
		class: className = 'size-4'
	}: {
		name:
			| 'arrow-left'
			| 'check'
			| 'chevron-down'
			| 'close'
			| 'download'
			| 'file'
			| 'gear'
			| 'link'
			| 'more'
			| 'plus'
			| 'search'
			| 'trash'
			| 'upload';
		class?: string;
	} = $props();
</script>

<svg
	class={className}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.8"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
>
	{#if name === 'arrow-left'}
		<path d="m15 18-6-6 6-6" />
	{:else if name === 'check'}
		<path d="m5 12 4 4L19 6" />
	{:else if name === 'chevron-down'}
		<path d="m7 10 5 5 5-5" />
	{:else if name === 'close'}
		<path d="m6 6 12 12M18 6 6 18" />
	{:else if name === 'download'}
		<path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" />
	{:else if name === 'file'}
		<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
		<path d="M14 2v6h6" />
	{:else if name === 'gear'}
		<circle cx="12" cy="12" r="3" />
		<path
			d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"
		/>
	{:else if name === 'link'}
		<path
			d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1"
		/>
	{:else if name === 'more'}
		<circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
		<circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
		<circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
	{:else if name === 'plus'}
		<path d="M12 5v14M5 12h14" />
	{:else if name === 'search'}
		<circle cx="11" cy="11" r="7" />
		<path d="m16 16 4 4" />
	{:else if name === 'trash'}
		<path d="M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7m4 4v6m4-6v6" />
	{:else if name === 'upload'}
		<path
			d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"
		/>
	{/if}
</svg>
