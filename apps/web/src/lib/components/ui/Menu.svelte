<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import Icon from './Icon.svelte';

	let {
		label,
		trigger,
		children,
		align = 'end'
	}: {
		label: string;
		trigger?: Snippet;
		children: Snippet;
		align?: 'start' | 'end';
	} = $props();

	const componentId = $props.id();
	const menuId = `menu-${componentId}`;
	let open = $state(false);
	let panel = $state<HTMLElement>();
	let triggerButton = $state<HTMLButtonElement>();
	const attachPanel: Attachment<HTMLElement> = (node) => {
		panel = node;
		return () => {
			if (panel === node) panel = undefined;
		};
	};
	const attachTrigger: Attachment<HTMLButtonElement> = (node) => {
		triggerButton = node;
		return () => {
			if (triggerButton === node) triggerButton = undefined;
		};
	};

	const items = () =>
		Array.from(
			panel?.querySelectorAll<HTMLElement>(
				'[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled]), [role="menuitemcheckbox"]:not([disabled]), a[href]:not([aria-disabled="true"])'
			) ?? []
		);

	const focusAt = (index: number) => {
		const options = items();
		if (options.length === 0) return;
		options[(index + options.length) % options.length]?.focus();
	};

	const onKeydown = (event: KeyboardEvent) => {
		const target = event.target;
		const editing =
			target instanceof Element &&
			target.matches('input, textarea, select, [contenteditable="true"]');
		if (editing && event.key !== 'Escape' && event.key !== 'Tab') return;

		const options = items();
		const current = options.findIndex(
			(item) => item === document.activeElement
		);
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			focusAt(current + 1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			focusAt(current < 0 ? options.length - 1 : current - 1);
		} else if (event.key === 'Home') {
			event.preventDefault();
			focusAt(0);
		} else if (event.key === 'End') {
			event.preventDefault();
			focusAt(options.length - 1);
		} else if (event.key === 'Escape') {
			event.preventDefault();
			panel?.hidePopover();
			triggerButton?.focus();
		} else if (event.key === 'Tab') {
			panel?.hidePopover();
		}
	};
</script>

<button
	{@attach attachTrigger}
	type="button"
	popovertarget={menuId}
	aria-label={label}
	aria-haspopup="menu"
	aria-expanded={open}
	class="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-950"
>
	{#if trigger}
		{@render trigger()}
	{:else}
		<Icon name="more" />
	{/if}
</button>
<div
	{@attach attachPanel}
	id={menuId}
	popover="auto"
	role="menu"
	tabindex="-1"
	class="m-0 min-w-40 rounded-lg border border-zinc-200 bg-white p-1 text-sm shadow-xl [position-area:bottom_span-left] {align ===
	'end'
		? '[position-try-fallbacks:flip-block,flip-inline]'
		: '[position-area:bottom_span-right]'}"
	ontoggle={(event) => {
		open = event.newState === 'open';
		if (open) queueMicrotask(() => focusAt(0));
	}}
	onkeydown={onKeydown}
	onclick={(event) => {
		if (!(event.target instanceof Element)) return;
		const item = event.target.closest(
			'[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],a[href]'
		);
		if (item && !item.hasAttribute('data-keep-open')) {
			panel?.hidePopover();
		}
	}}
>
	{@render children()}
</div>
