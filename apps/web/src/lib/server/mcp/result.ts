export const jsonResult = (value: unknown) => ({
	content: [{ type: 'text' as const, text: JSON.stringify(value) }]
});

export const errorResult = (message: string, status?: number) => ({
	isError: true as const,
	content: [
		{
			type: 'text' as const,
			text: JSON.stringify(
				status === undefined
					? { ok: false, message }
					: { ok: false, message, status }
			)
		}
	]
});
