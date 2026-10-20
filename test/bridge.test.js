'use strict';
// The bridge against a fake Zotero connector server.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const EDITOR_UA = 'Mozilla/5.0 Chrome/109.0.0.0 AscDesktopEditor/9.2.0.100 Safari/537.36';

/** A fake Zotero: a transaction asks a fixed list of requests, then Document.complete */
function fakeZotero(script) {
	const seen = [];
	let queue = [];
	const server = http.createServer((req, res) => {
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => {
			const body = Buffer.concat(chunks).toString();
			seen.push({ path: req.url, body, apiVersion: req.headers['x-zotero-connector-api-version'] });
			if (req.url === '/connector/ping') return res.writeHead(200).end('ok');
			if (req.url === '/connector/document/execCommand') queue = script.slice();
			const next = queue.shift() || { command: 'Document.complete', arguments: [] };
			res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(next));
		});
	});
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

function startBridge(zoteroPort, env) {
	return new Promise((resolve, reject) => {
		const port = 20000 + Math.floor(Math.random() * 20000);
		const child = spawn(process.execPath, [path.join(__dirname, '../bridge/zotero-for-onlyoffice-bridge.js')], {
			env: { ...process.env, BRIDGE_PORT: String(port), ZOTERO_PORT: String(zoteroPort), BRIDGE_NATIVE_DIALOGS: '0', ...env },
			stdio: ['ignore', 'pipe', 'inherit'],
		});
		child.stdout.on('data', (d) => {
			if (/listening/.test(String(d))) resolve({ child, port });
		});
		child.on('exit', (code) => reject(new Error('bridge exited with ' + code)));
	});
}

function request(port, method, p, body, headers) {
	return new Promise((resolve, reject) => {
		const all = { 'User-Agent': EDITOR_UA, Origin: 'file://', ...headers };
		for (const k of Object.keys(all)) if (all[k] === undefined) delete all[k];
		const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: all }, (res) => {
			let data = '';
			res.on('data', (c) => (data += c));
			res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
		});
		req.on('error', reject);
		req.end(body == null ? undefined : JSON.stringify(body));
	});
}

test('bridge', async (t) => {
	const zotero = await fakeZotero([
		{ command: 'Application.getActiveDocument', arguments: [3] },
		{ command: 'Document.displayAlert', arguments: ['doc', 'Hello', 1, 1] },
	]);
	const bridge = await startBridge(zotero.port);
	t.after(() => {
		bridge.child.kill();
		zotero.server.close();
	});

	await t.test('reports its version to anyone', async () => {
		const r = await request(bridge.port, 'GET', '/oo/version', null, { 'User-Agent': 'curl', Origin: undefined });
		assert.strictEqual(r.status, 200);
		assert.strictEqual(JSON.parse(r.body).name, 'zotero-for-onlyoffice-bridge');
	});

	await t.test('refuses clients other than the desktop editors', async () => {
		const page = await request(bridge.port, 'POST', '/connector/document/execCommand', { command: 'refresh' }, { 'User-Agent': 'Mozilla/5.0 Chrome/120', Origin: 'https://example.com' });
		assert.strictEqual(page.status, 403);
		const fakeUa = await request(bridge.port, 'POST', '/connector/document/execCommand', { command: 'refresh' }, { Origin: 'https://example.com' });
		assert.strictEqual(fakeUa.status, 403);
		assert.ok(!zotero.seen.some((s) => s.path === '/connector/document/execCommand'));
	});

	await t.test('answers CORS preflight', async () => {
		const r = await request(bridge.port, 'OPTIONS', '/connector/document/execCommand');
		assert.strictEqual(r.status, 204);
		assert.strictEqual(r.headers['access-control-allow-origin'], '*');
	});

	await t.test('proxies a transaction with the connector API header', async () => {
		let r = await request(bridge.port, 'POST', '/connector/document/execCommand', { command: 'addEditCitation', docId: 'd' });
		assert.strictEqual(r.status, 200);
		assert.strictEqual(r.headers['access-control-allow-origin'], '*');
		assert.strictEqual(JSON.parse(r.body).command, 'Application.getActiveDocument');
		// Without native dialogs the alert goes on to the plugin
		r = await request(bridge.port, 'POST', '/connector/document/respond', { documentID: 'd' });
		assert.strictEqual(JSON.parse(r.body).command, 'Document.displayAlert');
		r = await request(bridge.port, 'POST', '/connector/document/respond', 1);
		assert.strictEqual(JSON.parse(r.body).command, 'Document.complete');
		assert.ok(zotero.seen.every((s) => s.apiVersion === '3'));
	});

	await t.test('tells the plugin when it has no native dialogs', async () => {
		const r = await request(bridge.port, 'POST', '/oo/alert', { text: 'x', icon: 1, buttons: 0 });
		assert.deepStrictEqual(JSON.parse(r.body), { unsupported: true });
	});

	await t.test('does not proxy other Zotero endpoints', async () => {
		const r = await request(bridge.port, 'POST', '/connector/saveItems', {});
		assert.strictEqual(r.status, 404);
	});
});

test('bridge finishes a transaction the editor abandoned', async (t) => {
	const zotero = await fakeZotero([
		{ command: 'Application.getActiveDocument', arguments: [3] },
		{ command: 'Document.getDocumentData', arguments: ['doc'] },
		{ command: 'Document.getFields', arguments: ['doc', 'Http'] },
	]);
	// Zotero answers slowly, so the client is gone before the answer arrives
	const slow = http.createServer((req, res) => {
		const p = http.request({ host: '127.0.0.1', port: zotero.port, path: req.url, method: req.method, headers: req.headers }, (up) => {
			setTimeout(() => { res.writeHead(up.statusCode, up.headers); up.pipe(res); }, 300);
		});
		req.pipe(p);
	});
	await new Promise((r) => slow.listen(0, '127.0.0.1', r));
	const bridge = await startBridge(slow.address().port);
	t.after(() => {
		bridge.child.kill();
		slow.close();
		zotero.server.close();
	});

	await new Promise((resolve) => {
		const req = http.request({ host: '127.0.0.1', port: bridge.port, path: '/connector/document/execCommand', method: 'POST', headers: { 'User-Agent': EDITOR_UA, Origin: 'file://' } });
		req.on('error', () => resolve());
		req.end(JSON.stringify({ command: 'refresh', docId: 'gone' }));
		setTimeout(() => { req.destroy(); resolve(); }, 50);
	});
	// The bridge answers the remaining requests itself until Document.complete
	for (let i = 0; i < 40 && zotero.seen.filter((s) => s.path === '/connector/document/respond').length < 3; i++) {
		await new Promise((r) => setTimeout(r, 100));
	}
	const responds = zotero.seen.filter((s) => s.path === '/connector/document/respond').map((s) => JSON.parse(s.body));
	assert.strictEqual(responds.length, 3);
	assert.strictEqual(responds[0].error, 'Error');
	assert.strictEqual(responds[1], '');
	assert.deepStrictEqual(responds[2], []);
});
