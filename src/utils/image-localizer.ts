import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes, Image } from 'mdast';
import { fileTypeFromBuffer } from 'file-type';
import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';

export interface LocalizeImagesOptions {
	markdown: string;
	pageBaseUrl: string;
	noteFilePath: string;
	imagesDir: string;
	imageFetcher?: ImageFetcher;
	signal?: AbortSignal;
	limits?: { maxBytes?: number; timeoutMs?: number; concurrency?: number };
}

export type ImageFetcher = (url: string, signal: AbortSignal) => Promise<AsyncIterable<Uint8Array>>;

export const fetchHttpImage: ImageFetcher = async (url, signal) => {
	const response = await fetch(url, { signal });
	if (!response.ok || !response.body) {
		await response.body?.cancel();
		throw new Error(`Image request failed: HTTP ${response.status}`);
	}
	const body = response.body;
	return (async function* () {
		const reader = body.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) return;
				yield value;
			}
		} finally {
			await reader.cancel();
			reader.releaseLock();
		}
	})();
};

export interface ImageLocalizationResult {
	markdown: string;
	saved: number;
	reused: number;
	skipped: number;
	failures: { url: string; error: string }[];
}

function visit(node: Nodes, visitor: (node: Nodes) => void): void {
	visitor(node);
	if ('children' in node) for (const child of node.children) visit(child, visitor);
}

function localLink(noteFilePath: string, imageFilePath: string): string {
	const relative = path.relative(path.dirname(noteFilePath), imageFilePath);
	if (path.isAbsolute(relative)) throw new Error('Cannot create a relative image link across filesystem volumes');
	return relative.split(path.sep)
		.map(part => encodeURIComponent(part).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`))
		.join('/');
}

function renderImage(image: Image, url: string): string {
	const alt = image.alt?.replace(/([\\\[\]])/g, '\\$1') ?? '';
	const title = image.title == null ? '' : ` "${image.title.replace(/[\\"]/g, '\\$&').replace(/\n/g, ' ')}"`;
	return `![${alt}](${url.replace(/\(/g, '%28').replace(/\)/g, '%29')}${title})`;
}

interface ImageOccurrence {
	url: string;
	start: number;
	end: number;
	render: (url: string) => string;
}

function collectImages(markdown: string): ImageOccurrence[] {
	const root = fromMarkdown(markdown);
	const definitions = new Map<string, { url: string; title?: string | null }>();
	visit(root, node => {
		if (node.type === 'definition' && !definitions.has(node.identifier.toUpperCase())) definitions.set(node.identifier.toUpperCase(), node);
	});
	const images: ImageOccurrence[] = [];
	const htmlNodes: { start: number; end: number }[] = [];
	visit(root, node => {
		if (node.type === 'image' || node.type === 'imageReference') {
			const resource = node.type === 'image' ? node : definitions.get(node.identifier.toUpperCase());
			if (resource) images.push({
				url: resource.url, start: node.position!.start.offset!, end: node.position!.end.offset!,
				render: url => renderImage({ type: 'image', url, alt: node.alt, title: resource.title }, url),
			});
		} else if (node.type === 'html') {
			htmlNodes.push({ start: node.position!.start.offset!, end: node.position!.end.offset! });
		}
	});
	// Parse HTML in one context: inline <code>, <img>, </code> are separate
	// Markdown nodes. Mask other text so offsets and surrounding tags survive.
	let cursor = 0;
	let htmlSource = '';
	for (const node of htmlNodes.sort((a, b) => a.start - b.start)) {
		htmlSource += ' '.repeat(node.start - cursor) + markdown.slice(node.start, node.end);
		cursor = node.end;
	}
	const excluded: { start: number; end: number }[] = [];
	const scan = (html: DefaultTreeAdapterMap['node']) => {
		if ('tagName' in html && ['pre', 'code', 'script', 'style'].includes(html.tagName)) {
			const location = html.sourceCodeLocation;
			if (location) excluded.push({ start: location.startOffset, end: location.endTag ? location.endOffset : markdown.length });
			return;
		}
		if ('tagName' in html && html.tagName === 'img') {
			const src = html.attrs.find(attr => attr.name === 'src');
			const location = html.sourceCodeLocation?.attrs?.src;
			if (src && location) images.push({
				url: src.value, start: location.startOffset, end: location.endOffset,
				render: url => `src="${url.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`,
			});
		}
		if ('childNodes' in html) for (const child of html.childNodes) scan(child);
	};
	scan(parseFragment(htmlSource, { sourceCodeLocationInfo: true }));
	return images.filter(image => !excluded.some(range => image.start >= range.start && image.start < range.end)).sort((a, b) => b.start - a.start);
}

