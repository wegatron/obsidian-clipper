import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { localizeImages } from './image-localizer';
import { startImageServer } from './fixtures/image-server';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=', 'base64');
const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
let directory: string;
let server: Awaited<ReturnType<typeof startImageServer>>;

beforeAll(async () => { server = await startImageServer(); });
afterAll(async () => { await server?.close(); });

beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clipper-images-')); server.requests.length = 0; });
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

test('saves an embedded image and rewrites only its image reference', async () => {
	const imageDir = path.join(directory, 'images');
	const result = await localizeImages({
		markdown: `# Article\n\n![plot](${dataUrl})\n\n\`![example](${dataUrl})\`\n`,
		pageBaseUrl: 'https://example.com/article',
		noteFilePath: path.join(directory, 'article.md'),
		imagesDir: imageDir,
	});
	const [filename] = await fs.readdir(imageDir);
	expect(filename).toMatch(/^[a-f0-9]{64}\.png$/);
	expect(await fs.readFile(path.join(imageDir, filename))).toEqual(png);
	expect(result.markdown).toBe(`# Article\n\n![plot](images/${filename})\n\n\`![example](${dataUrl})\`\n`);
	expect(result.saved).toBe(1);
	expect(result.failures).toEqual([]);
});

test('downloads relative and redirected images, preserving signatures and deduplicating bytes', async () => {
	const result = await localizeImages({
		markdown: '![first](/picture.png?signature=keep)\n![again](/picture.png?signature=keep)\n![same](/same.png)\n![redirect](/redirect.png)',
		pageBaseUrl: `${server.url}/article`,
		noteFilePath: path.join(directory, 'article.md'),
		imagesDir: path.join(directory, 'images'),
	});
	const files = await fs.readdir(path.join(directory, 'images'));
	expect(files).toHaveLength(1);
	expect(await fs.readFile(path.join(directory, 'images', files[0]))).toEqual(png);
	expect(result.markdown.match(/images\/[a-f0-9]{64}\.png/g)).toHaveLength(4);
	expect(server.requests.filter(url => url === '/picture.png?signature=keep')).toHaveLength(2);
	expect(result.saved).toBe(1);
	expect(result.reused).toBe(2);
	expect(result.failures).toEqual([]);
});

test('localizes reference and HTML images without changing shared links or code examples', async () => {
	const markdown = `![reference][shared]\n[website][shared]\n\n[shared]: ${server.url}/picture.png "title"\n\n<img alt="html" src="${server.url}/same.png?x=1&amp;y=2" width="600">\n\n\`![code](${server.url}/other.svg)\`\n\n\`\`\`md\n![code](${server.url}/other.svg)\n\`\`\`\n`;
	const result = await localizeImages({ markdown, pageBaseUrl: server.url, noteFilePath: path.join(directory, 'article.md'), imagesDir: path.join(directory, '图 片(1)') });
	const [filename] = await fs.readdir(path.join(directory, '图 片(1)'));
	const link = `%E5%9B%BE%20%E7%89%87%281%29/${filename}`;
	expect(result.markdown).toContain(`![reference](${link} "title")`);
	expect(result.markdown).toContain(`[website][shared]\n\n[shared]: ${server.url}/picture.png "title"`);
	expect(result.markdown).toContain(`<img alt="html" src="${link}" width="600">`);
	expect(result.markdown).toContain(`\`![code](${server.url}/other.svg)\``);
	expect(result.markdown).toContain(`\`\`\`md\n![code](${server.url}/other.svg)\n\`\`\``);
	expect(server.requests).toContain('/same.png?x=1&y=2');
});

test('retains failed remote references and existing local images, while saving valid SVG', async () => {
	await fs.writeFile(path.join(directory, 'local.png'), png);
	const markdown = '![svg](/other.svg)\n![missing](/missing.png)\n![login](/fake.png)\n![blob](blob:https://example.com/id)\n![local](local.png)\n';
	const result = await localizeImages({ markdown, pageBaseUrl: server.url, noteFilePath: path.join(directory, 'article.md'), imagesDir: path.join(directory, 'images') });
	expect(result.markdown).toMatch(/!\[svg\]\(images\/[a-f0-9]{64}\.svg\)/);
	expect(result.markdown).toContain(`![missing](${server.url}/missing.png)`);
	expect(result.markdown).toContain(`![login](${server.url}/fake.png)`);
	expect(result.markdown).toContain('![blob](blob:https://example.com/id)\n![local](local.png)');
	expect(result.failures).toHaveLength(3);
	expect(result.skipped).toBe(1);
	expect(await fs.readdir(path.join(directory, 'images'))).toHaveLength(1);
});

test('bounds streaming downloads and leaves no partial files on timeout or size limit', async () => {
	const result = await localizeImages({
		markdown: '![large](/picture.png)\n![slow](/slow.png)', pageBaseUrl: server.url,
		noteFilePath: path.join(directory, 'article.md'), imagesDir: path.join(directory, 'images'),
		limits: { maxBytes: 20, timeoutMs: 100 },
	});
	expect(result.failures.map(failure => failure.error).join(' ')).toMatch(/size limit/);
	expect(result.failures.map(failure => failure.error).join(' ')).toMatch(/timed out/);
	expect(result.failures).toHaveLength(2);
	expect(await fs.readdir(path.join(directory, 'images'))).toEqual([]);
});

