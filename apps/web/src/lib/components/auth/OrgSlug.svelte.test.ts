import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OrgSlug from './OrgSlug.svelte';

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn() }));
vi.mock('$lib/dashboard/api', () => ({ changeOrgSlug: vi.fn() }));
vi.mock('$lib/dashboard/toast.svelte', () => ({
	getToasts: () => ({ success: vi.fn(), error: vi.fn() })
}));

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-09-10T12:00:00.000Z'));
});

afterEach(() => {
	vi.useRealTimers();
});

const render = (cooldownMs: number) => {
	const target = document.createElement('div');
	document.body.appendChild(target);
	const component = mount(OrgSlug, {
		target,
		props: {
			token: 'test-token',
			org: {
				id: 'org-test',
				name: 'Test org',
				slug: 'current-slug',
				contentOrigin: 'https://current-slug.content.test',
				nextSlugChangeAt: new Date(Date.now() + cooldownMs).toISOString()
			},
			onchanged: vi.fn()
		}
	});
	flushSync();
	return {
		target,
		cleanup: async () => {
			await unmount(component);
			target.remove();
		}
	};
};

describe('org slug cooldown', () => {
	it.each([1_000, 30 * 24 * 60 * 60 * 1_000])(
		'unlocks controls and updates copy when a %s ms cooldown expires',
		async (duration) => {
			const { target, cleanup } = render(duration);
			try {
				const input = target.querySelector('input');
				const submit = target.querySelector('button');
				if (!input || !submit) throw new Error('Slug controls did not render');
				expect(input.disabled).toBe(true);
				expect(target.textContent).toContain('Changed recently');
				await vi.advanceTimersByTimeAsync(duration - 1);
				flushSync();
				expect(input.disabled).toBe(true);
				await vi.advanceTimersByTimeAsync(1);
				flushSync();
				expect(input.disabled).toBe(false);
				expect(target.textContent).toContain('Once per 30 days');
				expect(target.textContent).not.toContain('Changed recently');
				input.value = 'next-slug';
				input.dispatchEvent(new Event('input', { bubbles: true }));
				flushSync();
				expect(submit.disabled).toBe(false);
			} finally {
				await cleanup();
			}
		}
	);

	it('cancels the pending cooldown timer when unmounted', async () => {
		const { cleanup } = render(30 * 24 * 60 * 60 * 1_000);
		try {
			expect(vi.getTimerCount()).toBe(1);
		} finally {
			await cleanup();
		}
		expect(vi.getTimerCount()).toBe(0);
	});
});
