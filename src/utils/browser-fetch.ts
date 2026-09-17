// Fetch a page through a real browser via CDP (Chrome DevTools Protocol).
// Uses a dedicated persistent profile (~/.obsidian-clipper/profile) so login
// cookies survive between runs — log in once with --interactive, then plain
// --browser reuses the session.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import WebSocket from 'ws';

export interface BrowserFetchOptions {
	/** Wait for Enter in the terminal before capturing (first-time login flow). */
	interactive?: boolean;
	/** Custom browser executable path. */
	browserPath?: string;
}

function findBrowser(customPath?: string): string {
	if (customPath) return customPath;
	const candidates = [
		'C:/Program Files/Google/Chrome/Application/chrome.exe',
		'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
		process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : '',
		'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
		'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		'/usr/bin/google-chrome',
		'/usr/bin/chromium',
		'/usr/bin/microsoft-edge',
	];
	const found = candidates.find(c => c && fs.existsSync(c));
	if (!found) {
		throw new Error('No browser found (Chrome or Edge). Install one or pass --browser-path.');
	}
	return found;
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/** Wait until rendered text length stops changing (SPA content), capped. */
async function waitForStableContent(page: CdpConnection, maxMs = 10000): Promise<void> {
	let prev = -1;
	const deadline = Date.now() + maxMs;
	while (Date.now() < deadline) {
		await sleep(400);
		const res = await page.send('Runtime.evaluate', {
			expression: 'document.body ? document.body.innerText.length : 0',
			returnByValue: true,
		});
		const len = res?.result?.value ?? 0;
		if (len === prev && len > 0) return;
		prev = len;
	}
}

/** Minimal CDP client: send commands, resolve on matching event. */
class CdpConnection {
	private ws: WebSocket;
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	private eventWaiters: { method: string; resolve: () => void }[] = [];

	constructor(ws: WebSocket) {
		this.ws = ws;
		ws.on('message', (data: WebSocket.RawData) => {
			const msg = JSON.parse(data.toString());
			if (msg.id && this.pending.has(msg.id)) {
				const p = this.pending.get(msg.id)!;
				this.pending.delete(msg.id);
				if (msg.error) p.reject(new Error(msg.error.message));
				else p.resolve(msg.result);
			} else if (msg.method) {
				this.eventWaiters = this.eventWaiters.filter(w => {
					if (w.method === msg.method) { w.resolve(); return false; }
					return true;
				});
			}
		});
	}

	static async connect(url: string): Promise<CdpConnection> {
		const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
		await new Promise<void>((resolve, reject) => {
			ws.once('open', resolve);
			ws.once('error', reject);
		});
		return new CdpConnection(ws);
	}

	send(method: string, params: Record<string, unknown> = {}): Promise<any> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.ws.send(JSON.stringify({ id, method, params }));
		});
	}

	/** Resolve the next time the given event fires (loadEventFired etc.). */
	waitForEvent(method: string): Promise<void> {
		return new Promise(resolve => this.eventWaiters.push({ method, resolve }));
	}

	close(): void {
		this.ws.close();
	}
}

/**
 * Wait until all page targets are gone (user closed the window).
 * Portable: on macOS closing the window does NOT exit the Chrome process,
 * so waiting for process exit would hang forever.
 */
async function waitForBrowserClosed(port: string, child: { exitCode: number | null }): Promise<void> {
	const deadline = Date.now() + 15 * 60 * 1000; // ponytail: 15min cap, no earlier bail
	while (Date.now() < deadline) {
		if (child.exitCode !== null) return;
		try {
			const res = await fetch(`http://127.0.0.1:${port}/json/list`);
			const targets: { type: string }[] = await res.json();
			if (!targets.some(t => t.type === 'page')) return;
		} catch {
			return; // DevTools endpoint gone -> browser exited
		}
		await sleep(250);
	}
}

async function waitForDevToolsPort(portFile: string, timeoutMs: number): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const content = fs.readFileSync(portFile, 'utf-8').trim();
			const port = content.split('\n')[0];
			if (port) return port;
		} catch { /* not written yet */ }
		await sleep(100);
	}
	throw new Error('Browser did not expose a DevTools port in time');
}

/**
 * Fetch a page's HTML with a real browser. Returns the rendered outerHTML
 * (prefixed with <!DOCTYPE html>) including any logged-in content.
 */
export async function fetchViaBrowser(url: string, options: BrowserFetchOptions = {}): Promise<string> {
	if (options.interactive) {
		// Interactive login flow: open the page, let the user log in and close
		// the window themselves, then re-fetch with the persisted session.
		const browserExe = findBrowser(options.browserPath);
		const profileDir = path.join(os.homedir(), '.obsidian-clipper', 'profile');
		fs.mkdirSync(profileDir, { recursive: true });
		const child = spawn(browserExe, [
			'--remote-debugging-port=0',
			`--user-data-dir=${profileDir}`,
			'--no-first-run',
			'--no-default-browser-check',
			url,
		], { stdio: 'ignore' });
		const portFile = path.join(profileDir, 'DevToolsActivePort');
		const port = await waitForDevToolsPort(portFile, 15000);
		console.error(`Browser opened at ${url}.`);
		console.error(`Log in if needed, then CLOSE the browser window — the CLI will re-fetch with the saved session.`);
		await waitForBrowserClosed(port, child);
		return fetchViaBrowser(url, { browserPath: options.browserPath });
	}

	const browserExe = findBrowser(options.browserPath);
	const profileDir = path.join(os.homedir(), '.obsidian-clipper', 'profile');
	fs.mkdirSync(profileDir, { recursive: true });
	const portFile = path.join(profileDir, 'DevToolsActivePort');
	try { fs.unlinkSync(portFile); } catch { /* stale file from a previous run */ }

	const child = spawn(browserExe, [
		'--remote-debugging-port=0',
		`--user-data-dir=${profileDir}`,
		'--no-first-run',
		'--no-default-browser-check',
		'about:blank',
	], { stdio: 'ignore' });

	let port: string | undefined;
	try {
		port = await waitForDevToolsPort(portFile, 15000);

		// Open a fresh tab for the target URL and connect to its CDP endpoint.
		// PUT is required by newer Chrome versions.
		const newTargetRes = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
		const target = await newTargetRes.json();
		const page = await CdpConnection.connect(target.webSocketDebuggerUrl);

		try {
			await page.send('Page.enable');
			const loaded = page.waitForEvent('Page.loadEventFired');
			await page.send('Page.navigate', { url });
			// ponytail: fixed 30s nav timeout; no retry. Hangs kill the agent's run visibly.
			await Promise.race([loaded, sleep(30000)]);
			// Wait for JS-rendered content to stabilize (replaces a fixed delay —
			// SPA pages that redirect after login need more than 1s).
			await waitForStableContent(page);

			const evalRes = await page.send('Runtime.evaluate', {
				expression: 'document.documentElement.outerHTML',
				returnByValue: true,
			});
			const html = evalRes?.result?.value;
			if (typeof html !== 'string' || html.length === 0) {
				throw new Error('Failed to capture page HTML from browser');
			}
			return `<!DOCTYPE html>\n${html}`;
		} finally {
			page.close();
		}
	} finally {
		// Graceful shutdown via CDP so the profile is flushed cleanly.
		try {
			if (!port) throw new Error('no port');
			const versionRes = await fetch(`http://127.0.0.1:${port}/json/version`);
			const version = await versionRes.json();
			const browserWs = await CdpConnection.connect(version.webSocketDebuggerUrl);
			await browserWs.send('Browser.close');
			browserWs.close();
		} catch {
			child.kill();
		}
	}
}
