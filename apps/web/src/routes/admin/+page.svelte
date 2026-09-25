<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { formatBytes, formatDate } from '$lib/dashboard/format';
	import { getToasts } from '$lib/dashboard/toast.svelte';
	import Button from '$lib/components/ui/Button.svelte';
	import type { Resolution } from '$lib/server/report-policy';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const toasts = getToasts();
	let busy = $state('');

	const act = async (key: string, path: string, body: unknown) => {
		if (busy) return false;
		busy = key;
		try {
			const response = await fetch(path, {
				method: path.endsWith('/hashes') ? 'POST' : 'PATCH',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify(body)
			});
			if (!response.ok) {
				const payload: unknown = await response.json().catch(() => null);
				const message =
					typeof payload === 'object' &&
					payload !== null &&
					'message' in payload &&
					typeof payload.message === 'string'
						? payload.message
						: `Request failed (${response.status})`;
				throw new Error(message);
			}
			try {
				await invalidateAll();
			} catch {
				toasts.info('Action saved. Reload to refresh the admin overview.');
			}
			return true;
		} catch (cause) {
			toasts.error(cause, 'Action failed');
			return false;
		} finally {
			busy = '';
		}
	};

	const resolutions = [
		'dismissed',
		'quarantined',
		'suspended',
		'removed'
	] as const satisfies ReadonlyArray<Resolution>;
	const resolveReport = (id: string, resolution: Resolution) =>
		act(`report:${id}`, `/api/admin/reports/${id}`, { resolution });
	const orgAction = (id: string, body: Record<string, string>) =>
		act(`org:${id}`, `/api/admin/orgs/${id}`, body);
	const markFile = (
		id: string,
		version: number,
		verdict: 'clean' | 'malicious'
	) => act(`file:${id}`, `/api/admin/files/${id}`, { verdict, version });

	let hash = $state('');
	let hashReason = $state('');
	const blockHash = async () => {
		const saved = await act('hash', '/api/admin/hashes', {
			sha256: hash.trim(),
			reason: hashReason.trim()
		});
		if (saved) {
			hash = '';
			hashReason = '';
		}
	};

	const overview = $derived(data.overview);
	const cell = 'py-2 pr-4 align-top';
	const head = 'pb-2 pr-4 text-left font-medium text-zinc-500';
</script>

<svelte:head>
	<title>Admin · adrive</title>
</svelte:head>

