<script lang="ts">
	import type { DashboardFile } from '@adrive/shared';
	import { getContentLink, getFilePreview } from '$lib/dashboard/api';
	import Icon from '$lib/components/ui/Icon.svelte';
	import { resource, useIntersectionObserver } from 'runed';
	import type { Attachment } from 'svelte/attachments';

	let {
		file,
		token,
		contentOrigin,
		unavailable = false
	}: {
		file: DashboardFile;
		token: string;
		contentOrigin: string;
		unavailable?: boolean;
	} = $props();

	let element = $state<HTMLElement>();
	const attachElement: Attachment<HTMLElement> = (node) => {
		element = node;
		return () => {
			if (element === node) element = undefined;
		};
	};
	const image = $derived(file.contentType.startsWith('image/'));
	const frame = $derived(
		file.kind === 'site' || file.contentType.startsWith('text/html')
	);
	const textLike = $derived(
		!frame &&
			(file.contentType.startsWith('text/') ||
				/(json|javascript|typescript|xml|yaml|csv)/i.test(file.contentType))
	);
	let visible = $state(false);
	let loadedSource = $state('');
	let failedSource = $state('');

	useIntersectionObserver(
		() => element,
		(entries) => {
			if (entries.some((entry) => entry.isIntersecting)) visible = true;
		},
		{ once: true, rootMargin: '160px' }
	);

	const thumbnail = resource(
		() =>
			[
				visible,
				token,
				file.id,
				file.version,
				file.kind,
				file.public,
				image,
				frame,
				textLike,
				unavailable,
				contentOrigin
			] as const,
		async (
			[
				shouldLoad,
				auth,
				id,
				version,
				kind,
				isPublic,
				isImage,
				isFrame,
				isText,
				isUnavailable,
				origin
			],
			_previous,
			{ signal }
		) => {
			if (!shouldLoad) return { source: '', text: '' };
			if (isImage) {
				const source =
					isPublic && !isUnavailable
						? `${origin}/f/${id}?v=${version}`
						: (await getContentLink(auth, id, version, signal, isUnavailable))
								.url;
				signal.throwIfAborted();
				return { source, text: '' };
			}
			if (isFrame) {
				if (kind === 'site') {
					const source =
						isPublic && !isUnavailable
							? `${origin}/s/${id}/`
							: (await getContentLink(auth, id, version, signal, isUnavailable))
									.url;
					signal.throwIfAborted();
					return { source, text: '' };
				}
				const url = new URL(
					isPublic && !isUnavailable
						? `${origin}/f/${id}?v=${version}`
						: (await getContentLink(auth, id, version, signal, isUnavailable))
								.url
				);
				signal.throwIfAborted();
				url.searchParams.set('preview', 'dashboard');
				return { source: url.href, text: '' };
			}
			if (isText) {
				const preview = await getFilePreview(auth, id, signal);
				signal.throwIfAborted();
				return { source: '', text: preview.text.slice(0, 360) };
			}
			return { source: '', text: '' };
		},
		{ initialValue: { source: '', text: '' } }
	);
	const source = $derived(thumbnail.current.source);
	const text = $derived(thumbnail.current.text);
	const previewLoading = $derived(
		(image || frame || textLike) &&
			(!visible ||
				thumbnail.loading ||
				(Boolean(source) && loadedSource !== source && failedSource !== source))
	);
</script>

<div
	{@attach attachElement}
	class="relative flex aspect-[4/3] overflow-hidden rounded-xl bg-zinc-100 transition group-hover:bg-zinc-200/70"
>
	{#if frame && source && failedSource !== source}
		<!-- A scaled-down live render: pointer-events stay on the card link. -->
		<div class="pointer-events-none absolute inset-0" aria-hidden="true">
			<iframe
				src={source}
				title={file.displayName}
				tabindex="-1"
				loading="lazy"
				sandbox="allow-scripts"
				class="h-[400%] w-[400%] origin-top-left scale-[0.25] border-0 bg-white transition-opacity duration-200 {previewLoading
					? 'opacity-0'
					: 'opacity-100'}"
				onload={() => (loadedSource = source)}
			></iframe>
		</div>
	{:else if source && failedSource !== source}
		<img
			src={source}
			alt=""
			loading="lazy"
			class="size-full object-cover transition-opacity duration-200 {previewLoading
				? 'opacity-0'
				: 'opacity-100'}"
			onload={() => (loadedSource = source)}
			onerror={() => {
				failedSource = source;
			}}
		/>
	{:else if text}
		<pre
			class="line-clamp-6 size-full overflow-hidden whitespace-pre-wrap p-3 text-[10px] leading-4 text-zinc-500 transition-opacity duration-200">{text}</pre>
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
	{#if previewLoading && (image || textLike)}
		<div
			class="absolute inset-0 animate-pulse bg-zinc-100 motion-reduce:animate-none"
			aria-hidden="true"
		>
			<div class="mx-auto mt-[28%] h-8 w-8 rounded-lg bg-zinc-200/70"></div>
		</div>
	{/if}
</div>
