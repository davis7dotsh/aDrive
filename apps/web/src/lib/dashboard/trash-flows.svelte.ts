import type { DashboardFile } from '@adrive/shared';
import { emptyTrash, mutateFile } from './api';
import type { Toasts } from './toast.svelte';

type TrashFlowsDeps = {
	readonly session: {
		readonly token: string;
	};
	readonly toasts: Toasts;
	readonly refetch: () => Promise<unknown>;
	readonly clearSelection: () => void;
	readonly onRemove: (file: DashboardFile) => void;
};

export const createTrashFlows = ({
	session,
	toasts,
	refetch,
	clearSelection,
	onRemove
}: TrashFlowsDeps) => {
	let purgeTarget = $state<DashboardFile>();
	let purgeOpen = $state(false);
	let emptyTrashOpen = $state(false);
	let bulkPurgeOpen = $state(false);
	let purging = $state(false);

	const changeState = async (
		file: DashboardFile,
		action: 'trash' | 'restore'
	) => {
		const token = session.token;
		try {
			await mutateFile(token, file.id, { action });
			if (session.token !== token) return;
			onRemove(file);
			if (action === 'trash') {
				toasts.success('Moved to trash', {
					label: 'Undo',
					run: async () => {
						await mutateFile(token, file.id, { action: 'restore' });
						await refetch();
					}
				});
			} else {
				toasts.success('File restored');
			}
		} catch (cause) {
			if (session.token === token) {
				toasts.error(cause, 'Could not update the file');
			}
		}
	};

	const purgeFiles = async (targets: ReadonlyArray<DashboardFile>) => {
		if (purging || targets.length === 0) return;
		const token = session.token;
		purging = true;
		try {
			const outcomes = await Promise.allSettled(
				targets.map((file) => mutateFile(token, file.id, { action: 'purge' }))
			);
			await refetch();
			if (session.token !== token) return;
			const failed = outcomes.filter(
				(outcome) => outcome.status === 'rejected'
			).length;
			if (failed > 0) {
				toasts.error(
					new Error(
						`${failed} ${failed === 1 ? 'file was' : 'files were'} not deleted`
					)
				);
			} else {
				toasts.success(
					targets.length === 1
						? 'Permanent deletion started'
						: 'Empty trash started'
				);
				purgeTarget = undefined;
				purgeOpen = false;
				emptyTrashOpen = false;
				bulkPurgeOpen = false;
			}
		} finally {
			purging = false;
		}
	};

	const purgeAllTrash = async () => {
		if (purging) return;
		const token = session.token;
		purging = true;
		try {
			await emptyTrash(token);
			await refetch();
			if (session.token !== token) return;
			clearSelection();
			emptyTrashOpen = false;
			toasts.success('Empty trash started');
		} catch (cause) {
			if (session.token === token) {
				toasts.error(cause, 'Could not empty trash');
			}
		} finally {
			purging = false;
		}
	};

	return {
		get purgeTarget() {
			return purgeTarget;
		},
		set purgeTarget(value: DashboardFile | undefined) {
			purgeTarget = value;
		},
		get purgeOpen() {
			return purgeOpen;
		},
		set purgeOpen(value: boolean) {
			purgeOpen = value;
		},
		get emptyTrashOpen() {
			return emptyTrashOpen;
		},
		set emptyTrashOpen(value: boolean) {
			emptyTrashOpen = value;
		},
		get bulkPurgeOpen() {
			return bulkPurgeOpen;
		},
		set bulkPurgeOpen(value: boolean) {
			bulkPurgeOpen = value;
		},
		get purging() {
			return purging;
		},
		changeState,
		purgeFiles,
		purgeAllTrash,
		openPurge: (file: DashboardFile) => {
			purgeTarget = file;
			purgeOpen = true;
		}
	};
};
