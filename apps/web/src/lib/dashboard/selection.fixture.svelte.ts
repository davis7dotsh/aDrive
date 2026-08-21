// Compiled (.svelte.ts) fixture so tests can instantiate createSelection
// with live $effects; plain .test.ts files are not rune-compiled.
import { flushSync } from 'svelte';
import type { DashboardFile } from '@adrive/shared';
import { createSelection, type Selection } from './selection.svelte';

type SelectionDeps = Parameters<typeof createSelection>[0];
type SelectionToasts = SelectionDeps['toasts'];

export interface SelectionFixtureOptions {
	readonly files?: ReadonlyArray<DashboardFile>;
	readonly visible?: ReadonlyArray<DashboardFile>;
	readonly view?: boolean | (() => boolean);
}

export interface SelectionFixture {
	readonly selection: Selection;
	readonly dispose: () => void;
	readonly setView: (value: boolean) => void;
}

export const setupSelection = (
	toasts: SelectionToasts,
	refetch: () => Promise<unknown>,
	options?: SelectionFixtureOptions
): SelectionFixture => {
	// Reactive view holder so tests can flip views through a signal rather
	// than a plain closure (the reset effect must observe a change).
	let dynamicView = $state<boolean | null>(null);
	const viewAccessor = options?.view;
	const view: () => boolean = () => {
		if (typeof viewAccessor === 'function') return viewAccessor();
		return dynamicView ?? viewAccessor ?? false;
	};
	let selection!: Selection;
	const dispose = $effect.root(() => {
		selection = createSelection({
			session: { token: 'secret-token' },
			toasts,
			files: () => options?.files ?? [],
			visible: () => options?.visible ?? options?.files ?? [],
			view,
			refetch
		});
	});
	flushSync();
	return {
		selection,
		dispose,
		setView: (value: boolean) => {
			dynamicView = value;
		}
	};
};
