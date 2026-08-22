import { describe, expect, it } from 'vitest';
import { sameJson, stripComments } from './check-wrangler-drift.mjs';

describe('check-wrangler-drift helpers', () => {
	it('keeps // inside JSON strings', () => {
		const parsed = JSON.parse(
			stripComments('{ "NOTE": "see docs // then more" }')
		);
		expect(parsed.NOTE).toBe('see docs // then more');
	});

	it('treats equivalent objects with different key order as equal', () => {
		expect(
			sameJson(
				{ enabled: true, traces: { enabled: true, head_sampling_rate: 0.01 } },
				{ traces: { head_sampling_rate: 0.01, enabled: true }, enabled: true }
			)
		).toBe(true);
	});
});
