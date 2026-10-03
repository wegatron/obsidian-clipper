import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { spawn } from 'child_process';
import { fetchViaBrowser, withBrowserPage } from './browser-fetch';

const state = vi.hoisted(() => ({
	portFile: false,
	children: [] as any[],
	sockets: [] as any[],
	pageCommand: 'reply',
	shutdownCommand: 'reply',
	noPort: false,
	exitOnWindowClose: false,
}));

vi.mock('fs', () => ({
	mkdirSync: vi.fn(),
	unlinkSync: vi.fn(() => { state.portFile = false; }),
	readFileSync: vi.fn(() => {
		if (!state.portFile) throw new Error('ENOENT');
		return '9222\n/devtools/browser/test';
	}),
}));

vi.mock('child_process', () => ({ spawn: vi.fn() }));

vi.mock('ws', async () => {
	const { EventEmitter } = await vi.importActual<typeof import('node:events')>('node:events');
	class FakeWebSocket extends EventEmitter {
		static OPEN = 1;
		static CLOSED = 3;
		readyState = FakeWebSocket.OPEN;
		constructor(readonly url: string) {
			super();
			state.sockets.push(this);
			queueMicrotask(() => this.emit('open'));
		}
		send(data: string, callback?: (error?: Error) => void) {
			const { id, method, params } = JSON.parse(data);
			queueMicrotask(() => {
				callback?.();
				if (method === 'Browser.close' && state.shutdownCommand === 'hang') return;
				if (method === 'Browser.close' && state.shutdownCommand === 'close') {
					const child = state.children[state.children.length - 1];
					child.exitCode = 0;
					child.emit('exit', 0);
					this.close();
					return;
				}
				if (method === 'Runtime.evaluate' && state.pageCommand !== 'reply') {
					if (state.pageCommand === 'close') this.close();
					if (state.pageCommand === 'error') this.emit('error', new Error('socket failed'));
					return;
				}
				const result = method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'frame' } } }
					: method === 'Network.loadNetworkResource' ? { resource: { success: true, httpStatusCode: 200, stream: 'image' } }
					: method === 'IO.read' ? { data: 'aW1hZ2U=', base64Encoded: true, eof: true }
					: method === 'Runtime.evaluate'
					? { result: { value: params.expression.includes('currentSrc') ? { html: '<html><body>Article</body></html>', url: 'https://example.com/final', baseUrl: 'https://cdn.example.com/' } : params.expression.includes('outerHTML') ? '<html><body>Article</body></html>' : 7 } }
					: {};
				this.emit('message', Buffer.from(JSON.stringify({ id, result })));
				if (method === 'Page.navigate') this.emit('message', Buffer.from(JSON.stringify({ method: 'Page.loadEventFired' })));
				if (method === 'Browser.close') {
					const child = state.children[state.children.length - 1];
					child.exitCode = 0;
					child.emit('exit', 0);
				}
			});
		}
		close() {
			this.readyState = FakeWebSocket.CLOSED;
			this.emit('close');
		}
		terminate() { this.close(); }
	}
	return { default: FakeWebSocket };
});

