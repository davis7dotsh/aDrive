import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { InvalidRequest, StorageError } from './errors';
import type { AuthorizedCredential, TokenRestriction } from './services/auth';

// A credential is "scoped" when either target axis is set. Sessions and
// full-drive keys carry null on both axes and reach the whole drive.
export const isRestricted = (restriction: TokenRestriction) =>
	restriction.tagIds !== null || restriction.fileIds !== null;

// A file is reachable by a scoped token when it is named explicitly or carries
// one of the allowed tags. The two axes are a union: adding a tag axis widens
// reach rather than narrowing the explicit file list.
export const restrictionMatches = (
	restriction: TokenRestriction,
	fileId: string,
	tagIds: ReadonlyArray<string>
) => {
	if (!isRestricted(restriction)) return true;
	if (restriction.fileIds?.includes(fileId)) return true;
	if (restriction.tagIds && tagIds.some((id) => restriction.tagIds!.includes(id)))
		return true;
	return false;
};

// Drop out-of-scope rows from an already-loaded listing/search page. Keeping
// this a post-filter avoids threading token state into every keyset query;
// scoped tokens are the exception, and short pages simply page again.
export const filterFilesByScope = <
	F extends { readonly id: string; readonly tags: ReadonlyArray<{ readonly id: string }> }
>(
	credential: AuthorizedCredential,
	files: ReadonlyArray<F>
): ReadonlyArray<F> =>
	isRestricted(credential.restriction)
		? files.filter((file) =>
				restrictionMatches(
					credential.restriction,
					file.id,
					file.tags.map((tag) => tag.id)
				)
			)
		: files;

const loadFileTagIds = (fileId: string) =>
	Effect.gen(function* () {
		const sql = (yield* SqlClient.SqlClient).withoutTransforms();
		const rows = yield* sql
			.unsafe('SELECT tag_id FROM file_tags WHERE file_id = ?', [fileId])
			.pipe(
				Effect.mapError(
					(cause) =>
						new StorageError({ operation: 'load file tags for scope', cause })
				)
			);
		return rows.flatMap((row) => {
			const value = (row as { readonly tag_id?: unknown }).tag_id;
			return typeof value === 'string' ? [value] : [];
		});
	});

const forbidden = new InvalidRequest({
	status: 403,
	message: 'This token is scoped and cannot access that file'
});

// Guard a single-file route. No-ops for unrestricted credentials and for files
// named explicitly; only otherwise does it load the file's tags to decide.
export const assertFileInScope = (
	credential: AuthorizedCredential,
	fileId: string
) =>
	Effect.gen(function* () {
		const restriction = credential.restriction;
		if (!isRestricted(restriction)) return;
		if (restriction.fileIds?.includes(fileId)) return;
		const tagIds =
			restriction.tagIds && restriction.tagIds.length > 0
				? yield* loadFileTagIds(fileId)
				: [];
		if (restrictionMatches(restriction, fileId, tagIds)) return;
		return yield* forbidden;
	});

// Guard actions a scoped token must never perform: creating brand-new files or
// sites (they cannot be pre-listed) and editing the drive-wide tag taxonomy.
export const assertUnrestricted = (
	credential: AuthorizedCredential,
	message = 'This token is scoped and cannot create new files, sites, or tags. Use a full-drive key.'
) =>
	isRestricted(credential.restriction)
		? Effect.fail(new InvalidRequest({ status: 403, message }))
		: Effect.void;
