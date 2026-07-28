import { getContext, setContext } from 'svelte';
import { checkKey } from './api';

const SESSION_KEY = 'adrive.dashboard.api-key';
const CONTEXT_KEY = Symbol('adrive.dashboard.session');

export interface DashboardSession {
	readonly token: string;
	readonly ready: boolean;
	readonly connecting: boolean;
	readonly error: string;
	readonly connect: (token: string) => Promise<void>;
	readonly disconnect: () => void;
	readonly restore: () => void;
}

export const createDashboardSession = () => {
	let token = $state('');
	let ready = $state(false);
	let connecting = $state(false);
	let error = $state('');

	const session: DashboardSession = {
		get token() {
			return token;
		},
		get ready() {
			return ready;
		},
		get connecting() {
			return connecting;
		},
		get error() {
			return error;
		},
		async connect(value) {
			const next = value.trim();
			connecting = true;
			error = '';
			try {
				await checkKey(next);
				sessionStorage.setItem(SESSION_KEY, next);
				token = next;
			} catch (cause) {
				error =
					cause instanceof Error
						? cause.message
						: 'Could not verify the API key';
			} finally {
				connecting = false;
			}
		},
		disconnect() {
			sessionStorage.removeItem(SESSION_KEY);
			token = '';
			error = '';
		},
		restore() {
			token = sessionStorage.getItem(SESSION_KEY) ?? '';
			ready = true;
		}
	};
	setContext(CONTEXT_KEY, session);
	return session;
};

export const getDashboardSession = () =>
	getContext<DashboardSession>(CONTEXT_KEY);
