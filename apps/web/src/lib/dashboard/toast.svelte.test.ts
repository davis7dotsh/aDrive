import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toasts } from './toast.svelte';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('Toasts', () => {
	it('shows, dismisses, and expires messages when HTTP omits randomUUID', () => {
		vi.stubGlobal('crypto', {
			getRandomValues: crypto.getRandomValues.bind(crypto)
		});
		expect(crypto.randomUUID).toBeUndefined();
		vi.useFakeTimers();
		const toasts = new Toasts();

		try {
			toasts.success('Upload complete');
			toasts.error(new Error('Connection lost'));
			expect(toasts.items).toMatchObject([
				{ tone: 'success', message: 'Upload complete' },
				{ tone: 'error', message: 'Connection lost' }
			]);
			const [success, error] = toasts.items;
			if (!success || !error) throw new Error('Expected both messages');
			expect(success.id).not.toBe(error.id);
			toasts.remove(success.id);
			expect(toasts.items).toEqual([error]);
			vi.advanceTimersByTime(3_999);
			expect(toasts.items).toHaveLength(1);
			vi.advanceTimersByTime(1);
			expect(toasts.items).toEqual([]);
		} finally {
			toasts.clear();
		}
	});
});
