// Select the stronger WCAG contrast against a validated custom tag color.
// An absent color leaves the theme's default foreground in charge.
export const tagForeground = (color: string | null | undefined) => {
	if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return undefined;
	const channel = (offset: number) => {
		const value = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	const luminance =
		0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
	return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05)
		? '#000000'
		: '#ffffff';
};
