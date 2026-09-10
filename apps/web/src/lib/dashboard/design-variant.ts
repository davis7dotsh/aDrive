import { getContext, setContext } from 'svelte';

// /A … /E render the files page under one of the design variants. The
// layout provides the active letter so components can switch structure
// where CSS alone is not enough.
export const DESIGN_VARIANTS = ['a', 'b', 'c', 'd', 'e'] as const;
export type DesignVariant = (typeof DESIGN_VARIANTS)[number];

const KEY = Symbol('design-variant');

export const parseDesignVariant = (value: string | undefined) => {
	const letter = value?.toLowerCase();
	return DESIGN_VARIANTS.find((candidate) => candidate === letter) ?? null;
};

export const provideDesignVariant = (read: () => DesignVariant | null) =>
	setContext(KEY, read);

export const useDesignVariant = () =>
	getContext<(() => DesignVariant | null) | undefined>(KEY) ?? (() => null);
