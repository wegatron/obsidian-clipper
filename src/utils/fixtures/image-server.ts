import { createServer } from 'node:http';
import { once } from 'node:events';

export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=', 'base64');
export const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="blue"/></svg>');

export async function startImageServer() {
	const requests: string[] = [];
	const credentials: { url: string; cookie?: string }[] = [];
	const server = createServer((request, response) => {
		requests.push(request.url!);
		credentials.push({ url: request.url!, cookie: request.headers.cookie });
		const url = new URL(request.url!, 'http://localhost');
		if (url.pathname === '/redirect.png') {
			response.writeHead(302, { Location: '/picture.png?signature=keep' });
			response.end();
		} else if (url.pathname === '/picture.png' || url.pathname === '/same.png' || url.pathname === '/assets/picture.png') {
			response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(png);
		} else if (url.pathname === '/protected.png') {
			if (request.headers.cookie?.includes('clipper_session=yes')) {
				response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); response.end(png);
			} else { response.writeHead(403, { 'Cache-Control': 'no-store' }); response.end('Login required'); }
		} else if (url.pathname === '/other.svg') {
			response.writeHead(200, { 'Content-Type': 'image/svg+xml' }); response.end(url.searchParams.get('color') === 'red' ? Buffer.from(svg.toString().replace('blue', 'red')) : svg);
		} else if (url.pathname === '/fake.png') {
			response.writeHead(200, { 'Content-Type': 'image/png' }); response.end('<html>Please log in</html>');
		} else if (url.pathname === '/slow.png') {
			response.writeHead(200, { 'Content-Type': 'image/png' }); response.write(png.subarray(0, 8));
		} else if (url.pathname === '/page' || url.pathname === '/login' || url.pathname === '/articles/page.html') {
			response.writeHead(200, { 'Content-Type': 'text/html', ...(url.pathname === '/login' ? { 'Set-Cookie': 'clipper_session=yes; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax' } : {}) });
			response.end(`<html><head><title>Image Article</title><base href="${url.pathname === '/articles/page.html' ? '/assets/' : '/'}"></head><body><article><h1>Image Article</h1><p>${'This is an article about local image downloads and offline reading. '.repeat(80)}</p><img alt="plot" width="600" height="400" src="${url.pathname === '/login' ? '/other.svg' : 'picture.png'}" ${url.pathname === '/login' ? 'srcset="/protected.png 1x, /other.svg 2x"' : ''}><p>${'More article content. '.repeat(50)}</p></article></body></html>`);
		} else if (url.pathname === '/start') {
			response.writeHead(302, { Location: '/articles/page.html' }); response.end();
		} else { response.writeHead(404); response.end('Not found'); }
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('No fixture server port');
	return {
		url: `http://127.0.0.1:${address.port}`,
		requests,
		credentials,
		close: () => new Promise<void>((resolve, reject) => {
			server.close(error => error ? reject(error) : resolve());
			server.closeAllConnections();
		}),
	};
}
