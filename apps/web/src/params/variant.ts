import type { ParamMatcher } from '@sveltejs/kit';

// Design variants of the files page live at /A … /E while they are under
// review. Single letters outside this range stay free for content routes.
export const match: ParamMatcher = (param) => /^[a-eA-E]$/.test(param);
