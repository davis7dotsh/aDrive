import { Context } from 'runed';
import {
	BROWSER_SESSION,
	checkKey,
	loginWithPasscode,
	logoutSession
} from './api';

const SESSION_KEY = 'adrive.dashboard.api-key';

export class DashboardSession {
	token = $state('');
	ready = $state(false);
	connecting = $state(false);
	error = $state('');

	async connect(value: string) {
		this.connecting = true;
		this.error = '';
		try {
			await loginWithPasscode(value.trim());
			sessionStorage.removeItem(SESSION_KEY);
			this.token = BROWSER_SESSION;
		} catch (cause) {
			const message =
				cause instanceof Error
					? cause.message
					: 'Could not verify the passcode';
			this.error =
				location.protocol === 'http:'
					? `${message}. This plain-HTTP origin cannot keep the secure session cookie; sign in with an API key instead.`
					: message;
		} finally {
			this.connecting = false;
		}
	}

	async connectApiKey(value: string) {
		const next = value.trim();
		this.connecting = true;
		this.error = '';
		try {
			await checkKey(next);
			sessionStorage.setItem(SESSION_KEY, next);
			this.token = next;
		} catch (cause) {
			this.error =
				cause instanceof Error ? cause.message : 'Could not verify the API key';
		} finally {
			this.connecting = false;
		}
	}

	disconnect() {
		if (this.token === BROWSER_SESSION) void logoutSession();
		sessionStorage.removeItem(SESSION_KEY);
		this.token = '';
		this.error = '';
	}

	async restore() {
		const savedKey = sessionStorage.getItem(SESSION_KEY);
		if (savedKey) {
			this.token = savedKey;
		} else {
			try {
				await checkKey(BROWSER_SESSION);
				this.token = BROWSER_SESSION;
			} catch {
				this.token = '';
			}
		}
		this.ready = true;
	}
}

export const sessionContext = new Context<DashboardSession>('adrive.session');

export const createDashboardSession = () =>
	sessionContext.set(new DashboardSession());

export const getDashboardSession = () => sessionContext.get();
