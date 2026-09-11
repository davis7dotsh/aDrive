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
			'https://cdn.example/lib.js',
			'https://collect.example/post',
			'https://upper.example/Path'
		]);
	});

	it('reads quoted greater-than signs without inventing tags in comments or raw text', () => {
		expect(
			extractLinks(`
				<!-- <a href="https://comment.example/"> -->
				<script>const example = '<a href="https://script.example/">';</script>
				<style>a::after { content: '<a href="https://style.example/">'; }</style>
				<textarea><a href="https://textarea.example/"></textarea>
				<a title="1 > 0" href="https://links.example/?x=>">link</a>`)
		).toEqual(['https://links.example/?x=%3E']);
	});

	it('resolves all relative targets against the first base href, including earlier links', () => {
		expect(
			extractLinks(
				`<a href="login">login</a>
				<base target="_blank"><base href="https://external.example/app/">
				<base href="https://ignored.example/">
				<script src="../script.js"></script><form action="/collect"></form>`,
				{
					documentUrl: 'https://own.example/s/id/index.html',
					ignoreHost: 'own.example'
				}
			)
		).toEqual([
			'https://external.example/app/login',
			'https://external.example/script.js',
			'https://external.example/collect'
		]);
	});

	it('resolves relative bases against the document and protocol-relative targets against its scheme', () => {
		expect(
			extractLinks(
				'<base href="../assets/"><a href="next.html">next</a><script src="//cdn.example/script.js"></script>',
				{ documentUrl: 'https://own.example/s/id/docs/index.html' }
			)
		).toEqual([
			'https://own.example/s/id/assets/next.html',
			'https://cdn.example/script.js'
		]);
		expect(
			extractLinks(
				'<base href="//external.example/app/"><a href="next">next</a>',
				{
					documentUrl: 'https://own.example/s/id/'
				}
			)
		).toEqual(['https://external.example/app/next']);
	});

	it('ignores inert template and foreign base elements when choosing the document base', () => {
		expect(
			extractLinks(
				`<template><base href="https://template.example/"><a href="https://inert.example/">inert</a></template>
				<svg><base href="https://foreign.example/"></base></svg>
				<base href="https://effective.example/"><a href="login">login</a>`,
				{ documentUrl: 'https://own.example/s/id/' }
			)
		).toEqual(['https://effective.example/login']);
	});

	it.each(['http://[invalid', 'javascript:alert(1)', 'data:text/html,hi'])(
		'uses the document URL when the first base is invalid or forbidden: %s',
		(base) => {
			expect(
				extractLinks(
					`<base href="${base}"><base href="https://ignored.example/"><a href="next">next</a>`,
					{
						documentUrl: 'https://own.example/s/id/'
					}
				)
			).toEqual(['https://own.example/s/id/next']);
		}
	);

	it('decodes base attributes once and resolves deeply nested documents without recursion', () => {
		expect(
			extractLinks(
				`<base href="https&#58;//external.example/app/&amp;colon;/">${'<div>'.repeat(5_000)}<a href="next">next</a>`,
				{ documentUrl: 'https://own.example/s/id/' }
			)
		).toEqual(['https://external.example/app/&colon;/next']);
	});

	it('honors a zero limit', () => {
		expect(
			extractLinks('<a href="https://links.example/">link</a>', { limit: 0 })
		).toEqual([]);
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

	it.each([
		'https&#58;//evil.example/collect',
		'https&#x3a;//evil.example/collect',
		'https&#X3A;//evil.example/collect',
		'https&#58//evil.example/collect',
		'https&#x3a//evil.example/collect',
		'&#104;ttps:&#47;&#x2f;evil.example/collect',
		'https&colon;&sol;&sol;evil.example/collect',
		'ht&#9;tps://evil.example/collect',
		'htt&#xA;ps://evil.example/collect',
		'https&#13;://evil.example/collect',
		'https&Tab;://evil.example/collect',
		'&NewLine;https://evil.example/collect'
	])('decodes browser-recognized attribute references: %s', (target) => {
		expect(extractLinks(`<form action="${target}"></form>`)).toEqual([
			'https://evil.example/collect'
		]);
	});

	it('decodes numeric references in unquoted and single-quoted attributes', () => {
		expect(
			extractLinks(`
				<a href='&#104ttps://links.example/path'>link</a>
				<script src=https&#x3a//cdn.example/script.js></script>`)
		).toEqual(['https://links.example/path', 'https://cdn.example/script.js']);
	});

	it('decodes once and preserves ambiguous or malformed references', () => {
		expect(
			extractLinks(
				'<a href="https://x.example/?a=&amp;#58;&ampx=1&amp=2&bad=&#x;">x</a>'
			)
		).toEqual(['https://x.example/?a=&']);
		// The decoded literal # starts a fragment, which is removed. It must
		// not be decoded again into a colon and change the outgoing URL.
		expect(
			extractLinks('<a href="https&amp;colon;//evil.example/">x</a>')
		).toEqual([]);
		expect(
			extractLinks('<a href="https://x.example/?a=1&ampx=2&amp=3">x</a>')
		).toEqual(['https://x.example/?a=1&ampx=2&amp=3']);
	});

	it('uses HTML replacements for invalid and legacy numeric code points', () => {
		expect(
			extractLinks(
				'<a href="https://x.example/&#0;/&#xD800;/&#x110000;/&#128;">x</a>'
			)
		).toEqual(['https://x.example/%EF%BF%BD/%EF%BF%BD/%EF%BF%BD/%E2%82%AC']);
	});

	it.each([
		'javascript&#58;alert(1)',
		'java&#x09;script&colon;alert(1)',
		'data&#58;text/html,hello',
		'ftp&#58;//files.example/file',
		'&#47;relative'
	])('still excludes non-HTTP or relative URLs: %s', (target) => {
		expect(extractLinks(`<a href="${target}">x</a>`)).toEqual([]);
	});
});
