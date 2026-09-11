// Content sniffing for the scanner: what the first bytes of an object say
// it is, and whether that contradicts the type the uploader declared in a
// way browsers would act on. Only signatures that matter for abuse are
// listed; anything else is `unknown` and never a mismatch.

export type SniffedKind =
	| 'html'
	| 'svg'
	| 'pe'
	| 'elf'
	| 'macho'
	| 'shell-script'
	| 'zip'
	| 'pdf'
	| 'png'
	| 'jpeg'
	| 'gif'
	| 'webp'
	| 'unknown';

// Executable and active content: served under a benign declared type they
// are either a download that runs, or markup the browser executes.
const ACTIVE_KINDS: ReadonlySet<SniffedKind> = new Set([
	'html',
	'svg',
	'pe',
	'elf',
	'macho',
	'shell-script'
]);

export const SNIFF_LENGTH = 512;

const startsWith = (bytes: Uint8Array, signature: ReadonlyArray<number>) =>
	signature.every((byte, index) => bytes[index] === byte);

// TextDecoder consumes the UTF-8 BOM before checking markup signatures.
const asciiPrefix = (bytes: Uint8Array) =>
	new TextDecoder().decode(bytes.subarray(0, SNIFF_LENGTH));

const isPe = (bytes: Uint8Array, sizeBytes: number) => {
	if (!startsWith(bytes, [0x4d, 0x5a]) || bytes.length < 64) return false;
	const offset = new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength
	).getUint32(0x3c, true);
	if (offset < 64 || offset + 4 > sizeBytes) return false;
	// A plausible DOS header can point past the retained prefix. Keep it
	// suspicious when the signature exists outside the inspected window.
	return (
		offset + 4 > bytes.byteLength ||
		startsWith(bytes.subarray(offset), [0x50, 0x45, 0, 0])
	);
};

const HTML_TAGS = [
	'<!doctype html',
	'<html',
	'<head',
	'<body',
	'<script',
	'<iframe',
	'<meta',
	'<title',
	'<a ',
	'<div',
	'<p>',
	'<h1',
	'<img',
	'<form',
	'<object',
	'<embed'
];

const looksLikeHtml = (text: string) => {
	const lowered = text.replace(/^﻿/, '').trimStart().toLowerCase();
	return HTML_TAGS.some((tag) => lowered.startsWith(tag));
};

const looksLikeSvg = (text: string) => {
	const lowered = text.replace(/^﻿/, '').trimStart().toLowerCase();
	return (
		lowered.startsWith('<svg') ||
		(lowered.startsWith('<?xml') && lowered.includes('<svg'))
	);
};

export const sniffKind = (
	bytes: Uint8Array,
	sizeBytes = bytes.byteLength
): SniffedKind => {
	if (bytes.length === 0) return 'unknown';
	if (isPe(bytes, sizeBytes)) return 'pe';
	if (startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46])) return 'elf';
	if (
		startsWith(bytes, [0xfe, 0xed, 0xfa, 0xce]) ||
		startsWith(bytes, [0xfe, 0xed, 0xfa, 0xcf]) ||
		startsWith(bytes, [0xcf, 0xfa, 0xed, 0xfe]) ||
		startsWith(bytes, [0xce, 0xfa, 0xed, 0xfe]) ||
		startsWith(bytes, [0xca, 0xfe, 0xba, 0xbe]) ||
		startsWith(bytes, [0xbe, 0xba, 0xfe, 0xca]) ||
		startsWith(bytes, [0xca, 0xfe, 0xba, 0xbf]) ||
		startsWith(bytes, [0xbf, 0xba, 0xfe, 0xca])
	) {
		return 'macho';
	}
	if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf';
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
		return 'png';
	}
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
	if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'gif';
	if (
		startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return 'webp';
	}
	if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'zip';
	const text = asciiPrefix(bytes);
	if (text.startsWith('#!')) return 'shell-script';
	if (looksLikeSvg(text)) return 'svg';
	if (looksLikeHtml(text)) return 'html';
	return 'unknown';
};

const baseType = (contentType: string) =>
	contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';

// Declared types under which each active kind is expected, and so not a
// mismatch. HTML declared as text/plain is the classic trick (browsers
// honour nosniff, other clients do not), so plain text is not benign for
// html or svg.
const EXPECTED_TYPES: Record<
	Exclude<SniffedKind, 'unknown'>,
	ReadonlyArray<string>
> = {
	html: ['text/html', 'application/xhtml+xml'],
	svg: ['image/svg+xml', 'application/xml', 'text/xml'],
	pe: [
		'application/octet-stream',
		'application/x-msdownload',
		'application/vnd.microsoft.portable-executable',
		'application/x-msdos-program',
		'application/x-dosexec'
	],
	elf: [
		'application/octet-stream',
		'application/x-elf',
		'application/x-executable'
	],
	macho: ['application/octet-stream', 'application/x-mach-binary'],
	'shell-script': [
		'text/plain',
		'text/x-shellscript',
		'text/x-sh',
		'application/x-sh',
		'application/x-shellscript',
		'text/x-python',
		'text/x-script.python',
		'application/x-perl',
		'text/x-perl',
		'text/x-ruby',
		'application/javascript',
		'text/javascript'
	],
	zip: [],
	pdf: [],
	png: [],
	jpeg: [],
	gif: [],
	webp: []
};

export interface SniffResult {
	readonly kind: SniffedKind;
	readonly declared: string;
	readonly verdict: 'clean' | 'suspicious';
}

// Active content hiding behind a type that does not admit it. Passive
// kinds (images, archives, PDFs) are never flagged here: the mismatch is
// harmless and the hash check covers known-bad payloads.
export const sniffMismatch = (
	bytes: Uint8Array,
	declaredContentType: string,
	sizeBytes = bytes.byteLength
): SniffResult => {
	const kind = sniffKind(bytes, sizeBytes);
	const declared = baseType(declaredContentType);
	if (kind === 'unknown' || !ACTIVE_KINDS.has(kind)) {
		return { kind, declared, verdict: 'clean' };
	}
	const expected = EXPECTED_TYPES[kind];
	return {
		kind,
		declared,
		verdict: expected.includes(declared) ? 'clean' : 'suspicious'
	};
};
