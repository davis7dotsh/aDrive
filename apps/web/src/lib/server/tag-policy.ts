import { InvalidRequest } from './errors';

export const normalizeTagName = (value: string) => {
	const name = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
	if (!name || name.length > 64 || /[\u0000-\u001f\u007f]/.test(name)) {
		throw new InvalidRequest({ status: 400, message: 'Tag name is invalid' });
	}
	return {
		name,
		normalizedName: name.toLocaleLowerCase('en-US')
	};
};

export const normalizeTagColor = (value: string | null | undefined) => {
	if (value === null || value === undefined || value.trim() === '') return null;
	const color = value.trim().toLowerCase();
	if (!/^#[0-9a-f]{6}$/.test(color)) {
		throw new InvalidRequest({
			status: 400,
			message: 'Tag color must be a six-digit hex color'
		});
	}
	return color;
};

export const uniqueTagNames = (values: ReadonlyArray<string>) => {
	if (values.length > 20) {
		throw new InvalidRequest({
			status: 400,
			message: 'A file can have at most 20 tags'
		});
	}
	const unique = new Map<string, string>();
	for (const value of values) {
		const tag = normalizeTagName(value);
		if (!unique.has(tag.normalizedName)) {
			unique.set(tag.normalizedName, tag.name);
		}
	}
	return [...unique.values()];
};
