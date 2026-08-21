import { writeSync } from 'node:fs';
import { Console } from 'effect';
import { CliFailure } from './errors.ts';

let jsonMode = process.argv.includes('--json');
if (jsonMode) {
	process.argv = process.argv.filter((argument) => argument !== '--json');
}

export const wantsJson = () => jsonMode;

export const emit = (value: unknown) =>
	Console.log(wantsJson() ? JSON.stringify(value) : String(value));

export const formatBytes = (bytes: number) => {
	if (bytes < 1024) return `${bytes} B`;
	let value = bytes;
	let unit = 'B';
	for (const next of ['KB', 'MB', 'GB', 'TB']) {
		if (value < 1024) break;
		value /= 1024;
		unit = next;
	}
	return `${value >= 100 ? Math.round(value).toString() : value.toFixed(1)} ${unit}`;
};

// Render our own CliFailures as "hint on top, dimmed detail below" (or a
// single JSON error line in --json mode) and exit 1. Anything else — CLI
// usage/help output, genuine defects — is left to the framework's own
// reporting untouched.
export const renderCliFailure = (failure: CliFailure) => {
	// writeSync so the message can't be truncated by process.exit before an
	// async pipe drains. stdout is fd 1, stderr fd 2.
	if (wantsJson()) {
		writeSync(
			1,
			`${JSON.stringify({
				error: failure.message,
				...(failure.status !== undefined ? { status: failure.status } : {}),
				...(failure.detail !== undefined ? { detail: failure.detail } : {})
			})}\n`
		);
		return;
	}
	const tty = process.stderr.isTTY;
	const mark = tty ? '\x1b[31m✗\x1b[0m' : '✗';
	let out = `${mark} ${failure.message}\n`;
	if (failure.detail) {
		const detail = tty ? `\x1b[2m${failure.detail}\x1b[0m` : failure.detail;
		out += `  ${detail}\n`;
	}
	writeSync(2, out);
};

export const findCliFailure = (cause: unknown): CliFailure | undefined => {
	if (cause instanceof CliFailure) return cause;
	if (
		cause !== null &&
		typeof cause === 'object' &&
		'reasons' in cause &&
		Array.isArray((cause as { reasons: unknown }).reasons)
	) {
		for (const reason of (cause as { reasons: Array<unknown> }).reasons) {
			if (
				reason !== null &&
				typeof reason === 'object' &&
				'error' in reason &&
				reason.error instanceof CliFailure
			) {
				return reason.error;
			}
		}
	}
	return undefined;
};
