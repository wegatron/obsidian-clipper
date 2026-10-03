// Fetch a page through a real browser via CDP (Chrome DevTools Protocol).
// Uses a dedicated persistent profile (~/.obsidian-clipper/profile) so login
// cookies survive between runs — log in once with --interactive, then plain
// --browser reuses the session.

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import WebSocket from 'ws';
import type { ImageFetcher } from './image-localizer';

export interface BrowserFetchOptions {
	/** Wait for the user to close the browser window after logging in. */
	interactive?: boolean;
	/** Custom browser executable path. */
	browserPath?: string;
	signal?: AbortSignal;
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
		'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
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
		await sleep(Math.min(400, deadline - Date.now()));
		const remaining = deadline - Date.now();
		if (remaining <= 0) return;
		const res = await page.send('Runtime.evaluate', {
			expression: 'document.body ? document.body.innerText.length : 0',
			returnByValue: true,
		}, remaining);
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
	private eventWaiters = new Set<{ method: string; resolve: () => void; reject: (e: Error) => void }>();
	private closedError?: Error;

	constructor(ws: WebSocket) {
		this.ws = ws;
		ws.on('close', () => this.fail(new Error('CDP connection closed')));
		ws.on('error', (error: Error) => this.fail(error));
		ws.on('message', (data: WebSocket.RawData) => {
			const msg = JSON.parse(data.toString());
			if (msg.id && this.pending.has(msg.id)) {
				const p = this.pending.get(msg.id)!;
				this.pending.delete(msg.id);
				if (msg.error) p.reject(new Error(msg.error.message));
				else p.resolve(msg.result);
			} else if (msg.method) {
				for (const waiter of this.eventWaiters) {
					if (waiter.method === msg.method) waiter.resolve();
				}
			}
		});
	}

	static async connect(url: string): Promise<CdpConnection> {
		const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
		const connection = new CdpConnection(ws);
		try {
			await new Promise<void>((resolve, reject) => {
				const cleanup = () => {
					clearTimeout(timer);
					ws.off('open', onOpen);
					ws.off('error', onError);
					ws.off('close', onClose);
				};
				const onOpen = () => { cleanup(); resolve(); };
				const onError = (error: Error) => { cleanup(); reject(error); };
				const onClose = () => onError(new Error('CDP connection closed before opening'));
				const timer = setTimeout(() => onError(new Error('CDP connection timed out')), 10000);
				ws.once('open', onOpen);
				ws.once('error', onError);
				ws.once('close', onClose);
			});
			return connection;
		} catch (error) {
			ws.terminate();
			throw error;
		}
	}

	send(method: string, params: Record<string, unknown> = {}, timeoutMs = 10000, signal?: AbortSignal): Promise<any> {
		if (this.closedError) return Promise.reject(this.closedError);
		if (signal?.aborted) return Promise.reject(signal.reason);
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const cleanup = () => { clearTimeout(timer); this.pending.delete(id); signal?.removeEventListener('abort', onAbort); };
			const fail = (error: Error) => { cleanup(); reject(error); };
			const onAbort = () => fail(signal!.reason);
			const timer = setTimeout(() => fail(new Error(`CDP command ${method} timed out`)), timeoutMs);
			signal?.addEventListener('abort', onAbort, { once: true });
			this.pending.set(id, {
				resolve: value => { cleanup(); resolve(value); },
				reject: fail,
			});
			try {
				this.ws.send(JSON.stringify({ id, method, params }), error => {
					if (error) fail(error);
				});
			} catch (error) {
				fail(error as Error);
			}
		});
	}

	/** Wait for an event, or continue after the navigation wait limit. */
	waitForEvent(method: string, timeoutMs: number): Promise<void> {
		if (this.closedError) return Promise.reject(this.closedError);
		return new Promise((resolve, reject) => {
			const cleanup = () => { clearTimeout(timer); this.eventWaiters.delete(waiter); };
			const waiter = {
				method,
				resolve: () => { cleanup(); resolve(); },
				reject: (error: Error) => { cleanup(); reject(error); },
			};
			const timer = setTimeout(waiter.resolve, timeoutMs);
			this.eventWaiters.add(waiter);
		});
	}

	private fail(error: Error): void {
		this.closedError = error;
		for (const request of this.pending.values()) request.reject(error);
		for (const waiter of this.eventWaiters) waiter.reject(error);
	}

	close(): void {
		this.fail(new Error('CDP connection closed'));
		this.ws.close();
	}
}

