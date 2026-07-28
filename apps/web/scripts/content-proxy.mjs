import { createServer, request } from 'node:http';

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
