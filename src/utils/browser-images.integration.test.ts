import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseHTML } from 'linkedom';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { png, startImageServer } from './fixtures/image-server';
import { localizeImages } from './image-localizer';
import { withBrowserPage } from './browser-fetch';

const profile = vi.hoisted(() => ({ home: '' }));
vi.mock('os', async () => ({ ...await vi.importActual('node:os'), homedir: () => profile.home }));
let directory: string;
let server: Awaited<ReturnType<typeof startImageServer>>;
const execute = promisify(execFile);

beforeAll(async () => {
	await execute(process.execPath, [path.resolve('scripts/build-cli.mjs')]);
	directory = await fs.mkdtemp(path.join(tmpdir(), 'clipper-real-browser-'));
	server = await startImageServer();
});
afterAll(async () => {
	await server?.close();
	if (directory) await fs.rm(directory, { recursive: true, force: true });
});

const browsers = process.platform === 'darwin' ? [
	['Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
	['Edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
] : [
	['Chrome', ['/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync) ?? '/usr/bin/google-chrome'],
	['Edge', '/usr/bin/microsoft-edge'],
];

for (const [name, executable] of browsers) {
	test.skipIf(!existsSync(executable))(`real ${name}: downloads selected images with cookies, reuses profile and closes streams`, async () => {
		profile.home = path.join(directory, name);
		await fs.mkdir(profile.home, { recursive: true });
		const wrapper = path.join(profile.home, 'browser.sh');
		await fs.writeFile(wrapper, `#!/bin/sh\nexec '${executable}' --headless=new --disable-gpu --use-mock-keychain --force-device-scale-factor=1 "$@"\n`, { mode: 0o700 });
		expect((await fetch(`${server.url}/protected.png`)).status).toBe(403);
		await withBrowserPage(`${server.url}/login`, { browserPath: wrapper }, async page => {
			const selected = parseHTML(page.html).document.querySelector('img')!;
			expect(selected.getAttribute('src')).toBe(`${server.url}/protected.png`);
			expect(selected.hasAttribute('srcset')).toBe(false);
			expect(page.baseUrl).toBe(`${server.url}/`);
			const result = await localizeImages({ markdown: `![selected](${selected.getAttribute('src')})`, pageBaseUrl: page.baseUrl, imagesDir: path.join(profile.home, 'images'), noteFilePath: path.join(profile.home, 'article.md'), imageFetcher: page.fetchImage });
			expect(result.failures).toEqual([]);
			expect(result.saved).toBe(1);
			expect(server.credentials.filter(request => request.url === '/protected.png').slice(-1)[0]?.cookie).toContain('clipper_session=yes');
			const [filename] = await fs.readdir(path.join(profile.home, 'images'));
			expect(await fs.readFile(path.join(profile.home, 'images', filename))).toEqual(png);
			const failed = await localizeImages({ markdown: `![large](${server.url}/protected.png)\n![slow](${server.url}/slow.png)`, pageBaseUrl: page.baseUrl, imagesDir: path.join(profile.home, 'partial'), noteFilePath: path.join(profile.home, 'article.md'), imageFetcher: page.fetchImage, limits: { maxBytes: 20, timeoutMs: 200 } });
			expect(failed.failures).toHaveLength(2);
			expect(await fs.readdir(path.join(profile.home, 'partial'))).toEqual([]);
		});
		await withBrowserPage(`${server.url}/page`, { browserPath: wrapper }, async page => {
			const chunks: Uint8Array[] = [];
			for await (const chunk of await page.fetchImage(`${server.url}/protected.png`, new AbortController().signal)) chunks.push(chunk);
			expect(Buffer.concat(chunks)).toEqual(png);
			expect(server.credentials.filter(request => request.url === '/protected.png').slice(-1)[0]?.cookie).toContain('clipper_session=yes');
		});
		const preload = path.join(profile.home, 'profile.cjs');
		await fs.writeFile(preload, `require('os').homedir = () => ${JSON.stringify(profile.home)};`);
		const note = path.join(profile.home, 'cli.md');
		const { stdout, stderr } = await execute(process.execPath, ['--require', preload, path.resolve('dist/cli.cjs'), `${server.url}/login`, '--browser', '--browser-path', wrapper, '-o', note, '--images-dir', path.join(profile.home, 'cli-images'), '--images-strict']);
		expect(stdout.trim()).toBe(note);
		expect(stderr).toContain('0 failed');
		expect(await fs.readFile(note, 'utf-8')).toMatch(/cli-images\/[a-f0-9]{64}\.png/);
		expect(await fs.readdir(path.join(profile.home, 'cli-images'))).toHaveLength(1);
	}, 45000);
}
