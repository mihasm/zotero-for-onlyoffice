#!/usr/bin/env node
// zotero-for-onlyoffice-bridge — part of Zotero for ONLYOFFICE
// (https://github.com/mihasm/zotero-for-onlyoffice), installed by its install.js.
//
// A small local server that lets the plugin in the ONLYOFFICE desktop editors talk
// to the Zotero desktop app:
//
// - Proxies Zotero's integration endpoints from 127.0.0.1:23120 to Zotero's
//   connector server (127.0.0.1:23119). Zotero sends no CORS headers for the
//   editor's plugin frame and rejects browser requests that lack
//   X-Zotero-Connector-API-Version. Only requests from the ONLYOFFICE desktop
//   editors are accepted, so a web page in a browser cannot drive Zotero through it.
// - Shows Zotero's alerts (Document.displayAlert) as native dialogs: osascript on
//   macOS, PowerShell on Windows, zenity or kdialog on Linux. Without any of them
//   the alerts go on to the plugin.
// - Brings ONLYOFFICE back to the front after a Zotero dialog (/oo/activate).
// - Unwedges Zotero. A command only ends when the client answers every request
//   up to 'Document.complete'; if the editor goes away in the middle of one, the
//   bridge answers Zotero itself, or Zotero would refuse every later command
//   with "already running".
//
// Options: --log FILE appends the log to FILE (default: standard output).
// Environment: BRIDGE_PORT (23120), ZOTERO_PORT (23119), BRIDGE_DEBUG=1 logs the
// protocol, BRIDGE_NATIVE_DIALOGS=0 turns the native dialogs off,
// BRIDGE_ALLOW_ANY_CLIENT=1 skips the client check (tests only).
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

const VERSION = '1.0.0';
const LISTEN_PORT = Number(process.env.BRIDGE_PORT || 23120);
const ZOTERO = { host: '127.0.0.1', port: Number(process.env.ZOTERO_PORT || 23119) };
const PROXIED = /^\/connector\/(document\/(execCommand|respond)|ping)$/;
const TRANSACTION = /^\/connector\/document\/(execCommand|respond)$/;
const MAX_RECOVERY_STEPS = 50;
const DEBUG = process.env.BRIDGE_DEBUG === '1';
const NATIVE_DIALOGS = process.env.BRIDGE_NATIVE_DIALOGS !== '0';
const ALLOW_ANY_CLIENT = process.env.BRIDGE_ALLOW_ANY_CLIENT === '1';

const LOG_FILE = (() => {
	const i = process.argv.indexOf('--log');
	return i > 0 ? process.argv[i + 1] : null;
})();
const MAX_LOG_BYTES = 1024 * 1024;

function log(msg) {
	const line = new Date().toISOString() + ' ' + msg;
	if (!LOG_FILE) {
		console.log(line);
		return;
	}
	try {
		// Keep the log small: start over (keeping one old copy) past 1 MB
		if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
		fs.appendFileSync(LOG_FILE, line + '\n');
	} catch (e) {
		console.log(line);
	}
}

// ------------------------------------------------------------------ Zotero

function zoteroRequest(path, method, body) {
	return new Promise((resolve, reject) => {
		const up = http.request({
			...ZOTERO,
			path,
			method,
			headers: {
				'Content-Type': 'application/json',
				// Zotero's server requires Content-Length, so bodies are buffered
				'Content-Length': body.length,
				'X-Zotero-Connector-API-Version': '3',
			},
		}, (upRes) => {
			const chunks = [];
			upRes.on('data', (c) => chunks.push(c));
			upRes.on('end', () => resolve({ status: upRes.statusCode, type: upRes.headers['content-type'], body: Buffer.concat(chunks) }));
		});
		up.on('error', reject);
		up.end(body);
	});
}

function parseRequest(buf) {
	try {
		const v = JSON.parse(buf.toString());
		return v && typeof v === 'object' && v.command ? v : null;
	} catch (e) {
		return null;
	}
}

function short(buf) {
	const t = buf.toString();
	return t.length > 300 ? t.slice(0, 300) + '…' : t;
}

// ---------------------------------------------------------- native dialogs

function run(file, args, input) {
	return new Promise((resolve) => {
		const child = execFile(file, args, { windowsHide: true }, (err, stdout, stderr) => {
			resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: String(stdout).trim(), err: String(stderr).trim() });
		});
		if (input != null) child.stdin.end(input);
	});
}

const which = (() => {
	const cache = {};
	return (cmd) => {
		if (cmd in cache) return cache[cmd];
		const dirs = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
		cache[cmd] = dirs.some((d) => d && fs.existsSync(require('node:path').join(d, cmd)));
		return cache[cmd];
	};
})();

