import { Schema } from 'effect';

export const CliConfigSchema = Schema.Struct({
	endpoint: Schema.String,
	apiKey: Schema.String,
	contentOrigin: Schema.optional(Schema.String),
	allowHttp: Schema.optional(Schema.Boolean)
});

export type CliConfig = typeof CliConfigSchema.Type;
