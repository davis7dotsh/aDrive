import { describe, expect, it } from 'vitest';
import { tagForeground } from './tag-foreground';

describe('custom tag foreground', () => {
	it.each([
		['#ffffff', '#000000'],
		['#000000', '#ffffff'],
		['#ff0000', '#000000'],
		['#00ff00', '#000000'],
		['#0000ff', '#ffffff'],
		['#FFFF00', '#000000'],
		['#757575', '#ffffff'],
		['#767676', '#000000']
	])('keeps text legible on %s', (background, foreground) => {
		expect(tagForeground(background)).toBe(foreground);
	});

	it.each([null, undefined, '', 'invalid'])(
		'preserves the theme fallback for %s',
		(color) => {
			expect(tagForeground(color)).toBeUndefined();
		}
	);
});
