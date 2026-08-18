import type { RequestHandler } from './$types';
import { handleMcpRequest } from '$lib/server/mcp/handler';

export const GET: RequestHandler = (event) => handleMcpRequest(event);
export const POST: RequestHandler = (event) => handleMcpRequest(event);
export const DELETE: RequestHandler = (event) => handleMcpRequest(event);
export const OPTIONS: RequestHandler = (event) => handleMcpRequest(event);
