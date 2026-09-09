import { describe, expect, it } from 'vitest';
import { extractLinks } from './html-links';

describe('html link extraction', () => {
	it('collects absolute anchor, script, and form targets once each', () => {
		const html = `
			<html><body>
				<a href="https://evil.example/login?x=1#frag">login</a>
				<a href='https://evil.example/login?x=1'>again</a>
				<a href="/relative">home</a>
				<a href="mailto:me@example.test">mail</a>
				<script src=https://cdn.example/lib.js></script>
				<form action="https://collect.example/post" method="post"></form>
				<A HREF="HTTPS://Upper.Example/Path">upper</A>
			</body></html>`;
		expect(extractLinks(html)).toEqual([
			'https://evil.example/login?x=1',
			'https://upper.example/Path',
			'https://cdn.example/lib.js',
			'https://collect.example/post'
		]);
	});

	it('skips the site host and honours the limit', () => {
		const html = `
			<a href="https://me.files.example/f/1">mine</a>
			<a href="https://a.example/">a</a>
			<a href="https://b.example/">b</a>
			<a href="https://c.example/">c</a>`;
		expect(
			extractLinks(html, { limit: 2, ignoreHost: 'me.files.example' })
		).toEqual(['https://a.example/', 'https://b.example/']);
	});

	it('decodes entities in attribute values', () => {
		expect(
			extractLinks('<a href="https://x.example/?a=1&amp;b=2">x</a>')
		).toEqual(['https://x.example/?a=1&b=2']);
	});
});
