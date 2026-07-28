declare global {
	interface Env {
		PASSCODE: string;
	}

	namespace Cloudflare {
		interface Env {
			PASSCODE: string;
		}
	}
}

export {};
