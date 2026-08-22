import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { Console, Effect } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { CliFailure } from '../errors.ts';
import { emit, wantsJson } from '../output.ts';
import { CLI_VERSION } from '../version.ts';

const RELEASES_REPO = 'davis7dotsh/aDrive';
const CLI_TAG_PREFIX = 'cli-v';

// Semver comparison including prerelease precedence (1.0.0-beta.1 < 1.0.0;
// prerelease identifiers compare numerically when both numeric, else
// lexically, per semver.org #11).
export const compareSemver = (left: string, right: string) => {
	const [leftCore, leftPre = ''] = left.split(/-(.*)/s) as [string, string?];
	const [rightCore, rightPre = ''] = right.split(/-(.*)/s) as [string, string?];
	const parseCore = (value: string) => value.split('.').map(Number);
	const [lMajor = 0, lMinor = 0, lPatch = 0] = parseCore(leftCore);
	const [rMajor = 0, rMinor = 0, rPatch = 0] = parseCore(rightCore);
	const core = lMajor - rMajor || lMinor - rMinor || lPatch - rPatch;
	if (core !== 0) return core;
	if (leftPre === rightPre) return 0;
	if (leftPre === '') return 1; // release > any prerelease
	if (rightPre === '') return -1;
	const leftIds = leftPre.split('.');
	const rightIds = rightPre.split('.');
	for (let i = 0; i < Math.max(leftIds.length, rightIds.length); i += 1) {
		const l = leftIds[i];
		const r = rightIds[i];
		if (l === undefined) return -1; // shorter prerelease sorts first
		if (r === undefined) return 1;
		const lNum = /^\d+$/.test(l) ? Number(l) : null;
		const rNum = /^\d+$/.test(r) ? Number(r) : null;
		if (lNum !== null && rNum !== null) {
			if (lNum !== rNum) return lNum - rNum;
		} else if (lNum !== null) {
			return -1; // numeric < alphanumeric
		} else if (rNum !== null) {
			return 1;
		} else if (l !== r) {
			return l < r ? -1 : 1;
		}
	}
	return 0;
};

