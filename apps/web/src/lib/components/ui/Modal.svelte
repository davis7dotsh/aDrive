<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import Icon from './Icon.svelte';

	let {
		open = $bindable(false),
		title,
		description,
		children,
		width = 'max-w-xl'
	}: {
		open?: boolean;
		title: string;
		description?: string;
		children: Snippet;
		width?: string;
	} = $props();

	const componentId = $props.id();
	const titleId = `modal-title-${componentId}`;
	const descriptionId = `modal-description-${componentId}`;
	let returnFocus: HTMLElement | null = null;

	const modal: Attachment<HTMLDialogElement> = (node) => {
		if (open && !node.open) {
			returnFocus =
				document.activeElement instanceof HTMLElement
					? document.activeElement
					: null;
			node.showModal();
			queueMicrotask(() => {
				const target = node.querySelector<HTMLElement>('[data-autofocus]');
				target?.focus();
			});
		} else if (!open && node.open) {
			node.close();
		}
	};

	const close = () => {
		open = false;
		queueMicrotask(() => returnFocus?.focus());
	};
</script>

<dialog
	{@attach modal}
	class="m-auto w-[calc(100%-2rem)] {width} rounded-xl bg-white p-0 text-zinc-950 shadow-2xl backdrop:bg-zinc-950/35"
	aria-labelledby={titleId}
	aria-describedby={description ? descriptionId : undefined}
	onclose={close}
	oncancel={() => (open = false)}
	onclick={(event) => {
		if (event.target === event.currentTarget) close();
	}}
>
	<div class="@container p-5 sm:p-6">
		<header class="flex items-start justify-between gap-4">
			<div>
				<h2 id={titleId} class="text-lg font-semibold tracking-tight">
					{title}
				</h2>
				{#if description}
					<p id={descriptionId} class="mt-1 text-sm text-zinc-500">
						{description}
					</p>
				{/if}
			</div>
			<button
				type="button"
				class="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800"
				aria-label={`Close ${title}`}
				onclick={close}
			>
				<Icon name="close" class="size-5" />
			</button>
		</header>
		<div class="mt-5">
			{@render children()}
		</div>
	</div>
</dialog>