beforeEach(() => {
	vi.useFakeTimers();
	state.portFile = false;
	state.children = [];
	state.sockets = [];
	state.pageCommand = 'reply';
	state.shutdownCommand = 'reply';
	state.noPort = false;
	state.exitOnWindowClose = false;
	vi.mocked(spawn).mockReset();
	vi.mocked(spawn).mockImplementation(() => {
		const child = Object.assign(new EventEmitter(), {
			exitCode: null as number | null,
			signalCode: null as string | null,
			kill: vi.fn(() => {
				child.signalCode = 'SIGTERM';
				child.emit('exit', null, 'SIGTERM');
				return true;
			}),
		});
		// An existing process owns the profile and receives the second launch.
		if (!state.children.some(c => c.exitCode === null && c.signalCode === null)) state.portFile = !state.noPort;
		else child.exitCode = 0;
		state.children.push(child);
		return child as unknown as ReturnType<typeof spawn>;
	});
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		if (url.endsWith('/json/list')) {
			if (state.exitOnWindowClose) {
				const child = state.children[state.children.length - 1];
				child.exitCode = 0;
				child.emit('exit', 0);
				throw new Error('browser exited');
			}
			return { json: async () => [] };
		}
		return { json: async () => ({ webSocketDebuggerUrl: url.endsWith('/json/version') ? 'ws://browser' : 'ws://page' }) };
	}));
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('fetchViaBrowser', () => {
	test('reuses the live browser after closing the login window on macOS', async () => {
		const result = fetchViaBrowser('https://example.com', { browserPath: '/browser', interactive: true });
		const assertion = expect(result).resolves.toContain('Article');
		await vi.runAllTimersAsync();
		await assertion;
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(state.children[0].exitCode).toBe(0);
	});

	test('restarts after the login browser exits', async () => {
		state.exitOnWindowClose = true;
		const result = fetchViaBrowser('https://example.com', { browserPath: '/browser', interactive: true });
		const assertion = expect(result).resolves.toContain('Article');
		await vi.runAllTimersAsync();
		await assertion;
		expect(spawn).toHaveBeenCalledTimes(2);
	});

	test('clears the navigation timeout once the page loads', async () => {
		const result = fetchViaBrowser('https://example.com', { browserPath: '/browser' });
		await vi.advanceTimersByTimeAsync(1000);
		expect(await result).toContain('Article');
		expect(vi.getTimerCount()).toBe(0);
	});

	test.each(['close', 'error'])('rejects an in-flight command on socket %s', async (failure) => {
		state.pageCommand = failure;
		const result = fetchViaBrowser('https://example.com', { browserPath: '/browser' });
		const assertion = expect(result).rejects.toThrow(/closed|socket failed/i);
		await vi.advanceTimersByTimeAsync(1000);
		await assertion;
		expect(state.children[0].exitCode).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	test('bounds an unanswered render command by the content deadline', async () => {
		state.pageCommand = 'hang';
		const result = fetchViaBrowser('https://example.com', { browserPath: '/browser' });
		const assertion = expect(result).rejects.toThrow(/timed out/i);
		await vi.advanceTimersByTimeAsync(10500);
		await assertion;
		expect(state.children[0].exitCode).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	test('accepts browser shutdown that disconnects before replying', async () => {
		state.shutdownCommand = 'close';
		const result = fetchViaBrowser('https://example.com', { browserPath: '/browser' });
		await vi.advanceTimersByTimeAsync(1000);
		expect(await result).toContain('Article');
		expect(vi.getTimerCount()).toBe(0);
	});

	test('kills the browser when graceful shutdown stops responding', async () => {
		state.shutdownCommand = 'hang';
		const result = fetchViaBrowser('https://example.com', { browserPath: '/browser' });
		await vi.advanceTimersByTimeAsync(6000);
		expect(await result).toContain('Article');
		expect(state.children[0].kill).toHaveBeenCalledOnce();
		expect(state.sockets.every(socket => socket.readyState === 3)).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	test('cleans up an interactive launch that never exposes a port', async () => {
		state.noPort = true;
		const result = fetchViaBrowser('https://example.com', { browserPath: '/browser', interactive: true });
		const assertion = expect(result).rejects.toThrow(/DevTools port/i);
		await vi.advanceTimersByTimeAsync(15000);
		await assertion;
		expect(state.children[0].kill).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});
});


test('keeps the authenticated page live through image processing and shuts down on callback failure', async () => {
	let downloaded = '';
	const result = withBrowserPage('https://example.com', { browserPath: '/browser', interactive: true }, async page => {
		expect(state.children[0].exitCode).toBeNull();
		expect(page.url).toBe('https://example.com/final');
		expect(page.baseUrl).toBe('https://cdn.example.com/');
		for await (const chunk of await page.fetchImage('https://example.com/image.png', new AbortController().signal)) downloaded += Buffer.from(chunk).toString();
		throw new Error('output failed');
	});
	const assertion = expect(result).rejects.toThrow('output failed');
	await vi.runAllTimersAsync();
	await assertion;
	expect(downloaded).toBe('image');
	expect(spawn).toHaveBeenCalledTimes(1);
	expect(state.children[0].exitCode).toBe(0);
	expect(vi.getTimerCount()).toBe(0);
});
