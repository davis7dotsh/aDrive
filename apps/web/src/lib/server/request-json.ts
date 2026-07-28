import { Effect, Schema } from 'effect';
import { InvalidRequest } from './errors';

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
