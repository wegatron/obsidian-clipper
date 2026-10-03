import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startImageServer, png } from './utils/fixtures/image-server';

const root = path.resolve(__dirname, '..');
let outputDir: string;
let server: Awaited<ReturnType<typeof startImageServer>>;
const execute = promisify(execFile);

beforeAll(async () => {
	execFileSync(process.execPath, [path.join(root, 'scripts/build-cli.mjs')], { cwd: root, stdio: 'pipe' });
	outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipper-cli-test-'));
	server = await startImageServer();
});

afterAll(async () => {
	await server?.close();
	if (outputDir) fs.rmSync(outputDir, { recursive: true, force: true });
});

describe('CLI image downloads', () => {
	test('downloads images from a redirected page and prints only the note path', async () => {
		const directory = path.join(outputDir, 'redirected');
		const images = path.join(directory, 'attachments');
		const { stdout, stderr } = await execute(process.execPath, [path.join(root, 'dist/cli.cjs'), `${server.url}/start`, '-o', directory, '--images-dir', images]);
		const filePath = stdout.trim();
		expect(filePath).toBe(path.join(directory, 'Image Article.md'));
		const [filename] = fs.readdirSync(images);
		expect(fs.readFileSync(path.join(images, filename))).toEqual(png);
		expect(fs.readFileSync(filePath, 'utf-8')).toContain(`attachments/${filename}`);
		expect(stderr).toContain('Images:');
		expect(stdout.split('\n')).toHaveLength(2);
	});

	test('keeps a failed template image in default mode and preserves an existing note in strict mode', async () => {
		const templatePath = path.join(outputDir, 'image-template.json');
		fs.writeFileSync(templatePath, JSON.stringify({ id: 'test', name: 'Test', behavior: 'create', noteNameFormat: 'Template images', path: '', properties: [{ name: 'image', value: `${server.url}/other.svg` }], noteContentFormat: '![good](/picture.png)\n![bad](/missing.png)' }));
		const images = path.join(outputDir, 'template-images');
		const defaultNote = path.join(outputDir, 'default.md');
		const args = [path.join(root, 'dist/cli.cjs'), server.url, '--html', path.join(root, 'src/utils/fixtures/templates/minimal.html'), '-t', templatePath, '--images-dir', images];
		const { stdout, stderr } = await execute(process.execPath, [...args, '-o', defaultNote]);
		expect(stdout.trim()).toBe(defaultNote);
		expect(fs.readFileSync(defaultNote, 'utf-8')).toContain(`![bad](${server.url}/missing.png)`);
		expect(fs.readFileSync(defaultNote, 'utf-8')).toContain(`${server.url}/other.svg`);
		expect(stderr).toContain('1 failed');
		const strictNote = path.join(outputDir, 'strict.md');
		fs.writeFileSync(strictNote, 'existing note');
		await expect(execute(process.execPath, [...args, '-o', strictNote, '--images-strict'])).rejects.toMatchObject({ code: 1, stdout: '' });
		expect(fs.readFileSync(strictNote, 'utf-8')).toBe('existing note');
		const missingNote = path.join(outputDir, 'not-created.md');
		await expect(execute(process.execPath, [...args, '-o', missingNote, '--images-strict'])).rejects.toMatchObject({ code: 1, stdout: '' });
		expect(fs.existsSync(missingNote)).toBe(false);
	});

	test('resolves HTML base URLs and treats a broken image directory as a fatal output error', async () => {
		const html = path.join(outputDir, 'base.html');
		fs.writeFileSync(html, '<html><head><title>Base test</title><base href="/assets/"></head><body><p>Article content</p></body></html>');
		const template = path.join(outputDir, 'base-template.json');
		fs.writeFileSync(template, JSON.stringify({ id: 'base', name: 'Base', behavior: 'create', noteNameFormat: 'Base', path: '', properties: [], noteContentFormat: '![base](picture.png)' }));
		const note = path.join(outputDir, 'base.md');
		const images = path.join(outputDir, 'base-images');
		await execute(process.execPath, [path.join(root, 'dist/cli.cjs'), `${server.url}/elsewhere/page`, '--html', html, '-t', template, '-o', note, '--images-dir', images, '--images-strict']);
		expect(fs.readFileSync(note, 'utf8')).toMatch(/base-images\/[a-f0-9]{64}\.png/);
		expect(server.requests).toContain('/assets/picture.png');
		const broken = path.join(outputDir, 'broken-images');
		fs.writeFileSync(broken, 'existing file');
		fs.writeFileSync(note, 'original note');
		await expect(execute(process.execPath, [path.join(root, 'dist/cli.cjs'), `${server.url}/page`, '-o', note, '--images-dir', broken])).rejects.toMatchObject({ code: 1, stdout: '' });
		expect(fs.readFileSync(note, 'utf8')).toBe('original note');
	});

	test.each([
		{ args: ['--images-dir', 'images'], error: '--images-dir requires' },
		{ args: ['-o', 'note.md', '--images-dir', 'images', '--open'], error: 'cannot be combined with --open' },
		{ args: ['--images-strict'], error: '--images-strict requires' },
	])('rejects an unsupported argument combination before fetching: %j', async ({ args, error }) => {
		const count = server.requests.length;
		await expect(execute(process.execPath, [path.join(root, 'dist/cli.cjs'), `${server.url}/page`, ...args])).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining(error) });
		expect(server.requests).toHaveLength(count);
	});
});

function runCli(outputPath: string): string {
	return execFileSync(process.execPath, [
		path.join(root, 'dist/cli.cjs'),
		'https://example.com/article',
		'--html', path.join(root, 'src/utils/fixtures/templates/minimal.html'),
		'-o', outputPath,
	], { encoding: 'utf-8' }).trim();
}

describe('CLI output', () => {
	test('creates a nonexistent dotted directory when the path ends with a separator', () => {
		const directory = path.join(outputDir, 'notes.v1');
		const filePath = runCli(directory + path.sep);
		expect(fs.statSync(directory).isDirectory()).toBe(true);
		expect(filePath).toBe(path.join(directory, 'Minimal Page.md'));
		expect(fs.readFileSync(filePath, 'utf-8')).toContain('title: "Minimal Page"');
	});

	test('writes an explicit markdown file and prints its absolute path', () => {
		const filePath = path.join(outputDir, 'article.md');
		expect(runCli(filePath)).toBe(filePath);
		expect(fs.statSync(filePath).isFile()).toBe(true);
	});
});