function decodeDataImage(url: string, maxBytes: number): Buffer {
	const comma = url.indexOf(',');
	const metadata = url.slice(0, comma);
	if (comma < 0 || !/^data:image\//i.test(metadata)) throw new Error('Invalid image data URL');
	const payload = url.slice(comma + 1);
	let bytes: Buffer;
	if (/;base64$/i.test(metadata)) {
		if (payload.length > Math.ceil(maxBytes / 3) * 12) throw new Error('Image exceeds size limit');
		const base64 = decodeURIComponent(payload).replace(/[\t\n\f\r ]/g, '');
		if (!/^[a-z0-9+/]*={0,2}$/i.test(base64) || base64.length % 4 === 1) throw new Error('Invalid base64 image');
		if (base64.length > Math.ceil(maxBytes / 3) * 4) throw new Error('Image exceeds size limit');
		bytes = Buffer.from(base64, 'base64');
	} else {
		// Decode into one bounded buffer; percent-encoded binary data need not be UTF-8.
		const output = Buffer.allocUnsafe(Math.min(maxBytes, Buffer.byteLength(payload)));
		let length = 0;
		for (let offset = 0; offset < payload.length;) {
			if (payload[offset] === '%') {
				const hex = payload.slice(offset + 1, offset + 3);
				if (!/^[0-9a-f]{2}$/i.test(hex)) throw new Error('Invalid image data URL escape');
				if (length >= maxBytes) throw new Error('Image exceeds size limit');
				output[length++] = parseInt(hex, 16);
				offset += 3;
			} else {
				const character = String.fromCodePoint(payload.codePointAt(offset)!);
				const count = Buffer.byteLength(character);
				if (length + count > maxBytes) throw new Error('Image exceeds size limit');
				output.write(character, length, count, 'utf8');
				length += count;
				offset += character.length;
			}
		}
		bytes = output.subarray(0, length);
	}
	if (bytes.length > maxBytes) throw new Error('Image exceeds size limit');
	return bytes;
}

async function imageExtension(bytes: Buffer): Promise<string> {
	const type = await fileTypeFromBuffer(bytes);
	if (type?.mime.startsWith('image/')) return type.ext;
	const text = bytes.toString('utf-8').trim();
	if (/<\/svg\s*>\s*$|<svg\b[^>]*\/>\s*$/i.test(text)) {
		const roots = parseFragment(text).childNodes.filter(node => node.nodeName !== '#comment' && !(node.nodeName === '#text' && 'value' in node && !node.value.trim()));
		if (roots.length === 1 && 'tagName' in roots[0] && roots[0].tagName === 'svg') return 'svg';
	}
	throw new Error('Resource is not a supported image');
}

async function isLocalImage(url: string, noteFilePath: string): Promise<boolean> {
	if (/^(?:file:|[a-z]:[\\/]|\\\\)/i.test(url)) return true;
	if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(url)) return false;
	try {
		return (await fs.stat(path.resolve(path.dirname(noteFilePath), decodeURIComponent(url.split(/[?#]/)[0])))).isFile();
	} catch { return false; }
}

async function saveImage(imagePath: string, bytes: Buffer): Promise<boolean> {
	try {
		const existing = await fs.readFile(imagePath);
		if (!existing.equals(bytes)) throw new Error('Existing image does not match its content hash');
		return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	const temporary = path.join(path.dirname(imagePath), `.clipper-${randomUUID()}.tmp`);
	try {
		await fs.writeFile(temporary, bytes, { flag: 'wx' });
		await fs.rename(temporary, imagePath);
		return true;
	} finally {
		await fs.rm(temporary, { force: true });
	}
}

/** Localize images in rendered note content while preserving other text. */
export async function localizeImages(options: LocalizeImagesOptions): Promise<ImageLocalizationResult> {
	options.signal?.throwIfAborted();
	await fs.mkdir(options.imagesDir, { recursive: true });
	// A directory-wide write failure is fatal even when the note has no images.
	const probe = path.join(options.imagesDir, `.clipper-${randomUUID()}.tmp`);
	try { await fs.writeFile(probe, '', { flag: 'wx' }); }
	finally { await fs.rm(probe, { force: true }); }
	const result: ImageLocalizationResult = { markdown: options.markdown, saved: 0, reused: 0, skipped: 0, failures: [] };
	const images = collectImages(options.markdown);
	const maxBytes = options.limits?.maxBytes ?? 20 * 1024 * 1024;
	const timeoutMs = options.limits?.timeoutMs ?? 30000;
	const concurrency = options.limits?.concurrency ?? 4;
	if (![maxBytes, timeoutMs, concurrency].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Image limits must be positive integers');
	const resources = new Map<string, string | undefined>();
	const resolved = new Map<ImageOccurrence, { url: string; fragment: string }>();
	for (const image of images) {
		if (await isLocalImage(image.url, options.noteFilePath)) { result.skipped++; continue; }
		try {
			const url = new URL(image.url, options.pageBaseUrl);
			const fragment = url.hash;
			url.hash = '';
			resolved.set(image, { url: url.href, fragment });
			resources.set(url.href, undefined);
		} catch (error) {
			result.failures.push({ url: image.url, error: (error as Error).message });
		}
	}
	const urls = [...resources.keys()];
	const files = new Map<string, Promise<boolean>>();
	const cancellation = new AbortController();
	const abort = () => cancellation.abort(options.signal?.reason ?? new Error('Image download cancelled'));
	options.signal?.addEventListener('abort', abort, { once: true });
	if (options.signal?.aborted) abort();
	let next = 0;
	const download = async (url: string) => {
		const controller = new AbortController();
		const onAbort = () => controller.abort(cancellation.signal.reason);
		cancellation.signal.addEventListener('abort', onAbort, { once: true });
		const timer = setTimeout(() => controller.abort(new Error('Image download timed out')), timeoutMs);
		let bytes: Buffer;
		let extension: string;
		try {
			controller.signal.throwIfAborted();
			if (url.startsWith('data:')) bytes = decodeDataImage(url, maxBytes);
			else {
				if (!/^https?:\/\//i.test(url)) throw new Error('Unsupported image URL protocol');
				const chunks: Uint8Array[] = [];
				let length = 0;
				for await (const chunk of await (options.imageFetcher ?? fetchHttpImage)(url, controller.signal)) {
					controller.signal.throwIfAborted();
					length += chunk.byteLength;
					if (length > maxBytes) throw new Error('Image exceeds size limit');
					chunks.push(chunk);
				}
				bytes = Buffer.concat(chunks);
			}
			extension = await imageExtension(bytes);
			controller.signal.throwIfAborted();
		} catch (error) {
			if (cancellation.signal.aborted) throw cancellation.signal.reason;
			result.failures.push({ url, error: controller.signal.aborted ? String(controller.signal.reason.message) : (error as Error).message });
			return;
		} finally {
			clearTimeout(timer);
			cancellation.signal.removeEventListener('abort', onAbort);
		}
		const filename = `${createHash('sha256').update(bytes).digest('hex')}.${extension}`;
		const imagePath = path.join(options.imagesDir, filename);
		const existing = files.get(filename);
		if (existing) { await existing; result.reused++; }
		else {
			const saved = saveImage(imagePath, bytes);
			files.set(filename, saved);
			if (await saved) result.saved++; else result.reused++;
		}
		resources.set(url, imagePath);
	};
	try {
		const workers = Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
			try {
				while (!cancellation.signal.aborted && next < urls.length) await download(urls[next++]);
			} catch (error) { cancellation.abort(error); throw error; }
		});
		const settled = await Promise.allSettled(workers);
		const failure = settled.find(worker => worker.status === 'rejected');
		if (failure?.status === 'rejected') throw failure.reason;
		cancellation.signal.throwIfAborted();
	} finally {
		options.signal?.removeEventListener('abort', abort);
	}
	for (const image of images) {
		const source = resolved.get(image);
		if (!source) continue;
		const file = resources.get(source.url);
		const link = file ? localLink(options.noteFilePath, file) + source.fragment : source.url + source.fragment;
		if (link !== image.url) result.markdown = result.markdown.slice(0, image.start) + image.render(link) + result.markdown.slice(image.end);
	}
	return result;
}
