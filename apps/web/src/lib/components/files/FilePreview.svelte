<script lang="ts">
	import type { DashboardFile } from '@adrive/shared';
	import { getContentLink, getFilePreview } from '$lib/dashboard/api';
	import { formatBytes } from '$lib/dashboard/format';
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

	const html = $derived(
		file.kind === 'site' || file.contentType.startsWith('text/html')
	);
	const textLike = $derived(
		!html &&
			(file.contentType.startsWith('text/') ||
				/(json|javascript|typescript|xml|yaml|csv)/i.test(file.contentType))
	);
	const media = $derived(
		html ||
			file.contentType.startsWith('image/') ||
			file.contentType.startsWith('video/') ||
			file.contentType.startsWith('audio/') ||
			file.contentType === 'application/pdf'
	);
	const preview = resource(
		() => [token, file.id, file.version, textLike] as const,
		async ([auth, id, _version, shouldLoad], _previous, { signal }) => {
			const result = shouldLoad
				? await getFilePreview(auth, id, signal)
				: { kind: '', text: '' };
			signal.throwIfAborted();
			return result;
		}
	);

	let linkUrl = $state('');
	let linkLoading = $state(false);
	let linkError = $state<Error>();
	let linkRefresh = $state(0);
	let linkGeneration = 0;
	let activeLinkKey = '';
	let expirationTick = $state(0);
	const expirationTime = $derived(
		file.expiresAt ? new Date(file.expiresAt).getTime() : Number.NaN
	);
	const expired = $derived.by(() => {
		expirationTick;
		return Number.isFinite(expirationTime) && expirationTime <= Date.now();
	});
	const unavailable = $derived(file.deletedAt !== null || expired);

	$effect(() => {
		const target = expirationTime;
		if (!Number.isFinite(target) || target <= Date.now()) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const checkExpiration = () => {
			const remaining = target - Date.now();
			if (remaining <= 0) {
				expirationTick += 1;
				return;
			}
			timer = setTimeout(
				checkExpiration,
				Math.min(remaining + 25, 2_147_000_000)
			);
		};
		checkExpiration();
		return () => {
			if (timer !== undefined) clearTimeout(timer);
		};
	});

	const linkSource = $derived.by(() => {
		const source = {
			auth: token,
			id: file.id,
			version: file.version,
			isPublic: file.public,
			unavailable,
			expiresAt: file.expiresAt,
			kind: file.kind,
			shouldLoad: media,
			origin: contentOrigin
		};
		return {
			...source,
			identityKey: [
				source.auth,
				source.id,
				source.version,
				source.isPublic,
				source.unavailable,
				source.expiresAt,
				source.kind,
				source.shouldLoad,
				source.origin
			].join('\u0000')
		};
	});

	// The signed URL is component-owned: abort it on identity changes and
	// renew it before its server-provided expiration.
	$effect(() => {
		const {
			auth,
			id,
			version,
			isPublic,
			unavailable,
			kind,
			shouldLoad,
			origin,
			identityKey
		} = linkSource;
		const refreshIteration = linkRefresh;
		const sameIdentity = activeLinkKey === identityKey;
		activeLinkKey = identityKey;
		const ownGeneration = ++linkGeneration;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;

		if (!shouldLoad) {
			linkUrl = '';
			linkLoading = false;
			linkError = undefined;
			return () => {
				if (ownGeneration === linkGeneration) linkGeneration += 1;
				controller.abort();
			};
		}

		if (!sameIdentity) linkUrl = '';
		linkLoading = true;
		linkError = undefined;

		const scheduleRefresh = (delay: number) => {
			if (timer !== undefined) clearTimeout(timer);
			timer = setTimeout(() => {
				if (
					ownGeneration === linkGeneration &&
					refreshIteration === linkRefresh
				) {
					linkRefresh += 1;
				}
			}, delay);
		};

		void (async () => {
			try {
				const result = unavailable
					? await getContentLink(auth, id, version, controller.signal, true)
					: isPublic
						? {
								url:
									kind === 'site'
										? `${origin}/s/${id}/`
										: `${origin}/f/${id}?v=${version}`,
								expiresAt: null
							}
						: await getContentLink(auth, id, version, controller.signal);
				controller.signal.throwIfAborted();
				if (
					ownGeneration !== linkGeneration ||
					refreshIteration !== linkRefresh
				) {
					return;
				}

				const resolvedUrl = new URL(result.url);
				if (
					file.kind !== 'site' &&
					(file.contentType === 'application/pdf' ||
						file.contentType.startsWith('text/html'))
				) {
					resolvedUrl.searchParams.set('preview', 'dashboard');
				}
				linkUrl = resolvedUrl.href;
				linkLoading = false;
				if (result.expiresAt) {
					const expiresAt = new Date(result.expiresAt).getTime();
					if (Number.isFinite(expiresAt)) {
						scheduleRefresh(Math.max(1_000, expiresAt - Date.now() - 60_000));
					}
				}
			} catch (cause) {
				if (
					controller.signal.aborted ||
					ownGeneration !== linkGeneration ||
					refreshIteration !== linkRefresh
				) {
					return;
				}
				linkError =
					cause instanceof Error
						? cause
						: new Error('Could not load the file preview');
				linkLoading = false;
				if (linkUrl) scheduleRefresh(30_000);
			}
		})();

		return () => {
			if (ownGeneration === linkGeneration) linkGeneration += 1;
			controller.abort();
			if (timer !== undefined) clearTimeout(timer);
		};
	});

	const retry = () => {
		if (preview.error) void preview.refetch();
		if (linkError) linkRefresh += 1;
	};
	// markdown-it is the largest client library after Svelte/runed, so it is
	// loaded on demand only when a markdown file is actually shown instead of
	// paying its download+parse cost on every file detail page.
	let renderedMarkdown = $state('');
	let markdownNode = $state<HTMLElement>();
	const attachMarkdownPreview: Attachment<HTMLElement> = (node) => {
		markdownNode = node;
		return () => {
			if (markdownNode === node) markdownNode = undefined;
		};
	};
	$effect(() => {
		const source =
			preview.current?.kind === 'markdown' ? preview.current.text : '';
		if (!source) {
			renderedMarkdown = '';
			return;
		}
		let cancelled = false;
		void import('$lib/dashboard/markdown').then(({ renderMarkdown }) => {
			if (!cancelled) renderedMarkdown = renderMarkdown(source);
		});
		return () => {
			cancelled = true;
		};
	});
	$effect(() => {
		const node = markdownNode;
		if (node && renderedMarkdown) node.innerHTML = renderedMarkdown;
	});
