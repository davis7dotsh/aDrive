import { describe, expect, it } from 'vitest';
import { contentDisposition, contentSecurityPolicy } from './content-headers';

describe('content response headers', () => {
	it('renders safe preview types inline with UTF-8 filenames', () => {
		expect(contentDisposition('résumé.pdf', 'application/pdf')).toContain(
			'inline;'
		);
		expect(contentDisposition('résumé.pdf', 'application/pdf')).toContain(
			"filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"
		);
	});

	it('forces unknown bytes and authenticated downloads to attachment', () => {
		expect(
			contentDisposition('archive.bin', 'application/octet-stream')
		).toMatch(/^attachment;/);
		expect(contentDisposition('report.pdf', 'application/pdf', true)).toMatch(
			/^attachment;/
		);
	});

	it('gives public HTML a content-origin CSP and denies framing', () => {
		const policy = contentSecurityPolicy('text/html');
		expect(policy).toContain("default-src 'self'");
		expect(policy).toContain("frame-ancestors 'none'");
	});
});