<main class="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
	<h1 class="text-3xl font-semibold tracking-tight text-zinc-950">Admin</h1>

	<section class="mt-8">
		<h2 class="text-lg font-semibold text-zinc-950">
			Reports ({overview.reports.length})
		</h2>
		<div class="mt-3 overflow-x-auto">
			<table class="w-full min-w-[48rem] text-sm">
				<thead>
					<tr>
						<th class={head}>Filed</th>
						<th class={head}>Reason</th>
						<th class={head}>File</th>
						<th class={head}>Org</th>
						<th class={head}>Reporter</th>
						<th class={head}></th>
					</tr>
				</thead>
				<tbody class="divide-y divide-zinc-100">
					{#each overview.reports as report (report.id)}
						<tr>
							<td class="{cell} whitespace-nowrap text-zinc-500"
								>{formatDate(report.createdAt)}</td
							>
							<td class={cell}>
								{report.reason}
								{#if report.details}
									<div class="mt-1 max-w-xs text-xs break-words text-zinc-500">
										{report.details}
									</div>
								{/if}
							</td>
							<td class={cell}>
								{#if report.file}
									{report.file.name}
									<div class="text-xs text-zinc-500">
										v{report.file.version} · {report.file.quarantined
											? 'quarantined'
											: report.file.publishPending
												? 'held'
												: report.file.public
													? 'public'
													: 'private'}
									</div>
								{:else}
									<span class="text-zinc-400">gone</span>
								{/if}
								<div class="font-mono text-xs text-zinc-400">
									{report.fileId}
								</div>
							</td>
							<td class={cell}>{report.orgSlug ?? report.orgId}</td>
							<td class="{cell} font-mono text-xs text-zinc-500"
								>{report.reporter}</td
							>
							<td class="{cell} whitespace-nowrap">
								<div class="flex flex-wrap gap-1">
									<Button
										variant="ghost"
										disabled={busy !== '' ||
											!report.file ||
											report.file.quarantined}
										onclick={() => {
											if (report.file)
												void markFile(
													report.fileId,
													report.file.version,
													'malicious'
												);
										}}>Quarantine</Button
									>
									<Button
										variant="ghost"
										disabled={busy !== ''}
										onclick={() =>
											orgAction(report.orgId, { action: 'suspend' })}
										>Suspend org</Button
									>
									<form
										class="flex items-center gap-1"
										onsubmit={(event) => {
											event.preventDefault();
											const value = new FormData(event.currentTarget).get(
												'resolution'
											);
											const resolution = resolutions.find(
												(item) => item === value
											);
											if (resolution) void resolveReport(report.id, resolution);
										}}
									>
										<select
											name="resolution"
											required
											aria-label="Report resolution"
											disabled={busy !== ''}
											class="max-w-44 rounded-md border border-zinc-300 px-2 py-2 text-xs"
										>
											<option value="">Record outcome…</option>
											<option value="dismissed">Dismissed</option>
											<option value="quarantined">File quarantined</option>
											<option value="suspended">Org suspended</option>
											<option value="removed">Content removed</option>
										</select>
										<Button
											type="submit"
											variant="ghost"
											disabled={busy !== ''}
										>
											Close report
										</Button>
									</form>
								</div>
							</td>
						</tr>
					{:else}
						<tr><td class="{cell} text-zinc-400" colspan="6">None</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>

	<section class="mt-10">
		<h2 class="text-lg font-semibold text-zinc-950">
			Held and quarantined files ({overview.held.length})
		</h2>
		<div class="mt-3 overflow-x-auto">
			<table class="w-full min-w-[48rem] text-sm">
				<thead>
					<tr>
						<th class={head}>Updated</th>
						<th class={head}>File</th>
						<th class={head}>Org</th>
						<th class={head}>State</th>
						<th class={head}>Verdicts</th>
						<th class={head}></th>
					</tr>
				</thead>
				<tbody class="divide-y divide-zinc-100">
					{#each overview.held as file (file.id)}
						<tr>
							<td class="{cell} whitespace-nowrap text-zinc-500"
								>{formatDate(file.updatedAt)}</td
							>
							<td class={cell}>
								{file.name}
								<div class="text-xs text-zinc-500">
									{file.contentType} · v{file.version}
								</div>
								<div class="font-mono text-xs text-zinc-400">{file.id}</div>
							</td>
							<td class={cell}>{file.orgSlug}</td>
							<td class={cell}>
								{file.quarantined
									? 'quarantined'
									: file.publishPending
										? 'held'
										: 'live, flagged'}
							</td>
							<td class="{cell} text-xs">
								{#each file.verdicts as verdict (verdict.source)}
									<details class="w-56 max-w-full">
										<summary class="cursor-pointer py-0.5">
											<span class="text-zinc-500">{verdict.source}</span>
											{verdict.verdict}
										</summary>
										<pre
											class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-50 p-2 text-zinc-600">{JSON.stringify(
												verdict.details,
												null,
												2
											)}</pre>
									</details>
								{/each}
							</td>
							<td class="{cell} whitespace-nowrap">
								<div class="flex gap-1">
									<Button
										variant="ghost"
										disabled={busy !== ''}
										onclick={() => markFile(file.id, file.version, 'clean')}
										>Clean</Button
									>
									<Button
										variant="danger"
										disabled={busy !== '' || file.quarantined}
										onclick={() => markFile(file.id, file.version, 'malicious')}
										>Malicious</Button
									>
								</div>
							</td>
						</tr>
					{:else}
						<tr><td class="{cell} text-zinc-400" colspan="6">None</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>

	<section class="mt-10">
		<h2 class="text-lg font-semibold text-zinc-950">
			Failed jobs ({overview.failedJobs.length})
		</h2>
		<div class="mt-3 overflow-x-auto">
			<table class="w-full min-w-[40rem] text-sm">
				<thead>
					<tr>
						<th class={head}>Failed</th>
						<th class={head}>Kind</th>
						<th class={head}>Org</th>
						<th class={head}>Attempts</th>
						<th class={head}>Error</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-zinc-100">
					{#each overview.failedJobs as job (job.id)}
						<tr>
							<td class="{cell} whitespace-nowrap text-zinc-500"
								>{formatDate(job.failedAt)}</td
							>
							<td class={cell}>
								{job.kind}
								<div class="max-w-xs truncate font-mono text-xs text-zinc-400">
									{JSON.stringify(job.payload)}
								</div>
							</td>
							<td class="{cell} font-mono text-xs">{job.orgId ?? ''}</td>
							<td class={cell}>{job.attempts}</td>
							<td class="{cell} max-w-md text-xs break-words text-zinc-600"
								>{job.error}</td
							>
						</tr>
					{:else}
						<tr><td class="{cell} text-zinc-400" colspan="5">None</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>

	<section class="mt-10">
		<h2 class="text-lg font-semibold text-zinc-950">
			Recent orgs ({overview.orgs.length})
		</h2>
		<div class="mt-3 overflow-x-auto">
			<table class="w-full min-w-[48rem] text-sm">
				<thead>
					<tr>
						<th class={head}>Created</th>
						<th class={head}>Slug</th>
						<th class={head}>Id</th>
						<th class={head}>Trust</th>
						<th class={head}>Plan</th>
						<th class={head}>Stored</th>
						<th class={head}>Files</th>
						<th class={head}></th>
					</tr>
				</thead>
				<tbody class="divide-y divide-zinc-100">
					{#each overview.orgs as org (org.id)}
						<tr>
							<td class="{cell} whitespace-nowrap text-zinc-500"
								>{formatDate(org.createdAt)}</td
							>
							<td class={cell}>{org.slug}</td>
							<td class="{cell} font-mono text-xs text-zinc-500">{org.id}</td>
							<td class={cell}>{org.trust}</td>
							<td class={cell}>{org.plan}</td>
							<td class="{cell} whitespace-nowrap"
								>{formatBytes(org.storedBytes)}</td
							>
							<td class={cell}>{org.fileCount}</td>
							<td class="{cell} whitespace-nowrap">
								<div class="flex gap-1">
									{#if org.trust === 'suspended'}
										<Button
											variant="ghost"
											disabled={busy !== ''}
											onclick={() => orgAction(org.id, { action: 'restore' })}
											>Restore</Button
										>
									{:else}
										{#if org.trust !== 'established'}
											<Button
												variant="ghost"
												disabled={busy !== ''}
												onclick={() =>
													orgAction(org.id, {
														action: 'trust',
														trust:
															org.trust === 'new' ? 'verified' : 'established'
													})}>Bump trust</Button
											>
										{/if}
										<Button
											variant="danger"
											disabled={busy !== ''}
											onclick={() => orgAction(org.id, { action: 'suspend' })}
											>Suspend</Button
										>
									{/if}
								</div>
							</td>
						</tr>
					{:else}
						<tr><td class="{cell} text-zinc-400" colspan="8">None</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>

	<section class="mt-10">
		<h2 class="text-lg font-semibold text-zinc-950">Block a hash</h2>
		<form
			class="mt-3 flex max-w-2xl flex-wrap items-end gap-2"
			onsubmit={(event) => {
				event.preventDefault();
				void blockHash();
			}}
		>
			<label class="min-w-0 flex-1 text-sm">
				<span class="font-medium text-zinc-700">SHA-256</span>
				<input
					bind:value={hash}
					disabled={busy !== ''}
					spellcheck="false"
					autocapitalize="off"
					class="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-sm"
				/>
			</label>
			<label class="w-56 text-sm">
				<span class="font-medium text-zinc-700">Reason</span>
				<input
					bind:value={hashReason}
					disabled={busy !== ''}
					class="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
				/>
			</label>
			<Button type="submit" disabled={busy !== '' || hash.trim().length !== 64}
				>Block</Button
			>
		</form>
	</section>
</main>
