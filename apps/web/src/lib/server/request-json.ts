import { Effect, Schema } from 'effect';
import { InvalidRequest } from './errors';

interface BoundedJsonOptions {
	readonly maxBytes: number;
	readonly invalidLengthMessage: string;
	readonly invalidJsonMessage: string;
}

type BodyReadResult =
	| { readonly _tag: 'Success'; readonly bytes: Uint8Array }
	| { readonly _tag: 'TooLarge' }
	| { readonly _tag: 'ReadFailure' };

const readBodyAtMost = async (
	request: Request,
	maxBytes: number
): Promise<BodyReadResult> => {
	if (request.body === null) {
		return { _tag: 'Success', bytes: new Uint8Array() };
	}

	let reader: ReadableStreamDefaultReader<Uint8Array>;
	try {
		reader = request.body.getReader();
	} catch {
		return { _tag: 'ReadFailure' };
	}
	const chunks: Array<Uint8Array> = [];
	let totalBytes = 0;

	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;

			totalBytes += next.value.byteLength;
			if (totalBytes > maxBytes) {
				try {
					await reader.cancel();
				} catch {
					// The size violation remains the primary request failure.
				}
				return { _tag: 'TooLarge' };
			}
			chunks.push(next.value);
		}
	} catch {
		return { _tag: 'ReadFailure' };
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// A disturbed stream is handled as a request failure above.
		}
	}

	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { _tag: 'Success', bytes };
};

export const readBoundedJson = (
	request: Request,
	{ maxBytes, invalidLengthMessage, invalidJsonMessage }: BoundedJsonOptions
) =>
	Effect.gen(function* () {
		const contentLengthHeader = request.headers.get('content-length');
		if (contentLengthHeader === null) {
			return yield* new InvalidRequest({
				status: 411,
				message: 'Content-Length is required'
			});
		}

		const contentLength = Number(contentLengthHeader);
		if (
			!Number.isSafeInteger(contentLength) ||
			contentLength < 0 ||
			contentLength > maxBytes
		) {
			return yield* new InvalidRequest({
				status: contentLength > maxBytes ? 413 : 400,
				message: invalidLengthMessage
			});
		}

		const body = yield* Effect.promise(() => readBodyAtMost(request, maxBytes));
		switch (body._tag) {
			case 'TooLarge':
				return yield* new InvalidRequest({
					status: 413,
					message: invalidLengthMessage
				});
			case 'ReadFailure':
				return yield* new InvalidRequest({
					status: 400,
					message: invalidJsonMessage
				});
			case 'Success':
				return yield* Effect.try({
					try: (): unknown => JSON.parse(new TextDecoder().decode(body.bytes)),
					catch: () =>
						new InvalidRequest({
							status: 400,
							message: invalidJsonMessage
						})
				});
		}
	});

export const decodeJson = <A, I>(
	request: Request,
	schema: Schema.Codec<A, I, never>,
	message: string
) =>
	Effect.tryPromise({
		try: () => request.json(),
		catch: () => new InvalidRequest({ status: 400, message })
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(schema)),
		Effect.mapError((cause) =>
			cause instanceof InvalidRequest
				? cause
				: new InvalidRequest({ status: 400, message })
		)
	);
