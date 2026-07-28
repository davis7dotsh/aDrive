import { TagSchema, type DashboardFile } from '@adrive/shared';
import { Schema } from 'effect';

export const DashboardFileRow = Schema.Struct({
	id: Schema.String,
	display_name: Schema.String,
	content_type: Schema.String,
	kind: Schema.Literals(['file', 'site']),
	current_version: Schema.Int,
	size_bytes: Schema.Int,
	is_public: Schema.Int,
	has_html: Schema.Int,
	created_at: Schema.String,
	updated_at: Schema.String,
	deleted_at: Schema.NullOr(Schema.String),
	expires_at: Schema.NullOr(Schema.String),
	download_count: Schema.Int,
	last_download_at: Schema.NullOr(Schema.String),
	tags_json: Schema.String
});

export const dashboardFileColumns = `
	f.id,
	f.display_name,
	f.content_type,
	f.kind,
	f.current_version,
	f.size_bytes,
	f.public AS is_public,
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
	COALESCE((
		SELECT json_group_array(json_object(
			'id', t.id,
			'name', t.name,
			'normalizedName', t.normalized_name,
			'color', t.color,
			'fileCount', 0,
			'createdAt', t.created_at
		))
		FROM file_tags ft
		JOIN tags t ON t.id = ft.tag_id
		WHERE ft.file_id = f.id
		ORDER BY t.normalized_name
	), '[]') AS tags_json
`;

export const decodeDashboardRows = (rows: unknown) => {
	const decoded = Schema.decodeUnknownOption(Schema.Array(DashboardFileRow))(
		rows
	);
	return decoded._tag === 'Some' ? decoded.value : [];
};

const decodeTags = (value: string) => {
	try {
		const decoded = Schema.decodeUnknownOption(Schema.Array(TagSchema))(
			JSON.parse(value)
		);
		return decoded._tag === 'Some' ? decoded.value : [];
	} catch {
		return [];
	}
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
	public: row.is_public === 1,
	htmlForcedPublic: row.has_html === 1,
	createdAt: row.created_at,
	updatedAt: row.updated_at,
	deletedAt: row.deleted_at,
	expiresAt: row.expires_at,
	downloadCount: row.download_count,
	lastDownloadAt: row.last_download_at,
	tags: decodeTags(row.tags_json)
});
