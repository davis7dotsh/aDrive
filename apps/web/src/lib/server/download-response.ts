import { InvalidRequest } from './errors';
import { Effect } from 'effect';

export const validateRangeHeader = (value: string | null) => {
	if (value !== null && !/^bytes=(?:\d+-\d*|-\d+)$/i.test(value.trim())) {
		throw new InvalidRequest({
			status: 416,
			message: 'Byte range is invalid'
		});
	}
	return value;
};

export const decodeRangeHeader = (value: string | null) =>
	Effect.try({
		try: () => validateRangeHeader(value),
		catch: (cause) =>
			cause instanceof InvalidRequest
				? cause
				: new InvalidRequest({
						status: 416,
						message: 'Byte range is invalid'
					})
	});

export const rangeHeaders = (object: R2ObjectBody, totalSize: number) => {
	if (!object.range) {
		return {
			status: 200,
			contentLength: object.size,
			contentRange: undefined
		};
	}
	const range = object.range;
	const offset =
		'suffix' in range
			? Math.max(0, totalSize - range.suffix)
			: (range.offset ?? Math.max(0, totalSize - (range.length ?? totalSize)));
	const length =
		'suffix' in range
			? Math.min(totalSize, range.suffix)
			: (range.length ?? totalSize - offset);
	return {
		status: 206,
		contentLength: length,
		contentRange: `bytes ${offset}-${offset + length - 1}/${totalSize}`
	};
};
