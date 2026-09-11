import { decodeHTMLAttribute } from 'entities';

// The outbound targets inside a published HTML document: `<a href>`,
// `<script src>`, and `<form action>`. Only absolute http(s) URLs to other
// hosts are returned; relative links point back at the same site, which
// the scanner is already looking at.

const TARGET_ATTRIBUTES: ReadonlyArray<{
	readonly tag: string;
	readonly attribute: string;
}> = [
	{ tag: 'a', attribute: 'href' },
	{ tag: 'script', attribute: 'src' },
	{ tag: 'form', attribute: 'action' }
];

const attributeValue = (tagBody: string, attribute: string) => {
	const pattern = new RegExp(
		`(?:^|\\s)${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
		'i'
	);
	const match = pattern.exec(tagBody);
	return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null;
};

const absoluteHttpUrl = (raw: string) => {
	try {
		// Decode exactly once with HTML attribute rules, including numeric
		// references without semicolons. URL parsing applies the browser's
		// ASCII tab/newline normalization before we check the scheme.
		const url = new URL(decodeHTMLAttribute(raw));
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		url.hash = '';
		return url.href;
	} catch {
		return null;
	}
};

export const extractLinks = (
	html: string,
	options: { readonly limit?: number; readonly ignoreHost?: string } = {}
) => {
	const limit = options.limit ?? 100;
	const found = new Set<string>();
	for (const { tag, attribute } of TARGET_ATTRIBUTES) {
		const tagPattern = new RegExp(`<${tag}\\b([^>]*)>`, 'gi');
		for (const match of html.matchAll(tagPattern)) {
			const raw = attributeValue(match[1] ?? '', attribute);
			if (raw === null) continue;
			const url = absoluteHttpUrl(raw);
			if (url === null) continue;
			if (options.ignoreHost && new URL(url).host === options.ignoreHost) {
				continue;
			}
			found.add(url);
			if (found.size >= limit) return [...found];
		}
	}
	return [...found];
};
