import { Context } from 'runed';
import { ApiError, BROWSER_SESSION, checkKey } from './api';

// The browser session is a WorkOS cookie the server already validated
// when it rendered the page, so `token` is either the browser-session
// marker or empty. Sign-in and sign-out are full navigations through
// /auth/sign-in and /auth/sign-out.
export class DashboardSession {
	token = $state('');
	ready = $state(false);
	connecting = $state(false);
	error = $state('');

	constructor(browserSession = false) {
		if (browserSession) {
			this.token = BROWSER_SESSION;
		}
		this.ready = true;
	}

	// Re-checks the cookie after a client-side navigation that may have
	// outlived it (the session expired or was signed out elsewhere).
	async restore() {
		this.error = '';
		try {
			await checkKey(BROWSER_SESSION);
			this.token = BROWSER_SESSION;
		} catch (cause) {
			this.token = '';
			if (!(cause instanceof ApiError && cause.status === 401)) {
				this.error =
					cause instanceof Error
						? cause.message
						: 'Could not restore the session';
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
