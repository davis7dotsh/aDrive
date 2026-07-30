<script lang="ts">
	import type { Tag } from '@adrive/shared';
	import TagChip from './TagChip.svelte';

	let {
		tags,
		selected,
		label = 'Tags',
		busy = false,
		ontoggle,
		oncreate
	}: {
		tags: ReadonlyArray<Tag>;
		selected: ReadonlyArray<Tag>;
		label?: string;
		busy?: boolean;
		ontoggle: (tag: Tag) => void | Promise<void>;
		oncreate?: (name: string) => void | Promise<void>;
	} = $props();

	const componentId = $props.id();
	const inputId = `tag-picker-${componentId}`;
	const listboxId = `${inputId}-listbox`;
	const statusId = `${inputId}-status`;
	let query = $state('');
	let expanded = $state(false);
	let activeIndex = $state(-1);
	const matches = $derived(
		tags.filter((tag) => tag.name.toLowerCase().includes(query.toLowerCase()))
	);
	const createName = $derived(query.trim());
	const canCreate = $derived(
		Boolean(createName && matches.length === 0 && oncreate)
	);
	const optionCount = $derived(matches.length + (canCreate ? 1 : 0));
	const optionId = (index: number) => `${listboxId}-option-${index}`;
	const activeOptionId = $derived(
		expanded && activeIndex >= 0 && activeIndex < optionCount
			? optionId(activeIndex)
			: undefined
	);
	const resultMessage = $derived(
		expanded
			? canCreate
				? `No matching tags. Create ${createName} is available.`
				: `${matches.length} ${matches.length === 1 ? 'tag' : 'tags'} available.`
			: ''
	);

	const openList = () => {
		expanded = true;
		if (activeIndex < 0 || activeIndex >= optionCount) {
			activeIndex = optionCount > 0 ? 0 : -1;
		}
	};

	const moveActive = (step: 1 | -1) => {
		expanded = true;
		if (optionCount === 0) {
			activeIndex = -1;
			return;
		}
		if (activeIndex < 0 || activeIndex >= optionCount) {
			activeIndex = step === 1 ? 0 : optionCount - 1;
			return;
		}
		activeIndex = (activeIndex + step + optionCount) % optionCount;
	};

	const toggle = async (tag: Tag) => {
		if (busy) return;
		try {
			await ontoggle(tag);
		} catch {
			// Callers own mutation error reporting; keep the combobox usable.
		}
	};

	const create = async () => {
		const name = createName;
		if (busy || !name || !oncreate) return;
		try {
			await oncreate(name);
			query = '';
			activeIndex = tags.length > 0 ? 0 : -1;
		} catch {
			// Preserve the query so the user can retry.
		}
	};

	const chooseActive = () => {
		if (activeIndex >= 0 && activeIndex < matches.length) {
			void toggle(matches[activeIndex]);
		} else if (canCreate && activeIndex === matches.length) {
			void create();
		}
	};

	const onKeydown = (event: KeyboardEvent) => {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			moveActive(1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			moveActive(-1);
		} else if (event.key === 'Enter' && expanded && optionCount > 0) {
			event.preventDefault();
			chooseActive();
		} else if (event.key === 'Escape' && expanded) {
			event.preventDefault();
			expanded = false;
			activeIndex = -1;
		} else if (event.key === 'Tab') {
			expanded = false;
			activeIndex = -1;
		}
	};
</script>

<div>
	{#if selected.length > 0}
		<div class="mb-2 flex flex-wrap gap-1.5">
			{#each selected as tag (tag.id)}
				<TagChip {tag} removable={!busy} onremove={() => void toggle(tag)} />
			{/each}
		</div>
	{/if}
	<label for={inputId} class="sr-only">{label}</label>
	<input
		id={inputId}
		type="search"
		role="combobox"
		aria-autocomplete="list"
		aria-haspopup="listbox"
		aria-controls={listboxId}
		aria-expanded={expanded}
		aria-activedescendant={activeOptionId}
		aria-describedby={statusId}
		aria-busy={busy}
		autocomplete="off"
		disabled={busy}
		value={query}
		placeholder="Find or create a tag"
		class="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm"
		onfocus={openList}
		oninput={(event) => {
			query = event.currentTarget.value;
			expanded = true;
			activeIndex = 0;
		}}
		onkeydown={onKeydown}
		onblur={() => {
			expanded = false;
			activeIndex = -1;
		}}
	/>
	<p id={statusId} class="sr-only" role="status" aria-live="polite">
		{resultMessage}
	</p>
	{#if expanded && optionCount > 0}
		<div
			id={listboxId}
			role="listbox"
			aria-label={label}
			aria-multiselectable="true"
			class="mt-2 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto"
		>
			{#each matches as tag, index (tag.id)}
				<button
					id={optionId(index)}
					type="button"
					role="option"
					tabindex="-1"
					disabled={busy}
					aria-selected={selected.some((item) => item.id === tag.id)}
					class="rounded-full border px-2.5 py-1 text-xs {activeIndex === index
						? 'ring-2 ring-zinc-400 ring-offset-1'
						: ''} {selected.some((item) => item.id === tag.id)
						? 'border-accent-500 bg-accent-50 text-accent-700'
						: 'border-zinc-200 text-zinc-600'}"
					onmousedown={(event) => event.preventDefault()}
					onmousemove={() => (activeIndex = index)}
					onclick={() => void toggle(tag)}>{tag.name}</button
				>
			{/each}
			{#if canCreate}
				<button
					id={optionId(matches.length)}
					type="button"
					role="option"
					tabindex="-1"
					aria-selected="false"
					disabled={busy}
					class="rounded-md px-2.5 py-1 text-xs font-medium text-accent-700 hover:bg-accent-50 {activeIndex ===
					matches.length
						? 'ring-2 ring-zinc-400 ring-offset-1'
						: ''}"
					onmousedown={(event) => event.preventDefault()}
					onmousemove={() => (activeIndex = matches.length)}
					onclick={() => void create()}>Create “{createName}”</button
				>
			{/if}
		</div>
	{/if}
</div>
