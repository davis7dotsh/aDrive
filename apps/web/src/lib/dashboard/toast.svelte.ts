import { Context } from 'runed';

export type ToastItem = {
	readonly id: string;
	readonly tone: 'success' | 'error' | 'info';
	readonly message: string;
	readonly action?: {
		readonly label: string;
		readonly run: () => void | Promise<void>;
	};
};

export class Toasts {
	items = $state<ReadonlyArray<ToastItem>>([]);
	#timers = new Map<string, ReturnType<typeof setTimeout>>();

	success(message: string, action?: ToastItem['action']) {
		this.#add('success', message, action);
	}

	error(cause: unknown, fallback = 'Something went wrong') {
		this.#add(
			'error',
			cause instanceof Error ? cause.message : fallback,
			undefined
		);
	}

	info(message: string) {
		this.#add('info', message, undefined);
	}

	remove(id: string) {
		const timer = this.#timers.get(id);
		if (timer) clearTimeout(timer);
		this.#timers.delete(id);
		this.items = this.items.filter((item) => item.id !== id);
	}

	clear() {
		for (const timer of this.#timers.values()) clearTimeout(timer);
		this.#timers.clear();
		this.items = [];
	}

	#add(tone: ToastItem['tone'], message: string, action: ToastItem['action']) {
		const id = crypto.randomUUID();
		this.items = [...this.items, { id, tone, message, action }];
		this.#timers.set(
			id,
			setTimeout(() => this.remove(id), action ? 8_000 : 4_000)
		);
	}
}

export const toastContext = new Context<Toasts>('adrive.toasts');

export const createToasts = () => toastContext.set(new Toasts());
export const getToasts = () => toastContext.get();
