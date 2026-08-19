import { createMcpHandler } from 'agents/mcp/server';
import { McpServer } from '@modelcontextprotocol/server';
import type { RequestEvent } from '@sveltejs/kit';
import { Effect } from 'effect';
import { Auth } from '../services/auth';
import {
	authorizeMcp,
	mcpAuthFailureResponse,
	mcpUnauthorizedResponse
} from './auth';
import { runMcp } from './run';
import { createAdriveMcpServer } from './server';

export const mcpAllowedHostnames = (dashboardOrigin: string) => {
	const hostname = new URL(dashboardOrigin).hostname;
	return [...new Set([hostname, 'localhost', '127.0.0.1'])];
};

const handlerOptions = (dashboardOrigin: string) => ({
	route: '/mcp',
	responseMode: 'json' as const,
	allowedHostnames: mcpAllowedHostnames(dashboardOrigin),
	allowedOriginHostnames: mcpAllowedHostnames(dashboardOrigin)
});

export const handleMcpRequest = async (event: RequestEvent) => {
	const env = event.platform?.env;
	const ctx = event.platform?.ctx;
	if (!env || !ctx) {
		return new Response('Cloudflare bindings unavailable', { status: 500 });
	}

	if (event.request.method === 'OPTIONS') {
		return createMcpHandler(
			() => new McpServer({ name: 'adrive', version: '0.1.0' }),
			handlerOptions(env.DASHBOARD_ORIGIN)
		)(event.request, env, ctx);
	}

	const authorized = await runMcp(
		env,
		Effect.gen(function* () {
			const auth = yield* Auth;
			return yield* authorizeMcp(auth, event.request, event.url);
		})
	);
	if (!authorized.ok) {
		return authorized.status === 401
			? mcpUnauthorizedResponse(authorized.message)
			: mcpAuthFailureResponse(authorized.message, authorized.status);
	}

	return createMcpHandler(
		() =>
			createAdriveMcpServer({
				env,
				ctx,
				credential: authorized.value
			}),
		handlerOptions(env.DASHBOARD_ORIGIN)
	)(event.request, env, ctx);
};
