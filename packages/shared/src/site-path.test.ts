import { describe, expect, it } from 'vitest';
import {
	InvalidSitePath,
	normalizeSitePath,
	sitePathCandidates
} from './index';

describe('site asset paths', () => {
	it('keeps portable normalized relative paths', () => {
		expect(normalizeSitePath('assets/app.4d2f.js')).toBe('assets/app.4d2f.js');
		expect(normalizeSitePath('café/menu.html')).toBe('café/menu.html');
	});

	it.each([
		'',
		'/etc/passwd',
		'C:/windows/system.ini',
		'../secret',
		'assets/../../secret',
		'assets//app.js',
		'assets\\app.js',
		'assets/./app.js',
		'assets／app.js',
		'assets∕app.js',
		'assets/ｅvil.js',
		'assets/\u202eevil.js'
	])(
		'rejects absolute, traversal, backslash, and confusable path %j',
		(path) => {
			expect(() => normalizeSitePath(path)).toThrow(InvalidSitePath);
		}
	);

	it('resolves site roots and directories to index.html without rewriting files', () => {
		expect(sitePathCandidates('')).toEqual(['index.html']);
		expect(sitePathCandidates('docs/')).toEqual(['docs/index.html']);
		expect(sitePathCandidates('docs')).toEqual(['docs', 'docs/index.html']);
		expect(sitePathCandidates('assets/app.js')).toEqual([
			'assets/app.js',
			'assets/app.js/index.html'
		]);
	});
});
