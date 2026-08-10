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

export const rangeHeaders = (
	object: Pick<R2ObjectBody, 'range' | 'size'>,
	totalSize: number,
	requestedRange: string | null
) => {
	const fullResponse = () => ({
		status: 200,
		contentLength: object.size,
		contentRange: undefined
	});
	if (requestedRange === null) return fullResponse();
	const range = object.range;
	if (!range) return fullResponse();
	const suffix =
		'suffix' in range && typeof range.suffix === 'number'
			? range.suffix
			: undefined;
	const returnedOffset =
		'offset' in range && typeof range.offset === 'number'
			? range.offset
			: undefined;
	const returnedLength =
		'length' in range && typeof range.length === 'number'
			? range.length
			: undefined;
	if (
		suffix === undefined &&
		returnedOffset === undefined &&
		returnedLength === undefined
	) {
		return fullResponse();
	}
	const offset =
		suffix !== undefined
			? Math.max(0, totalSize - suffix)
			: (returnedOffset ??
				Math.max(0, totalSize - (returnedLength ?? totalSize)));
	const length =
		suffix !== undefined
			? Math.min(totalSize, suffix)
			: (returnedLength ?? totalSize - offset);
	if (totalSize === 0 && offset === 0 && length === 0) return fullResponse();
	if (
		!Number.isSafeInteger(offset) ||
		!Number.isSafeInteger(length) ||
		offset < 0 ||
		length <= 0 ||
		offset + length > totalSize
	) {
		return null;
	}
	return {
		status: 206,
		contentLength: length,
		contentRange: `bytes ${offset}-${offset + length - 1}/${totalSize}`
	};
};
