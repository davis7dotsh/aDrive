import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

describe('Markdown preview rendering', () => {
	it('renders document structure', () => {
		expect(renderMarkdown('# Title\n\n- one\n- two')).toContain(
			'<h1>Title</h1>'
		);
		expect(renderMarkdown('# Title\n\n- one\n- two')).toContain('<li>one</li>');
	});

	it('escapes raw HTML and rejects unsafe links', () => {
		const rendered = renderMarkdown(
			'<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))'
		);
		expect(rendered).not.toContain('<script>');
		expect(rendered).not.toContain('href="javascript:');
	});
});
