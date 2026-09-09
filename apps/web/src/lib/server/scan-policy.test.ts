import { describe, expect, it } from 'vitest';
import { scanOutcome, shouldPollAgain, worstVerdict } from './scan-policy';

describe('scan policy', () => {
	it('takes the worst verdict across checks', () => {
		expect(worstVerdict([])).toBe('clean');
		expect(worstVerdict(['clean', 'suspicious', 'clean'])).toBe('suspicious');
		expect(worstVerdict(['suspicious', 'malicious'])).toBe('malicious');
	});

	it('publishes a held clean file, holds suspicious, quarantines malicious', () => {
		expect(scanOutcome('clean', true)).toEqual({ _tag: 'Publish' });
		expect(scanOutcome('clean', false)).toEqual({ _tag: 'Hold' });
		expect(scanOutcome('suspicious', true)).toEqual({ _tag: 'Hold' });
		expect(scanOutcome('malicious', false)).toEqual({ _tag: 'Quarantine' });
	});

	it('stops polling the URL scanner eventually', () => {
		expect(shouldPollAgain(1)).toBe(true);
		expect(shouldPollAgain(20)).toBe(false);
	});
});