test('treats a non-directory output as a fatal error even without any images', async () => {
	const output = path.join(directory, 'images');
	await fs.writeFile(output, 'existing file');
	await expect(localizeImages({ markdown: '# Text', pageBaseUrl: server.url, noteFilePath: path.join(directory, 'article.md'), imagesDir: output })).rejects.toThrow();
	expect(await fs.readFile(output, 'utf-8')).toBe('existing file');
});


test('preserves distinct fragments with one request and reuses existing content files on subsequent runs', async () => {
	const options = { markdown: '![a](/other.svg#icon)\n![b](/other.svg#icon(two))\n![red](/other.svg?color=red)', pageBaseUrl: server.url, noteFilePath: path.join(directory, 'notes', 'article.md'), imagesDir: path.join(directory, 'images') };
	const first = await localizeImages(options);
	expect(first.failures).toEqual([]);
	expect(first.markdown).toContain('#icon%28two%29)');
	expect(server.requests.filter(url => url === '/other.svg')).toHaveLength(1);
	expect(await fs.readdir(options.imagesDir)).toHaveLength(2);
	const second = await localizeImages(options);
	expect(second.saved).toBe(0);
	expect(second.reused).toBe(2);
	expect(second.markdown).toBe(first.markdown);
	await fs.mkdir(path.dirname(options.noteFilePath));
	await fs.writeFile(options.noteFilePath, first.markdown);
	const relocated = `${directory}-moved`;
	await fs.rename(directory, relocated);
	directory = relocated;
	const link = first.markdown.match(/!\[a\]\(([^)#]+)#icon\)/)![1];
	expect(await fs.readFile(path.resolve(directory, 'notes', decodeURIComponent(link)), 'utf8')).toContain('<svg');
});

test('decodes percent-encoded SVG and enforces the limit on decoded bytes', async () => {
	const image = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
	const options = { markdown: `![embedded](data:image/svg+xml,${encodeURIComponent(image)})`, pageBaseUrl: server.url, noteFilePath: path.join(directory, 'note.md'), imagesDir: path.join(directory, 'images') };
	const result = await localizeImages(options);
	expect(result.failures).toEqual([]);
	const [filename] = await fs.readdir(options.imagesDir);
	expect(await fs.readFile(path.join(options.imagesDir, filename), 'utf8')).toBe(image);
	const oversized = await localizeImages({ ...options, imagesDir: path.join(directory, 'too-small'), limits: { maxBytes: 20 } });
	expect(oversized.failures[0].error).toContain('size limit');
	expect(await fs.readdir(path.join(directory, 'too-small'))).toEqual([]);
});

test('rejects external cancellation and cleans up incomplete image files', async () => {
	const cancellation = new AbortController();
	const operation = localizeImages({ markdown: '![slow](/slow.png)', pageBaseUrl: server.url, noteFilePath: path.join(directory, 'note.md'), imagesDir: path.join(directory, 'images'), signal: cancellation.signal });
	const assertion = expect(operation).rejects.toThrow('cancelled');
	setTimeout(() => cancellation.abort(new Error('cancelled')), 50);
	await assertion;
	expect(await fs.readdir(path.join(directory, 'images'))).toEqual([]);
});


test('keeps HTML code context across inline nodes and downloads only visible images', async () => {
	const markdown = '<code><img src="/picture.png"></code>\n\n<code>![code](/picture.png)</code>\n\n<img src="/other.svg">';
	const result = await localizeImages({ markdown, pageBaseUrl: server.url, noteFilePath: path.join(directory, 'note.md'), imagesDir: path.join(directory, 'images') });
	expect(result.markdown).toContain('<code><img src="/picture.png"></code>');
	expect(result.markdown).toContain('<code>![code](/picture.png)</code>');
	expect(server.requests).toEqual(['/other.svg']);
	expect(result.saved).toBe(1);
});

test('decodes percent-escaped base64 and separates data SVG fragments from download bytes', async () => {
	const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
	const source = `data:image/svg+xml,${encodeURIComponent(svg)}`;
	const result = await localizeImages({ markdown: `![png](${dataUrl.replace(/=/g, '%3D')})\n![a](${source}#a)\n![b](${source}#b)`, pageBaseUrl: server.url, noteFilePath: path.join(directory, 'note.md'), imagesDir: path.join(directory, 'images') });
	expect(result.failures).toEqual([]);
	expect(result.markdown).toMatch(/images\/[a-f0-9]{64}\.svg#a/);
	expect(result.markdown).toMatch(/images\/[a-f0-9]{64}\.svg#b/);
	expect(result.saved).toBe(2);
	expect(await fs.readdir(path.join(directory, 'images'))).toHaveLength(2);
});


test('preserves HTML source offsets inside blockquotes and lists', async () => {
	const markdown = `> <div>\n> <img src="${server.url}/picture.png">\n> </div>\n\n- <div>\n  <img src="${server.url}/picture.png">\n  </div>`;
	const result = await localizeImages({ markdown, pageBaseUrl: server.url, noteFilePath: path.join(directory, 'note.md'), imagesDir: path.join(directory, 'images') });
	const [filename] = await fs.readdir(path.join(directory, 'images'));
	expect(result.markdown).toBe(markdown.split(`${server.url}/picture.png`).join(`images/${filename}`));
	expect(server.requests).toEqual(['/picture.png']);
});
