// Shift-click anywhere on a card toggles its selection; a plain click keeps
// its normal meaning (open the file, use the menu). Returns the handlers to
// spread onto the card element.
export const shiftSelectHandlers = (
	read: () => {
		selected: boolean;
		onselect: ((selected: boolean, shift: boolean) => void) | undefined;
	}
) => {
	const isControl = (target: EventTarget | null) =>
		target instanceof Element && target.closest('button, input, select');
	return {
		onmousedown: (event: MouseEvent) => {
			// Stops the browser from extending a text selection on shift-click.
			if (event.shiftKey && read().onselect && !isControl(event.target))
				event.preventDefault();
		},
		onclick: (event: MouseEvent) => {
			const { selected, onselect } = read();
			if (!event.shiftKey || !onselect || isControl(event.target)) return;
			event.preventDefault();
			event.stopPropagation();
			onselect(!selected, true);
		}
	};
};
