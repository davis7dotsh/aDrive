// Pure decisions for the scan pipeline (services/scanner.ts).

export const SCAN_VERDICTS = ['clean', 'suspicious', 'malicious'] as const;
export type ScanVerdict = (typeof SCAN_VERDICTS)[number];

export const isScanVerdict = (value: string): value is ScanVerdict =>
	(SCAN_VERDICTS as ReadonlyArray<string>).includes(value);

// Objects up to this size are hashed whole for the blocked list; larger
// ones are only sniffed (a 100 MiB upload is not worth a full read on
// every version).
export const SCAN_HASH_MAX_BYTES = 32 * 1024 * 1024;
// How much of an HTML document the link extractor reads.
export const SCAN_HTML_MAX_BYTES = 512 * 1024;
// Site assets inspected per version; the rest of a huge site is skipped
// and the skip is recorded on the verdict.
export const SCAN_SITE_ASSET_LIMIT = 50;
// Links submitted to the URL Scanner per publish.
export const SCAN_LINK_LIMIT = 10;
// URL Scanner polling: the job re-sends itself this often, this many times.
export const URL_SCAN_POLL_DELAY_SECONDS = 30;
export const URL_SCAN_MAX_ATTEMPTS = 20;

const severity: Record<ScanVerdict, number> = {
	clean: 0,
	suspicious: 1,
	malicious: 2
};

export const worstVerdict = (
	verdicts: ReadonlyArray<ScanVerdict>
): ScanVerdict =>
	verdicts.reduce<ScanVerdict>(
		(worst, verdict) => (severity[verdict] > severity[worst] ? verdict : worst),
		'clean'
	);

export type ScanOutcome =
	// Nothing changes; a held publish stays held for a person to look at.
	| { readonly _tag: 'Hold' }
	// The held publish goes live.
	| { readonly _tag: 'Publish' }
	| { readonly _tag: 'Quarantine' };

// What the overall verdict does to the row. A clean verdict on a file that
// was not held (scan-after) is a no-op that still purges nothing.
export const scanOutcome = (
	verdict: ScanVerdict,
	publishPending: boolean
): ScanOutcome => {
	switch (verdict) {
		case 'malicious':
			return { _tag: 'Quarantine' };
		case 'suspicious':
			return { _tag: 'Hold' };
		case 'clean':
			return publishPending ? { _tag: 'Publish' } : { _tag: 'Hold' };
	}
};

// Whether a URL Scanner poll that is still pending should be asked again.
export const shouldPollAgain = (attempt: number) =>
	attempt < URL_SCAN_MAX_ATTEMPTS;
