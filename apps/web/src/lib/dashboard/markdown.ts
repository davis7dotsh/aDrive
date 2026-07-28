import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({
	html: false,
	linkify: true,
	typographer: true
});

export const renderMarkdown = (source: string) => markdown.render(source);
