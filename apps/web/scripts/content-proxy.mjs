import { createServer, request } from 'node:http';

// Streams `<slug>.localhost:5174` (or whatever CONTENT_DOMAIN names) into
// the dashboard dev server on 5173. The Host header is forwarded untouched
// so the Worker sees the tenant host and enforces its host routing exactly
// as in production; browsers resolve `*.localhost` to loopback, so no DNS
// setup is needed locally.
const server = createServer((incoming, outgoing) => {
	const upstream = request(
		{
			hostname: '127.0.0.1',
			port: 5173,
			method: incoming.method,
			path: incoming.url,
			headers: incoming.headers
		},
		(response) => {
			outgoing.writeHead(response.statusCode ?? 502, response.headers);
			response.pipe(outgoing);
		}
	);

	upstream.on('error', (cause) => {
		console.error(`Content proxy failed: ${cause.message}`);
		if (!outgoing.headersSent) outgoing.writeHead(502);
		outgoing.end('Dashboard dev server unavailable');
	});
	incoming.pipe(upstream);
});

server.listen(5174, '0.0.0.0', () => {
	console.log('Content origin proxy listening on http://0.0.0.0:5174');
});
