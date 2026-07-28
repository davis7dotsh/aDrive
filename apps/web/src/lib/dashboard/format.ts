export const formatBytes = (bytes: number) => {
	if (bytes === 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB'];
	const unit = Math.min(
		Math.floor(Math.log(bytes) / Math.log(1024)),
		units.length - 1
	);
	const value = bytes / 1024 ** unit;
	return `${new Intl.NumberFormat(undefined, {
		maximumFractionDigits: unit === 0 ? 0 : 1
	}).format(value)} ${units[unit]}`;
};

export const formatDate = (value: string) =>
	new Intl.DateTimeFormat(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short'
	}).format(new Date(value));

export const isHtmlFile = (name: string, contentType: string) =>
	contentType === 'text/html' || /\.html?$/i.test(name);

export const copyText = async (value: string) => {
	if (navigator.clipboard) {
		try {
			await navigator.clipboard.writeText(value);
			return;
		} catch {
			// HTTP local development may expose the API but reject the write.
		}
	}
	const input = document.createElement('textarea');
	input.value = value;
	input.style.position = 'fixed';
	input.style.opacity = '0';
	document.body.appendChild(input);
	input.select();
	const copied = document.execCommand('copy');
	input.remove();
	if (!copied) throw new Error('Copy failed');
};
