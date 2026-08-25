<script lang="ts">
	import type { DashboardFile } from '@adrive/shared';
	import { getContentLink, getFilePreview } from '$lib/dashboard/api';
	import {
		dashboardThumbnailUrl,
		supportsDashboardThumbnail,
		supportsRenderedDashboardThumbnail
	} from '$lib/file-thumbnail';
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
	const resizableImage = $derived(supportsDashboardThumbnail(file.contentType));
	const rendered = $derived(
		supportsRenderedDashboardThumbnail(file.kind, file.contentType)
	);
	const textLike = $derived(
		!rendered &&
			(file.contentType.startsWith('text/') ||
				/(json|javascript|typescript|xml|yaml|csv)/i.test(file.contentType))
	);
	let visible = $state(false);
	let loadedSource = $state('');
	let failedSource = $state('');
	let retryingSource = $state('');
	let retriedThumbnail = $state({ primary: '', source: '' });

	useIntersectionObserver(
		() => element,
		(entries) => {
			if (entries.some((entry) => entry.isIntersecting)) visible = true;
		},
		// Start every thumbnail ~4 rows ahead of the viewport so scrolling
		// reveals already-decoded images instead of showing a skeleton.
		{ once: true, rootMargin: '600px' }
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
				resizableImage,
				rendered,
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
				isResizableImage,
				isRendered,
				isText,
				isUnavailable,
				origin
			],
			_previous,
			{ signal }
		) => {
			if (!shouldLoad) return { source: '', text: '' };
			if (isImage || isRendered) {
				const source =
					isPublic && !isUnavailable
						? kind === 'site'
							? `${origin}/s/${id}/`
							: `${origin}/f/${id}?v=${version}`
						: (
								await getContentLink(
									auth,
									id,
									version,
									signal,
									isUnavailable,
									isResizableImage || isRendered
								)
							).url;
				signal.throwIfAborted();
				return {
					source:
						isResizableImage || isRendered
							? dashboardThumbnailUrl(source, id, version)
							: source,
					text: ''
				};
			}
			if (isText) {
				const preview = await getFilePreview(auth, id, version, signal);
				signal.throwIfAborted();
				return { source: '', text: preview.text.slice(0, 360) };
			}
			return { source: '', text: '' };
		},
		{ initialValue: { source: '', text: '' } }
	);
	const primarySource = $derived(thumbnail.current.source);
	const source = $derived(
		retriedThumbnail.primary === primarySource
			? retriedThumbnail.source
			: primarySource
	);
	const text = $derived(thumbnail.current.text);
	const handleImageError = async (failed: string) => {
		const primary = thumbnail.current.source;
		if (
			failed !== primary ||
			!file.public ||
			unavailable ||
			(!resizableImage && !rendered) ||
			retryingSource === primary ||
			retriedThumbnail.primary === primary
		) {
			failedSource = failed;
			return;
		}

		retryingSource = primary;
		try {
			const link = await getContentLink(
				token,
				file.id,
				file.version,
				undefined,
				false,
				true
			);
			if (thumbnail.current.source !== primary) return;
			retriedThumbnail = {
				primary,
				source: dashboardThumbnailUrl(link.url, file.id, file.version)
			};
		} catch {
			if (thumbnail.current.source === primary) failedSource = failed;
		} finally {
			if (retryingSource === primary) retryingSource = '';
		}
	};
	const previewLoading = $derived(
		(image || rendered || textLike) &&
			(!visible ||
				thumbnail.loading ||
				(Boolean(source) && loadedSource !== source && failedSource !== source))
	);
</script>

<div
	{@attach attachElement}
	class="relative flex aspect-[4/3] overflow-hidden rounded-xl bg-zinc-100 transition group-hover:bg-zinc-200/70"
>
	{#if source && failedSource !== source}
		<img
			src={source}
			alt=""
			width="480"
			height="360"
			loading="lazy"
			decoding="async"
			fetchpriority={visible ? 'high' : 'auto'}
			class="size-full object-cover transition-opacity duration-200 {previewLoading
				? 'opacity-0'
				: 'opacity-100'}"
			onload={() => (loadedSource = source)}
			onerror={() => void handleImageError(source)}
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
	{#if previewLoading && (image || rendered || textLike)}
		<div
			class="absolute inset-0 animate-pulse bg-zinc-100 motion-reduce:animate-none"
			aria-hidden="true"
		>
			<div class="mx-auto mt-[28%] h-8 w-8 rounded-lg bg-zinc-200/70"></div>
		</div>
	{/if}
</div>
