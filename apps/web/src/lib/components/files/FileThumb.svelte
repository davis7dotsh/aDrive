<script lang="ts">
	import type { DashboardFile } from '@adrive/shared';
	import { getContentLink, getFilePreview } from '$lib/dashboard/api';
	import Icon from '$lib/components/ui/Icon.svelte';
	import { useIntersectionObserver } from 'runed';
	import type { Attachment } from 'svelte/attachments';

	let {
		file,
		token,
		contentOrigin
	}: {
		file: DashboardFile;
		token: string;
		contentOrigin: string;
	} = $props();

	let element = $state<HTMLElement>();
	const attachElement: Attachment<HTMLElement> = (node) => {
		element = node;
		return () => {
			if (element === node) element = undefined;
		};
	};
	let source = $state('');
	let text = $state('');
	const image = $derived(file.contentType.startsWith('image/'));
	const textLike = $derived(
		file.contentType.startsWith('text/') ||
			/(json|javascript|typescript|xml|yaml|csv)/i.test(file.contentType)
	);

	useIntersectionObserver(
		() => element,
		(entries) => {
			if (!entries.some((entry) => entry.isIntersecting)) return;
			if (image) {
				if (file.public) {
					source = `${contentOrigin}/f/${file.id}`;
				} else {
					void getContentLink(token, file.id)
						.then((link) => (source = link.url))
						.catch(() => undefined);
				}
			} else if (textLike) {
				void getFilePreview(token, file.id)
					.then((preview) => (text = preview.text.slice(0, 360)))
					.catch(() => undefined);
			}
		},
		{ once: true, rootMargin: '160px' }
	);
</script>

<div
	{@attach attachElement}
	class="flex aspect-[4/3] overflow-hidden rounded-xl bg-zinc-100 transition group-hover:bg-zinc-200/70"
>
	{#if source}
		<img src={source} alt="" loading="lazy" class="size-full object-cover" />
	{:else if text}
		<pre
			class="line-clamp-6 size-full overflow-hidden whitespace-pre-wrap p-3 text-[10px] leading-4 text-zinc-500">{text}</pre>
	{:else}
		<div class="m-auto text-center">
			<Icon name="file" class="mx-auto size-9 text-zinc-400" />
			<span
				class="mt-2 block text-[10px] font-semibold tracking-wider text-zinc-400"
			>
				{file.kind === 'site'
					? 'SITE'
					: (file.displayName.split('.').pop()?.slice(0, 5).toUpperCase() ??
						'FILE')}
			</span>
		</div>
	{/if}
</div>
