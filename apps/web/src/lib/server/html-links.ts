import { parse, type DefaultTreeAdapterMap } from 'parse5';

// The outbound targets inside a published HTML document: `<a href>`,
// `<script src>`, and `<form action>`. Only absolute http(s) URLs to other
// hosts are returned. Resolve relative targets against the document's
// first base element, which can direct them to a different host.

const resolveUrl = (raw: string, base?: string) => {
	try {
		// parse5 already decoded attributes once with HTML rules. The URL
		// parser also applies browser ASCII tab/newline normalization.
		return new URL(raw, base);
	} catch {
		return null;
	}
};

export const extractLinks = (
	html: string,
	options: {
		readonly limit?: number;
		readonly ignoreHost?: string;
		readonly documentUrl?: string;
	} = {}
) => {
	const limit = options.limit ?? 100;
	if (limit <= 0) return [];
	const targets: string[] = [];
	let base = options.documentUrl;
	let foundBase = false;
	const pending: DefaultTreeAdapterMap['node'][] = [parse(html)];
	// Iterative traversal handles deeply nested untrusted documents. Only
	// childNodes belong to the live document; template.content is inert.
	while (pending.length > 0) {
		const node = pending.pop()!;
		if ('tagName' in node) {
			const htmlElement = node.namespaceURI === 'http://www.w3.org/1999/xhtml';
			if (htmlElement && node.tagName === 'base' && !foundBase) {
				const href = node.attrs.find((attr) => attr.name === 'href');
				if (href !== undefined) {
					// An invalid first href still prevents later base elements
					// taking effect. data: and javascript: use the document URL.
					foundBase = true;
					const resolved = resolveUrl(href.value, options.documentUrl);
					if (
						resolved !== null &&
						resolved.protocol !== 'data:' &&
						resolved.protocol !== 'javascript:'
					) {
						base = resolved.href;
					}
				}
			}
			const attribute =
				node.tagName === 'a'
					? 'href'
					: node.tagName === 'script'
						? 'src'
						: node.tagName === 'form'
							? 'action'
							: null;
			if (attribute !== null) {
				const target = node.attrs.find(
					(attr) => attr.name === attribute && !attr.prefix
				);
				if (target !== undefined) targets.push(target.value);
			}
		}
		if ('childNodes' in node) {
			for (let index = node.childNodes.length - 1; index >= 0; index--) {
				pending.push(node.childNodes[index]!);
			}
		}
	}
	const found = new Set<string>();
	for (const raw of targets) {
		const url = resolveUrl(raw, base);
		if (
			url === null ||
			(url.protocol !== 'http:' && url.protocol !== 'https:')
		) {
			continue;
		}
		if (options.ignoreHost && url.host === options.ignoreHost) continue;
		url.hash = '';
		found.add(url.href);
		if (found.size >= limit) break;
	}
	return [...found];
};
