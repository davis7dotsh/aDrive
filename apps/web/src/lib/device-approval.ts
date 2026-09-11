// Authentication may return only to the dashboard's device approval flow.
// Never carry an arbitrary path or URL through the provider callback.
export const deviceApprovalParams = (input: URLSearchParams) => {
	const params = new URLSearchParams();
	const code = input.get('device');
	if (!code || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(code)) return params;
	params.set('device', code.toUpperCase());
	const expires = Number(input.get('expires'));
	if (
		Number.isSafeInteger(expires) &&
		expires > 0 &&
		Number.isSafeInteger(expires * 1_000)
	) {
		params.set('expires', String(expires));
	}
	return params;
};
