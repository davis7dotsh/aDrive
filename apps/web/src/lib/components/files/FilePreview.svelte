<script lang="ts">
	import type { DashboardFile } from '@adrive/shared';
	import { getContentLink, getFilePreview } from '$lib/dashboard/api';
	import { formatBytes } from '$lib/dashboard/format';
	import { renderMarkdown } from '$lib/dashboard/markdown';
	import Button from '$lib/components/ui/Button.svelte';
	import Icon from '$lib/components/ui/Icon.svelte';
	import { resource } from 'runed';
	import type { Attachment } from 'svelte/attachments';

	let {
		file,
		token,
		contentOrigin,
		ondownload
	}: {
		file: DashboardFile;
		token: string;
		contentOrigin: string;
		ondownload: () => void;
	} = $props();

	const textLike = $derived(
		file.contentType.startsWith('text/') ||
			/(json|javascript|typescript|xml|yaml|csv)/i.test(file.contentType)
	);
	const media = $derived(
		file.kind === 'site' ||
			file.contentType.startsWith('image/') ||
			file.contentType.startsWith('video/') ||
			file.contentType.startsWith('audio/') ||
			file.contentType === 'application/pdf'
	);
	const preview = resource(
		() => [token, file.id, file.version, textLike] as const,
		([auth, id, _version, shouldLoad], _previous, { signal }) =>
			shouldLoad
				? getFilePreview(auth, id, signal)
				: Promise.resolve({ kind: '', text: '' })
	);
	const link = resource(
		() => [token, file.id, file.version, file.public, media] as const,
		async ([auth, id, _version, isPublic, shouldLoad]) => {
			if (!shouldLoad) return '';
			if (isPublic) {
				return file.kind === 'site'
					? `${contentOrigin}/s/${id}/`
					: `${contentOrigin}/f/${id}`;
			}
			return (await getContentLink(auth, id)).url;
		}
	);
	const markdown = $derived(
		preview.current?.kind === 'markdown'
			? renderMarkdown(preview.current.text)
			: ''
	);
	const renderMarkdownPreview: Attachment<HTMLElement> = (node) => {
		node.innerHTML = markdown;
	};
</script>

<section
	class="min-h-[28rem] overflow-hidden rounded-xl border border-zinc-200 bg-white"
	aria-label="File preview"
>
	{#if file.deletedAt}
		<div
			class="border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
		>
			This file is in trash. Its metadata remains available until purge.
		</div>
	{/if}
	{#if preview.loading || link.loading}
		<div class="animate-pulse space-y-4 p-8">
			<div class="h-8 w-2/3 rounded bg-zinc-100"></div>
			<div class="h-4 w-full rounded bg-zinc-100"></div>
			<div class="h-4 w-5/6 rounded bg-zinc-100"></div>
		</div>
	{:else if preview.current?.kind === 'markdown'}
		<article
			{@attach renderMarkdownPreview}
			class="markdown-preview p-6 sm:p-10"
		></article>
	{:else if preview.current?.kind === 'text'}
		<pre
			class="overflow-x-auto whitespace-pre-wrap p-6 font-mono text-sm leading-7 text-zinc-800 sm:p-10">{preview
				.current.text}</pre>
	{:else if file.contentType.startsWith('image/') && link.current}
		<div class="flex min-h-[28rem] items-center justify-center bg-zinc-50 p-4">
			<img
				src={link.current}
				alt={file.displayName}
				class="max-h-[70vh] max-w-full object-contain"
			/>
		</div>
	{:else if file.contentType.startsWith('video/') && link.current}
		<video controls src={link.current} class="max-h-[70vh] w-full bg-black">
			<track kind="captions" />
		</video>
	{:else if file.contentType.startsWith('audio/') && link.current}
		<div class="flex min-h-[28rem] items-center justify-center p-8">
			<audio controls src={link.current} class="w-full"></audio>
		</div>
	{:else if (file.contentType === 'application/pdf' || file.kind === 'site') && link.current}
		<iframe
			src={link.current}
			title={`Preview of ${file.displayName}`}
			class="h-[70vh] w-full border-0"
		></iframe>
	{:else}
		<div
			class="flex min-h-[28rem] flex-col items-center justify-center p-8 text-center"
		>
			<Icon name="file" class="size-14 text-zinc-300" />
			<p class="mt-4 text-sm font-medium text-zinc-700">{file.displayName}</p>
			<p class="mt-1 text-xs text-zinc-400">{formatBytes(file.sizeBytes)}</p>
			<Button class="mt-5" onclick={ondownload}>
				<Icon name="download" />
				Download
			</Button>
		</div>
	{/if}
</section>