async function fetchDevToolsJson(port: string, endpoint: string, method = 'GET'): Promise<any> {
	const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
		method,
		signal: AbortSignal.timeout(5000),
	});
	return response.json();
}

function hasExited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Wait for all page targets to disappear. On macOS this leaves the process
 * alive, so return false to reuse it; return true when a restart is needed.
 */
async function waitForBrowserClosed(port: string, child: ChildProcess): Promise<boolean> {
	const deadline = Date.now() + 15 * 60 * 1000;
	while (Date.now() < deadline) {
		if (hasExited(child)) return true;
		try {
			const targets: { type: string }[] = await fetchDevToolsJson(port, '/json/list');
			if (!targets.some(t => t.type === 'page')) return false;
		} catch {
			return true; // Endpoint gone; clean up this process before restarting.
		}
		await sleep(250);
	}
	return hasExited(child);
}

async function waitForDevToolsPort(portFile: string, timeoutMs: number, child: ChildProcess, startupError: () => Error | undefined): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const error = startupError();
		if (error) throw error;
		if (hasExited(child)) throw new Error('Browser exited before exposing a DevTools port');
		try {
			const content = fs.readFileSync(portFile, 'utf-8').trim();
			const port = content.split('\n')[0];
			if (port) return port;
		} catch { /* not written yet */ }
		await sleep(100);
	}
	throw new Error('Browser did not expose a DevTools port in time');
}

async function stopBrowser(port: string | undefined, child: ChildProcess): Promise<void> {
	if (hasExited(child)) return;
	let browser: CdpConnection | undefined;
	try {
		if (!port) throw new Error('No DevTools port');
		const version = await fetchDevToolsJson(port, '/json/version');
		browser = await CdpConnection.connect(version.webSocketDebuggerUrl);
		await browser.send('Browser.close', {}, 5000);
	} catch {
		if (!hasExited(child)) child.kill();
	} finally {
		browser?.close();
	}

	// Wait for profile flushing before a subsequent launch uses the same profile.
	if (hasExited(child)) return;
	await new Promise<void>((resolve, reject) => {
		const onExit = () => { clearTimeout(timer); resolve(); };
		const timer = setTimeout(() => {
			child.off('exit', onExit);
			child.kill();
			reject(new Error('Browser did not exit after shutdown'));
		}, 10000);
		child.once('exit', onExit);
	});
}

export interface BrowserPage {
	html: string;
	url: string;
	baseUrl: string;
	/** Valid only while the withBrowserPage callback is running. */
	fetchImage: ImageFetcher;
}

/**
 * Fetch a page's HTML with a real browser. Returns the rendered outerHTML
 * (prefixed with <!DOCTYPE html>) including any logged-in content.
 */
export async function fetchViaBrowser(url: string, options: BrowserFetchOptions = {}): Promise<string> {
	return runBrowserSession(url, options, page => Promise.resolve(page.html), false);
}

/** Keep the authenticated browser alive until capture and image processing finish. */
export async function withBrowserPage<T>(url: string, options: BrowserFetchOptions, processPage: (page: BrowserPage) => Promise<T>): Promise<T> {
	return runBrowserSession(url, options, processPage, true);
}

async function runBrowserSession<T>(url: string, options: BrowserFetchOptions, processPage: (page: BrowserPage) => Promise<T>, captureImages: boolean): Promise<T> {
	const result = await fetchBrowserSession(url, options, processPage, captureImages);
	if (result) return result.value;
	const retried = await fetchBrowserSession(url, { ...options, interactive: false }, processPage, captureImages);
	if (!retried) throw new Error('Failed to capture page HTML after login');
	return retried.value;
}

