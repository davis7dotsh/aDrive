// A tiny, script-free password prompt for a passworded durable share. Served
// from the cookie-less content origin: the form re-GETs the same URL with the
// entered password, so no dashboard session cookie is ever involved. Uses a
// locked-down CSP and never caches.

const escapeHtml = (value: string) =>
	value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');

export const sharePasswordPage = (url: URL, attempted: boolean) => {
	const token = url.searchParams.get('s') ?? '';
	const action = escapeHtml(url.pathname);
	const error = attempted
		? '<p class="err">That password did not match. Try again.</p>'
		: '';
	const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Password required</title>
<style>
	body { font: 16px/1.5 system-ui, sans-serif; margin: 0; background: #fff; color: #18181b; }
	main { max-width: 22rem; margin: 12vh auto; padding: 0 1.25rem; }
	h1 { font-size: 1.15rem; margin: 0 0 1rem; }
	label { display: block; font-size: 0.9rem; color: #52525b; margin-bottom: 0.35rem; }
	input { width: 100%; box-sizing: border-box; padding: 0.55rem 0.7rem; border: 1px solid #d4d4d8; border-radius: 0.5rem; font-size: 1rem; }
	button { margin-top: 0.9rem; width: 100%; padding: 0.55rem; border: 0; border-radius: 0.5rem; background: #18181b; color: #fff; font-size: 1rem; cursor: pointer; }
	.err { color: #b91c1c; font-size: 0.85rem; }
</style>
</head>
<body>
<main>
<h1>This file is password protected</h1>
<form method="get" action="${action}">
<input type="hidden" name="s" value="${escapeHtml(token)}" />
<label for="p">Password</label>
<input id="p" name="p" type="password" autocomplete="current-password" autofocus />
<button type="submit">View file</button>
${error}
</form>
</main>
</body>
</html>`;
	return new Response(body, {
		status: attempted ? 401 : 200,
		headers: {
			'Cache-Control': 'private, no-store',
			'Content-Type': 'text/html; charset=utf-8',
			'Content-Security-Policy':
				"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
			'Referrer-Policy': 'no-referrer',
			'X-Content-Type-Options': 'nosniff'
		}
	});
};