</script>

<section
	class="min-h-[28rem] overflow-hidden rounded-xl border border-zinc-200 bg-white"
	aria-label="File preview"
>
	{#if file.deletedAt}
		<div
			class="border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
		>
			This file is in trash. Its preview remains available until purge.
		</div>
	{:else if expired}
		<div
			class="border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
		>
			This file has expired. Its preview remains available until purge.
		</div>
	{/if}
	{#if preview.loading || (linkLoading && !linkUrl)}
		<div class="animate-pulse space-y-4 p-8">
			<div class="h-8 w-2/3 rounded bg-zinc-100"></div>
			<div class="h-4 w-full rounded bg-zinc-100"></div>
			<div class="h-4 w-5/6 rounded bg-zinc-100"></div>
		</div>
	{:else if preview.error || (linkError && !linkUrl)}
		<div
			class="flex min-h-[28rem] flex-col items-center justify-center p-8 text-center"
			role="alert"
		>
			<p class="text-sm text-red-700">
				{preview.error?.message ??
					linkError?.message ??
					'Could not load the file preview'}
			</p>
			<Button variant="secondary" class="mt-4" onclick={retry}>
				Try again
			</Button>
		</div>
	{:else if preview.current?.kind === 'markdown'}
		<article
			{@attach attachMarkdownPreview}
			class="markdown-preview p-6 sm:p-10"
		></article>
	{:else if preview.current?.kind === 'text'}
		<pre
			class="overflow-x-auto whitespace-pre-wrap p-6 font-mono text-sm leading-7 text-zinc-800 sm:p-10">{preview
				.current.text}</pre>
	{:else if file.contentType.startsWith('image/') && linkUrl}
		<div class="flex min-h-[28rem] items-center justify-center bg-zinc-50 p-4">
			<img
				src={linkUrl}
				alt={file.displayName}
				decoding="async"
				fetchpriority="high"
				class="max-h-[70vh] max-w-full object-contain"
			/>
		</div>
	{:else if file.contentType.startsWith('video/') && linkUrl}
		<!-- svelte-ignore a11y_media_has_caption (uploaded videos do not include a captions asset) -->
		<video controls src={linkUrl} class="max-h-[70vh] w-full bg-black"></video>
	{:else if file.contentType.startsWith('audio/') && linkUrl}
		<div class="flex min-h-[28rem] items-center justify-center p-8">
			<audio controls src={linkUrl} class="w-full"></audio>
		</div>
	{:else if (file.contentType === 'application/pdf' || html) && linkUrl}
		<!-- Sandbox keeps framed HTML from navigating the dashboard window;
		     PDFs stay unsandboxed because Chrome's viewer breaks inside one. -->
		<iframe
			src={linkUrl}
			title={`Preview of ${file.displayName}`}
			sandbox={file.contentType === 'application/pdf'
				? undefined
				: 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads'}
			class="h-[calc(100dvh-11rem)] min-h-[28rem] w-full border-0"
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