function browserImageFetcher(page: CdpConnection, frameId: string): ImageFetcher {
	return async (url, signal) => (async function* () {
		// Network service uses this live page's cookies and authentication state.
		// Keep the load promise so a late stream can still be closed after abort.
		const loading = page.send('Network.loadNetworkResource', {
			frameId, url, options: { disableCache: false, includeCredentials: true },
		}, 30000);
		let aborted = false;
		const cancel = () => { aborted = true; };
		signal.addEventListener('abort', cancel, { once: true });
		if (signal.aborted) cancel();
		loading.then(result => {
			if (aborted && result?.resource?.stream) void page.send('IO.close', { handle: result.resource.stream }).catch(() => {});
		}, () => {});
		let handle: string | undefined;
		try {
			const loaded = await abortable(loading, signal);
			const resource = loaded?.resource;
			handle = resource?.stream;
			if (!resource?.success || resource.httpStatusCode < 200 || resource.httpStatusCode >= 300 || !handle) {
				throw new Error(`Browser image request failed: HTTP ${resource?.httpStatusCode ?? 'unknown'} (${resource?.netErrorName ?? 'no stream'})`);
			}
			while (true) {
				const chunk = await page.send('IO.read', { handle, size: 64 * 1024 }, 30000, signal);
				yield Buffer.from(chunk.data ?? '', chunk.base64Encoded ? 'base64' : 'utf8');
				if (chunk.eof) return;
			}
		} finally {
			signal.removeEventListener('abort', cancel);
			if (handle) await page.send('IO.close', { handle }).catch(() => {});
		}
	})();
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
		signal.addEventListener('abort', abort, { once: true });
		operation.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
	});
}

async function fetchBrowserSession<T>(url: string, options: BrowserFetchOptions, processPage: (page: BrowserPage) => Promise<T>, captureImages: boolean): Promise<{ value: T } | undefined> {
	options.signal?.throwIfAborted();
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
		options.interactive ? url : 'about:blank',
	], { stdio: 'ignore' });
	let startupError: Error | undefined;
	child.on('error', (error: Error) => { startupError = error; });

	let port: string | undefined;
	let pageConnection: CdpConnection | undefined;
	const cancel = () => { pageConnection?.close(); if (!hasExited(child)) child.kill(); };
	options.signal?.addEventListener('abort', cancel, { once: true });
	if (options.signal?.aborted) cancel();
	try {
		port = await waitForDevToolsPort(portFile, 15000, child, () => startupError);
		if (options.interactive) {
			console.error(`Browser opened at ${url}.`);
			console.error('Log in if needed, then CLOSE the browser window — the CLI will re-fetch with the saved session.');
			if (await waitForBrowserClosed(port, child)) return undefined;
		}

		// Open a fresh tab for the target URL and connect to its CDP endpoint.
		// PUT is required by newer Chrome versions.
		const target = await fetchDevToolsJson(port, '/json/new?about:blank', 'PUT');
		const page = await CdpConnection.connect(target.webSocketDebuggerUrl);
		pageConnection = page;
		options.signal?.throwIfAborted();

		try {
			await page.send('Page.enable');
			const loaded = page.waitForEvent('Page.loadEventFired', 30000);
			await Promise.all([page.send('Page.navigate', { url }), loaded]);
			// Wait for JS-rendered content to stabilize (replaces a fixed delay —
			// SPA pages that redirect after login need more than 1s).
			await waitForStableContent(page);

			const evalRes = await page.send('Runtime.evaluate', {
				expression: captureImages ? `(() => {
					const snapshot = document.documentElement.cloneNode(true);
					const images = document.querySelectorAll('img');
					snapshot.querySelectorAll('img').forEach((image, index) => {
						if (images[index].currentSrc) {
							image.setAttribute('src', images[index].currentSrc);
							['srcset', 'sizes', 'data-src', 'data-srcset', 'data-original', 'data-lazy-src'].forEach(name => image.removeAttribute(name));
						}
					});
					// Prevent picture sources from selecting a different image during extraction.
					snapshot.querySelectorAll('picture source').forEach(source => source.remove());
					return { html: snapshot.outerHTML, url: location.href, baseUrl: document.baseURI };
				})()` : 'document.documentElement.outerHTML',
				returnByValue: true,
			});
			const snapshot = evalRes?.result?.value;
			const html = captureImages ? snapshot?.html : snapshot;
			if (typeof html !== 'string' || html.length === 0) {
				throw new Error('Failed to capture page HTML from browser');
			}
			const frames = captureImages ? await page.send('Page.getFrameTree') : undefined;
			options.signal?.throwIfAborted();
			return { value: await processPage({
				html: `<!DOCTYPE html>\n${html}`, url: captureImages ? snapshot.url : url,
				baseUrl: captureImages ? snapshot.baseUrl : url,
				fetchImage: browserImageFetcher(page, frames?.frameTree?.frame?.id),
			}) };
		} finally {
			page.close();
		}
	} finally {
		options.signal?.removeEventListener('abort', cancel);
		await stopBrowser(port, child);
	}
}
