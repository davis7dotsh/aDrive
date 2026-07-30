import { Context } from 'runed';
import {
	ApiError,
	BROWSER_SESSION,
	checkKey,
	loginWithPasscode,
	logoutSession
} from './api';

const SESSION_KEY = 'adrive.dashboard.api-key';

const readSavedKey = () => {
	try {
		return sessionStorage.getItem(SESSION_KEY) ?? '';
	} catch {
		return '';
	}
};

const saveKey = (value: string) => {
	try {
		if (value) sessionStorage.setItem(SESSION_KEY, value);
		else sessionStorage.removeItem(SESSION_KEY);
	} catch {
		// Storage can be unavailable in privacy-restricted browser contexts.
	}
};

export class DashboardSession {
	token = $state('');
	ready = $state(false);
	connecting = $state(false);
	error = $state('');

	constructor(browserSession = false) {
		if (browserSession) {
			this.token = BROWSER_SESSION;
			this.ready = true;
		}
	}

	async connect(value: string) {
		this.connecting = true;
		this.error = '';
		try {
			await loginWithPasscode(value.trim());
			await checkKey(BROWSER_SESSION);
			saveKey('');
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
			saveKey(next);
			this.token = next;
		} catch (cause) {
			this.error =
				cause instanceof Error ? cause.message : 'Could not verify the API key';
		} finally {
			this.connecting = false;
		}
	}

	async disconnect() {
		if (this.connecting || !this.token) return false;
		this.connecting = true;
		this.error = '';
		try {
			if (this.token === BROWSER_SESSION) await logoutSession();
			saveKey('');
			this.token = '';
			return true;
		} catch (cause) {
			this.error =
				cause instanceof Error ? cause.message : 'Could not sign out';
			return false;
		} finally {
			this.connecting = false;
		}
	}

	async restore() {
		if (this.ready) return;
		this.error = '';
		const savedKey = readSavedKey();
		try {
			if (savedKey) {
				try {
					await checkKey(savedKey);
					this.token = savedKey;
					return;
				} catch (cause) {
					saveKey('');
					if (!(cause instanceof ApiError && cause.status === 401)) {
						this.error =
							cause instanceof Error
								? cause.message
								: 'Could not restore the API key';
					}
				}
			}
			try {
				await checkKey(BROWSER_SESSION);
				this.token = BROWSER_SESSION;
				this.error = '';
			} catch (cause) {
				this.token = '';
				if (!(cause instanceof ApiError && cause.status === 401)) {
					this.error =
						cause instanceof Error
							? cause.message
							: 'Could not restore the session';
				}
			}
		} finally {
			this.ready = true;
		}
	}
}

export const sessionContext = new Context<DashboardSession>('adrive.session');

export const createDashboardSession = (browserSession = false) =>
	sessionContext.set(new DashboardSession(browserSession));

export const getDashboardSession = () => sessionContext.get();
