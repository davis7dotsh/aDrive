const url = process.argv[2];
const token = process.env.ADRIVE_API_KEY;

if (!url || !token) {
	console.error(
		'usage: ADRIVE_API_KEY=adr_… node scripts/mcp-probe.mjs <mcp-url>'
	);
	process.exit(1);
}

const parseBody = async (response) => {
	const text = await response.text();
	const payload = text.startsWith('event:')
		? text
				.split('\n')
				.filter((line) => line.startsWith('data:'))
				.map((line) => line.slice(5).trim())
				.find((line) => line.startsWith('{'))
		: text;
	if (!payload) throw new Error(`MCP response had no JSON payload: ${text}`);
	return JSON.parse(payload);
};

const rpc = async (method, params, id) => {
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			Accept: 'application/json, text/event-stream',
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			jsonrpc: '2.0',
			id,
			method,
			params
		})
	});
	return { status: response.status, body: await parseBody(response) };
};

const initialize = await rpc(
	'initialize',
	{
		protocolVersion: '2026-07-28',
		capabilities: {},
		clientInfo: { name: 'adrive-mcp-probe', version: '0.1.0' }
	},
	1
);

if (initialize.status !== 200 || initialize.body.error) {
	console.error('initialize failed', initialize.status, initialize.body);
	process.exit(1);
}

const listed = await rpc('tools/list', {}, 2);
if (listed.status !== 200 || listed.body.error) {
	console.error('tools/list failed', listed.status, listed.body);
	process.exit(1);
}

const whoami = await rpc('tools/call', { name: 'whoami', arguments: {} }, 3);
if (whoami.status !== 200 || whoami.body.error) {
	console.error('whoami failed', whoami.status, whoami.body);
	process.exit(1);
}

const tools = (listed.body.result?.tools ?? []).map((tool) => tool.name);
const text = whoami.body.result?.content?.[0]?.text;
console.log(
	JSON.stringify(
		{
			server: initialize.body.result?.serverInfo ?? null,
			tools,
			whoami: text ? JSON.parse(text) : whoami.body.result
		},
		null,
		2
	)
);