function appleString(s) {
	return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// Zotero's button sets: 0 OK, 1 OK/Cancel, 2 Yes/No, 3 Yes/No/Cancel; icons: 0 stop, 1 note, 2 caution.
// Each dialog returns the button pressed: 'ok' | 'cancel' | 'yes' | 'no'.
const dialogs = {
	async darwin(text, icon, buttons) {
		const sets = [['OK'], ['Cancel', 'OK'], ['No', 'Yes'], ['Cancel', 'No', 'Yes']];
		const set = sets[buttons] || sets[0];
		const r = await run('/usr/bin/osascript', [
			'-e', 'activate',
			'-e', 'set r to display dialog ' + appleString(text) + ' with title "Zotero" buttons {' + set.map(appleString).join(', ') + '}' +
				' default button ' + appleString(set[set.length - 1]) +
				(set.includes('Cancel') ? ' cancel button "Cancel"' : '') +
				' with icon ' + (['stop', 'note', 'caution'][icon] || 'note'),
			'-e', 'button returned of r',
		]);
		return r.ok ? r.out.toLowerCase() : 'cancel';
	},

	async win32(text, icon, buttons) {
		// The text goes in on stdin so that no quoting of it is needed
		const kinds = ['OK', 'OKCancel', 'YesNo', 'YesNoCancel'];
		const icons = ['Error', 'Information', 'Warning'];
		const script = [
			'Add-Type -AssemblyName System.Windows.Forms',
			'$text = [Console]::In.ReadToEnd()',
			'$owner = New-Object System.Windows.Forms.Form',
			'$owner.TopMost = $true',
			"$r = [System.Windows.Forms.MessageBox]::Show($owner, $text, 'Zotero', '" + (kinds[buttons] || 'OK') + "', '" + (icons[icon] || 'Information') + "')",
			'$owner.Dispose()',
			'Write-Output $r',
		].join('; ');
		const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], text);
		return r.ok ? r.out.toLowerCase() : 'cancel';
	},

	async linux(text, icon, buttons) {
		if (which('zenity')) {
			const args = ['--title=Zotero', '--text=' + text, '--no-markup', '--width=420'];
			if (buttons === 0) {
				await run('zenity', [icon === 0 ? '--error' : icon === 2 ? '--warning' : '--info'].concat(args));
				return 'ok';
			}
			const labels = buttons === 1 ? ['--ok-label=OK', '--cancel-label=Cancel'] : ['--ok-label=Yes', '--cancel-label=No'];
			const extra = buttons === 3 ? ['--extra-button=Cancel'] : [];
			const r = await run('zenity', ['--question'].concat(args, labels, extra));
			if (r.out === 'Cancel') return 'cancel';
			if (r.ok) return buttons === 1 ? 'ok' : 'yes';
			return buttons === 1 ? 'cancel' : buttons === 3 && r.code !== 1 ? 'cancel' : 'no';
		}
		if (which('kdialog')) {
			if (buttons === 0) {
				await run('kdialog', ['--title', 'Zotero', icon === 0 ? '--error' : icon === 2 ? '--sorry' : '--msgbox', text]);
				return 'ok';
			}
			if (buttons === 1) return (await run('kdialog', ['--title', 'Zotero', '--continuecancel', text])).ok ? 'ok' : 'cancel';
			if (buttons === 2) return (await run('kdialog', ['--title', 'Zotero', '--yesno', text])).ok ? 'yes' : 'no';
			const r = await run('kdialog', ['--title', 'Zotero', '--yesnocancel', text]);
			return r.ok ? 'yes' : r.code === 1 ? 'no' : 'cancel';
		}
		return null;
	},
};

function nativeDialogsAvailable() {
	if (!NATIVE_DIALOGS || !dialogs[process.platform]) return false;
	if (process.platform === 'linux') return which('zenity') || which('kdialog');
	return true;
}

/** A Zotero alert as a native dialog, answered as Zotero expects; null when there is no dialog tool */
async function showAlert(text, icon, buttons) {
	if (!nativeDialogsAvailable()) return null;
	const answer = await dialogs[process.platform](String(text), icon, buttons);
	if (answer == null) return null;
	// OK/Yes -> 1, No/Cancel -> 0; with Yes/No/Cancel: Yes 2, No 1, Cancel 0
	if (buttons === 3) return answer === 'yes' ? 2 : answer === 'no' ? 1 : 0;
	if (buttons === 0) return 1;
	return answer === 'ok' || answer === 'yes' ? 1 : 0;
}

function activateOnlyoffice() {
	switch (process.platform) {
		case 'darwin':
			return run('/usr/bin/osascript', ['-e', 'tell application id "asc.onlyoffice.ONLYOFFICE" to activate']);
		case 'win32':
			return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
				"$p = Get-Process DesktopEditors -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; " +
				'if ($p) { (New-Object -ComObject WScript.Shell).AppActivate($p.Id) | Out-Null }']);
		default:
			if (which('wmctrl')) return run('wmctrl', ['-x', '-a', 'DesktopEditors']);
			if (which('xdotool')) return run('xdotool', ['search', '--class', 'DesktopEditors', 'windowactivate']);
			return Promise.resolve();
	}
}

// ------------------------------------------------------------- transactions

/**
 * Answer Zotero's alerts here; returns Zotero's next request that is not an alert.
 * Stops once the editor is gone: no more questions about a closed document.
 */
