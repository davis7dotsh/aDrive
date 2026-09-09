import { Schema } from 'effect';

// Abuse reports from anyone on a content host (`/report`).
export const REPORT_REASONS = [
	'malware',
	'phishing',
	'copyright',
	'illegal',
	'spam',
	'other'
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_DETAILS_MAX = 2_000;

export const ReportCreateSchema = Schema.Struct({
	fileId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
	reason: Schema.Literals(REPORT_REASONS),
	details: Schema.optionalKey(
		Schema.String.check(Schema.isMaxLength(REPORT_DETAILS_MAX))
	)
});

export type ReportCreate = typeof ReportCreateSchema.Type;

// Reporter addresses are stored hashed with a per-deployment secret so the
// queue can spot one address filing many reports without keeping IPs.
export const hashReporterIp = async (ip: string, secret: string) => {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(`${secret}\n${ip.normalize('NFKC').trim()}`)
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('');
};

export const RESOLUTIONS = [
	'dismissed',
	'quarantined',
	'suspended',
	'removed'
] as const;

export type Resolution = (typeof RESOLUTIONS)[number];

export const isResolution = (value: string): value is Resolution =>
	(RESOLUTIONS as ReadonlyArray<string>).includes(value);
