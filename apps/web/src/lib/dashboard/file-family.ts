import type { DashboardFile } from '@adrive/shared';

export type FileFamily =
	'image' | 'site' | 'code' | 'data' | 'archive' | 'doc' | 'text' | 'other';

const CODE = /(javascript|typescript|json|yaml|xml|x-python|x-sh|x-go|x-rust)/i;
const CODE_EXT =
	/\.(ts|tsx|js|jsx|mjs|py|rb|go|rs|sh|json|ya?ml|toml|xml|css)$/i;
const DATA = /(csv|tab-separated|sql|parquet)/i;
const ARCHIVE = /(zip|gzip|x-tar|x-7z|x-rar|x-bzip)/i;
const ARCHIVE_EXT = /\.(zip|gz|tar|tgz|7z|rar|bz2)$/i;
const DOC = /(pdf|msword|officedocument|markdown)/i;

// A coarse grouping for color and iconography. Based on the content type
// first and the extension second, so odd uploads still land somewhere.
export const fileFamily = (
	file: Pick<DashboardFile, 'kind' | 'contentType' | 'displayName'>
): FileFamily => {
	const type = file.contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
	if (file.kind === 'site' || type === 'text/html') return 'site';
	if (type.startsWith('image/')) return 'image';
	if (ARCHIVE.test(type)) return 'archive';
	if (DATA.test(type) || /\.(csv|tsv|sql)$/i.test(file.displayName))
		return 'data';
	if (CODE.test(type) || CODE_EXT.test(file.displayName)) return 'code';
	if (DOC.test(type) || /\.(pdf|docx?|md)$/i.test(file.displayName))
		return 'doc';
	if (type.startsWith('text/')) return 'text';
	if (ARCHIVE_EXT.test(file.displayName)) return 'archive';
	return 'other';
};