async function answerAlerts(response, clientGone) {
	for (;;) {
		const req = response.status === 200 ? parseRequest(response.body) : null;
		if (!req || req.command !== 'Document.displayAlert' || clientGone()) return response;
		const [, text, icon, buttons] = req.arguments || [];
		const answer = await showAlert(text, icon, buttons);
		if (answer == null) return response;
		log('alert: ' + String(text).slice(0, 200) + ' -> ' + answer);
		response = await zoteroRequest('/connector/document/respond', 'POST', Buffer.from(JSON.stringify(answer)));
	}
}

/** Answer Zotero's requests on behalf of a vanished client until the command ends */
async function finishOrphanedTransaction(firstResponse) {
	let first = true;
	let response = firstResponse;
	for (let step = 0; step < MAX_RECOVERY_STEPS; step++) {
		const request = parseRequest(response.body);
		if (!request) return;
		log('recovery: answering orphaned ' + request.command);
		if (request.command === 'Document.complete') return;

		let reply = null;
		if (first) {
			// Makes Zotero abort the command and run its cleanup path
			reply = { error: 'Error', message: 'The document was closed during the Zotero command', stack: '' };
			first = false;
		} else if (request.command === 'Document.displayAlert') {
			reply = 0;
		} else if (request.command === 'Document.getDocumentData') {
			reply = '';
		} else if (request.command === 'Document.getFields') {
			reply = [];
		}
		try {
			response = await zoteroRequest('/connector/document/respond', 'POST', Buffer.from(JSON.stringify(reply)));
		} catch (e) {
			return;
		}
		if (response.status !== 200) return;
	}
}

// ------------------------------------------------------------------ server

/** The plugin frame of the desktop editors: file:// origin and the editors' user agent */
function fromEditor(req) {
	if (ALLOW_ANY_CLIENT) return true;
	const origin = req.headers.origin;
	const ua = req.headers['user-agent'] || '';
	return (origin === undefined || origin === 'null' || origin === 'file://') && /AscDesktopEditor/.test(ua);
}

function readBody(req) {
	return new Promise((resolve) => {
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => resolve(Buffer.concat(chunks)));
	});
}

const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
};

function json(res, status, value) {
	res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' }).end(JSON.stringify(value));
}

const server = http.createServer(async (req, res) => {
	if (req.method === 'OPTIONS') {
		res.writeHead(204, CORS).end();
		return;
	}
	const path = req.url.split('?')[0];
	const body = await readBody(req);

	if (path === '/oo/version') {
		json(res, 200, { name: 'zotero-for-onlyoffice-bridge', version: VERSION, nativeDialogs: nativeDialogsAvailable() });
		return;
	}
	if (!fromEditor(req)) {
		log('refused ' + req.method + ' ' + path + ' from origin=' + req.headers.origin + ' ua=' + req.headers['user-agent']);
		res.writeHead(403, CORS).end('Only the ONLYOFFICE desktop editors may use this bridge');
		return;
	}

	// Calls from the plugin to the bridge itself
	if (path === '/oo/log') {
		log('plugin: ' + body.toString().slice(0, 1000));
		res.writeHead(204, CORS).end();
		return;
	}
	if (path === '/oo/activate') {
		await activateOnlyoffice();
		res.writeHead(204, CORS).end();
		return;
	}
	if (path === '/oo/alert') {
		let a = {};
		try { a = JSON.parse(body.toString()); } catch (e) {}
		const result = await showAlert(a.text || '', a.icon, a.buttons || 0);
		if (result != null) await activateOnlyoffice();
		json(res, 200, result == null ? { unsupported: true } : { result });
		return;
	}
	if (!PROXIED.test(path)) {
		res.writeHead(404, CORS).end('Not proxied');
		return;
	}

	let clientGone = false;
	res.on('close', () => {
		if (!res.writableFinished) clientGone = true;
	});

	if (DEBUG && path !== '/connector/ping') log('→ ' + path + ' ' + short(body));
	let up;
	try {
		up = await zoteroRequest(req.url, req.method, body);
		if (TRANSACTION.test(path)) up = await answerAlerts(up, () => clientGone);
		if (DEBUG && path !== '/connector/ping') log('← ' + up.status + ' ' + short(up.body));
	} catch (e) {
		if (!clientGone) res.writeHead(502, CORS).end('Zotero not reachable: ' + e.message);
		return;
	}
	if (clientGone) {
		if (TRANSACTION.test(path) && up.status === 200) finishOrphanedTransaction(up);
		return;
	}
	res.writeHead(up.status, { ...CORS, 'Content-Type': up.type || 'text/plain' });
	res.end(up.body);
});

server.on('error', (e) => {
	if (e.code === 'EADDRINUSE') {
		log('port ' + LISTEN_PORT + ' is in use: another bridge is already running');
		process.exit(0);
	}
	throw e;
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
	log('zotero-for-onlyoffice-bridge ' + VERSION + ' listening on 127.0.0.1:' + LISTEN_PORT +
		' (Zotero at ' + ZOTERO.host + ':' + ZOTERO.port + ', native dialogs ' + (nativeDialogsAvailable() ? 'on' : 'off') + ')');
});
