import { TagSchema, type DashboardFile } from '@adrive/shared';
import { Schema } from 'effect';

export const DashboardFileRow = Schema.Struct({
	id: Schema.String,
	display_name: Schema.String,
	content_type: Schema.String,
	kind: Schema.Literals(['file', 'site']),
	current_version: Schema.Int,
	size_bytes: Schema.Int,
	is_public: Schema.Boolean,
	quarantined: Schema.Boolean,
	publish_pending: Schema.Boolean,
	has_html: Schema.Boolean,
	created_at: Schema.String,
	updated_at: Schema.String,
	deleted_at: Schema.NullOr(Schema.String),
	expires_at: Schema.NullOr(Schema.String),
	download_count: Schema.Int,
	last_download_at: Schema.NullOr(Schema.String),
	index_state: Schema.Literals([
		'pending',
		'running',
		'ready',
		'failed',
		'disabled'
	]),
	indexed_version: Schema.NullOr(Schema.Int),
	index_attempts: Schema.Int,
	index_error: Schema.NullOr(Schema.String),
	// jsonb comes back from pg already parsed.
	tags_json: Schema.Array(TagSchema)
});

// Column list for the `files f` alias. Interpolate as a raw string through
// `sql.unsafe` or wrap with `sql.literal`; it contains no parameters.
export const dashboardFileColumns = `
	f.id,
	f.display_name,
	f.content_type,
	f.kind,
	f.current_version,
	f.size_bytes,
	f.public AS is_public,
	f.quarantined,
	f.publish_pending,
	EXISTS (
		SELECT 1 FROM file_versions html_version
		WHERE html_version.file_id = f.id
			AND html_version.content_type = 'text/html'
	) AS has_html,
	f.created_at,
	f.updated_at,
	f.deleted_at,
	f.expires_at,
	f.download_count,
	f.last_download_at,
	f.index_state,
	f.indexed_version,
	f.index_attempts,
	f.index_error,
	COALESCE((
		SELECT jsonb_agg(jsonb_build_object(
			'id', t.id,
			'name', t.name,
			'normalizedName', t.normalized_name,
			'color', t.color,
			'fileCount', 0,
			'createdAt', t.created_at
		) ORDER BY t.normalized_name)
		FROM file_tags ft
		JOIN tags t ON t.id = ft.tag_id
		WHERE ft.file_id = f.id
	), '[]'::jsonb) AS tags_json
`;

export const decodeDashboardRows = (rows: unknown) => {
	const decoded = Schema.decodeUnknownOption(Schema.Array(DashboardFileRow))(
		rows
	);
	return decoded._tag === 'Some' ? decoded.value : [];
};

export const toDashboardFile = (
	row: typeof DashboardFileRow.Type
): DashboardFile => ({
	id: row.id,
	displayName: row.display_name,
	contentType: row.content_type,
	kind: row.kind,
	version: row.current_version,
	sizeBytes: row.size_bytes,
	public: row.is_public,
	quarantined: row.quarantined,
	publishPending: row.publish_pending,
	htmlForcedPublic: row.has_html,
	createdAt: row.created_at,
	updatedAt: row.updated_at,
	deletedAt: row.deleted_at,
	expiresAt: row.expires_at,
	downloadCount: row.download_count,
	lastDownloadAt: row.last_download_at,
	indexState: row.index_state,
	indexedVersion: row.indexed_version,
	indexAttempts: row.index_attempts,
	indexError: row.index_error,
	tags: row.tags_json
});
