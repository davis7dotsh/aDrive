import { createMcpHandler } from 'agents/mcp/server';
import { describe, expect, it } from 'vitest';
import { mcpAllowedHostnames } from './handler';
import {
	READ_TOOL_NAMES,
	WRITE_TOOL_NAMES,
	createAdriveMcpServer
} from './server';

const env = {
	DASHBOARD_ORIGIN: 'https://drive.example.com'
} as Env;

const ctx = {
	waitUntil: (promise: Promise<unknown>) => {
		void promise;
	},
	passThroughOnException: () => undefined,
	props: {}
} as ExecutionContext;

const parseRpcBody = async (response: Response) => {
	const text = await response.text();
	const payload = text.startsWith('event:')
		? text
				.split('\n')
				.filter((line) => line.startsWith('data:'))
				.map((line) => line.slice(5).trim())
				.find((line) => line.startsWith('{'))
		: text;
	if (!payload) throw new Error(`MCP response had no JSON payload: ${text}`);
	return JSON.parse(payload) as {
		result?: {
			tools?: Array<{ name: string }>;
			serverInfo?: { name: string };
		};
		error?: { message: string };
	};
};

const rpc = async (scope: 'read-only' | 'read-write', body: unknown) => {
	const handler = createMcpHandler(
		() =>
			createAdriveMcpServer({
				env,
				ctx,
				credential: {
					credentialId: 'key-1',
					kind: 'api-key',
					scope,
					restriction: { tagIds: null, fileIds: null }
				}
			}),
		{
			route: '/mcp',
			responseMode: 'json',
			allowedHostnames: mcpAllowedHostnames(env.DASHBOARD_ORIGIN),
			allowedOriginHostnames: mcpAllowedHostnames(env.DASHBOARD_ORIGIN)
		}
	);
	const response = await handler(
		new Request('https://drive.example.com/mcp', {
			method: 'POST',
			headers: {
				Host: 'drive.example.com',
				Accept: 'application/json, text/event-stream',
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(body)
		}),
		env,
		ctx
	);
	return {
		status: response.status,
		body: await parseRpcBody(response)
	};
};

describe('MCP server factory', () => {
	it('initializes over streamable HTTP', async () => {
		const { status, body } = await rpc('read-only', {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2026-07-28',
				capabilities: {},
				clientInfo: { name: 'adrive-test', version: '0.0.0' }
			}
		});
		expect(status).toBe(200);
		expect(body.error).toBeUndefined();
		expect(body.result?.serverInfo?.name).toBe('adrive');
	});

	it('lists only read tools for a read-only key', async () => {
		const { body } = await rpc('read-only', {
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/list',
			params: {}
		});
		const names = (body.result?.tools ?? []).map((tool) => tool.name);
		expect(names.sort()).toEqual([...READ_TOOL_NAMES].sort());
		expect(
			names.some((name) =>
				WRITE_TOOL_NAMES.includes(name as (typeof WRITE_TOOL_NAMES)[number])
			)
		).toBe(false);
	});

	it('lists write tools for a read-write key', async () => {
		const { body } = await rpc('read-write', {
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/list',
			params: {}
		});
		const names = (body.result?.tools ?? []).map((tool) => tool.name);
		expect(names).toEqual(expect.arrayContaining([...READ_TOOL_NAMES]));
		expect(names).toEqual(expect.arrayContaining([...WRITE_TOOL_NAMES]));
	});
});