export const upgrade = Command.make(
	'upgrade',
	{
		check: Flag.boolean('check').pipe(
			Flag.withDescription('Only report whether a newer release exists')
		)
	},
	({ check }) =>
		Effect.gen(function* () {
			if (CLI_VERSION === 'dev') {
				return yield* new CliFailure({
					message:
						'This CLI is running from source; update with `git pull` instead.'
				});
			}
			// /releases/latest returns the newest release of ANY kind; the CLI
			// shares its repo with the app, so list releases and pick the
			// newest cli-v* tag instead.
			const release = yield* Effect.tryPromise({
				try: async () => {
					const response = await fetch(
						`https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=100`,
						{ headers: { accept: 'application/vnd.github+json' } }
					);
					if (!response.ok) {
						throw new Error(`GitHub returned ${response.status}`);
					}
					const body: unknown = await response.json();
					if (!Array.isArray(body)) {
						throw new Error('Release list response was not an array');
					}
					const tags = body
						.map((entry: unknown) =>
							typeof entry === 'object' &&
							entry !== null &&
							'tag_name' in entry &&
							typeof entry.tag_name === 'string'
								? entry.tag_name
								: null
						)
						.filter(
							(tag): tag is string =>
								tag !== null &&
								// Stable releases only, unless this build is itself a
								// prerelease (then its own line may offer newer rcs).
								(CLI_VERSION.includes('-')
									? tag.startsWith(CLI_TAG_PREFIX)
									: /^cli-v\d+\.\d+\.\d+$/.test(tag))
						);
					if (tags.length === 0) {
						throw new Error('No CLI releases found');
					}
					const newest = tags.reduce((best, tag) =>
						compareSemver(
							tag.slice(CLI_TAG_PREFIX.length),
							best.slice(CLI_TAG_PREFIX.length)
						) > 0
							? tag
							: best
					);
					return { tag: newest };
				},
				catch: (cause) =>
					new CliFailure({
						message:
							cause instanceof Error
								? `Could not check for updates: ${cause.message}`
								: 'Could not check for updates',
						cause
					})
			});
			const latest = release.tag.slice(CLI_TAG_PREFIX.length);
			if (compareSemver(latest, CLI_VERSION) <= 0) {
				yield* emit(
					wantsJson()
						? { status: 'current', version: CLI_VERSION, latest }
						: `adrive v${CLI_VERSION} is up to date`
				);
				return;
			}
			if (check) {
				yield* emit(
					wantsJson()
						? { status: 'outdated', version: CLI_VERSION, latest }
						: `adrive v${latest} is available (installed: v${CLI_VERSION}). Run \`adrive upgrade\` to install it.`
				);
				return;
			}
			// JSON mode stays machine-parseable: suppress human narration and
			// the installer's own stdout, then emit a single result line.
			if (!wantsJson()) {
				yield* Console.log(`Upgrading adrive v${CLI_VERSION} -> v${latest}…`);
			}
			// Reuse the blessed installer so upgrade and fresh install can
			// never drift. The installer is verified against the release's
			// checksums.txt before executing — it runs with the user's shell,
			// so it gets the same integrity bar it applies to the bundle.
			const script = yield* Effect.tryPromise({
				try: async () => {
					const base = `https://github.com/${RELEASES_REPO}/releases/download/${release.tag}`;
					const [scriptResponse, checksumResponse] = await Promise.all([
						fetch(`${base}/install-cli.sh`),
						fetch(`${base}/checksums.txt`)
					]);
					if (!scriptResponse.ok) {
						throw new Error(
							`installer download returned ${scriptResponse.status}`
						);
					}
					if (!checksumResponse.ok) {
						throw new Error(
							`checksums download returned ${checksumResponse.status}`
						);
					}
					const scriptBytes = new Uint8Array(
						await scriptResponse.arrayBuffer()
					);
					const checksums = await checksumResponse.text();
					const expected = checksums
						.split('\n')
						.map((line) => line.trim().split(/\s+/))
						.find((parts) => parts[1] === 'install-cli.sh')?.[0];
					if (!expected) {
						throw new Error('checksums.txt has no entry for install-cli.sh');
					}
					const digest = await crypto.subtle.digest('SHA-256', scriptBytes);
					const actual = Array.from(new Uint8Array(digest), (byte) =>
						byte.toString(16).padStart(2, '0')
					).join('');
					if (actual !== expected) {
						throw new Error('installer checksum mismatch; aborting');
					}
					return new TextDecoder().decode(scriptBytes);
				},
				catch: (cause) =>
					new CliFailure({
						message:
							cause instanceof Error
								? `Could not download the installer: ${cause.message}`
								: 'Could not download the installer',
						cause
					})
			});
			yield* Effect.tryPromise({
				try: () =>
					new Promise<void>((resolve, reject) => {
						const child = spawn('bash', ['-s', '--'], {
							// In JSON mode the installer's stdout would corrupt the
							// output stream; route it to stderr instead.
							stdio: wantsJson()
								? ['pipe', process.stderr, 'inherit']
								: ['pipe', 'inherit', 'inherit'],
							env: {
								...process.env,
								ADRIVE_CLI_VERSION: release.tag,
								// Upgrade in place: the running bundle's directory is
								// where the installer must write, not the default,
								// so custom install locations self-update correctly.
								ADRIVE_INSTALL_DIR: dirname(fileURLToPath(import.meta.url))
							}
						});
						child.once('error', reject);
						child.once('close', (status) =>
							status === 0
								? resolve()
								: reject(new Error(`installer exited with ${status}`))
						);
						child.stdin.end(script);
					}),
				catch: (cause) =>
					new CliFailure({
						message:
							cause instanceof Error
								? cause.message
								: 'The installer did not complete',
						cause
					})
			});
			if (wantsJson()) {
				yield* emit({ status: 'upgraded', from: CLI_VERSION, to: latest });
			}
		})
).pipe(
	Command.withDescription('Update this CLI to the latest release'),
	Command.withAlias('update')
);
