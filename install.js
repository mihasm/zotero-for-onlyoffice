#!/usr/bin/env node
// Installer of Zotero for ONLYOFFICE — https://github.com/mihasm/zotero-for-onlyoffice
//
//   node install.js              install or update, and start the bridge
//   node install.js --uninstall  remove everything this installer put in place
//   node install.js --status     show what is installed and whether the bridge runs
//
// It installs, for the current user only (no administrator rights):
// - the plugin into the ONLYOFFICE desktop editors' user plugin folder (every
//   installation found: native, Flatpak, Snap);
// - the bridge and the converter into a folder of their own, with the commands
//   zotero-for-onlyoffice-convert (and on Windows its .cmd) on the PATH;
// - the bridge as a login item: a LaunchAgent on macOS, a systemd user service
//   (or an XDG autostart entry) on Linux, a Run entry on Windows;
// - on macOS, a remap of the editors' hidden "Show Colors" menu item, which is
//   also on Cmd+Shift+C.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const NAME = 'zotero-for-onlyoffice';
const PLUGIN_GUID = '{815C6DE9-AB04-4CB1-893E-AAE76398B9A5}';
const LAUNCH_AGENT = 'io.github.mihasm.zotero-for-onlyoffice';
const SYSTEMD_UNIT = 'zotero-for-onlyoffice-bridge.service';
const WINDOWS_RUN_VALUE = 'Zotero for ONLYOFFICE bridge';
const BRIDGE_PORT = 23120;
const HERE = __dirname;
const HOME = os.homedir();
const PLATFORM = process.platform;

const args = process.argv.slice(2);

/**
 * The node to put in launchers: the one on the PATH when it is this same binary
 * (/opt/homebrew/bin/node rather than a versioned Cellar path that an upgrade removes)
 */
const NODE = (() => {
	let real;
	try { real = fs.realpathSync(process.execPath); } catch (e) { return process.execPath; }
	const exe = PLATFORM === 'win32' ? 'node.exe' : 'node';
	for (const d of (process.env.PATH || '').split(path.delimiter)) {
		if (!d) continue;
		const candidate = path.join(d, exe);
		try {
			if (fs.realpathSync(candidate) === real) return candidate;
		} catch (e) {}
	}
	return process.execPath;
})();
const DRY = args.includes('--dry-run');

function say(msg) {
	console.log(msg);
}

function run(file, argv, opts) {
	if (DRY) {
		say('  [dry run] ' + file + ' ' + argv.join(' '));
		return '';
	}
	return execFileSync(file, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...opts });
}

function tryRun(file, argv) {
	try {
		return { ok: true, out: run(file, argv) };
	} catch (e) {
		return { ok: false, out: String(e.stdout || '') + String(e.stderr || e.message) };
	}
}

function write(file, content, mode) {
	if (DRY) {
		say('  [dry run] write ' + file);
		return;
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	if (mode) fs.chmodSync(file, mode);
}

function remove(p) {
	if (!fs.existsSync(p)) return false;
	if (!DRY) fs.rmSync(p, { recursive: true, force: true });
	return true;
}

function copyDir(src, dst) {
	if (DRY) {
		say('  [dry run] copy ' + src + ' -> ' + dst);
		return;
	}
	fs.rmSync(dst, { recursive: true, force: true });
	fs.mkdirSync(dst, { recursive: true });
	fs.cpSync(src, dst, { recursive: true });
}

// ------------------------------------------------------------------ places

/** User plugin folders of the ONLYOFFICE desktop editors, existing or not */
function pluginRoots() {
	if (PLATFORM === 'darwin') {
		return [path.join(HOME, 'Library/Application Support/asc.onlyoffice.ONLYOFFICE/data/sdkjs-plugins')];
	}
	if (PLATFORM === 'win32') {
		const local = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
		return [path.join(local, 'ONLYOFFICE', 'DesktopEditors', 'data', 'sdkjs-plugins')];
	}
	const data = process.env.XDG_DATA_HOME || path.join(HOME, '.local/share');
	return [
		path.join(data, 'onlyoffice/desktopeditors/sdkjs-plugins'),
		path.join(HOME, '.var/app/org.onlyoffice.desktopeditors/data/onlyoffice/desktopeditors/sdkjs-plugins'),
		path.join(HOME, 'snap/onlyoffice-desktopeditors/current/.local/share/onlyoffice/desktopeditors/sdkjs-plugins'),
	];
}

/** The plugin folders to install into: every installation that has run once, else the native one */
function pluginTargets() {
	const roots = pluginRoots();
	const used = roots.filter((r) => fs.existsSync(path.dirname(r)));
	return (used.length ? used : roots.slice(0, 1)).map((r) => path.join(r, PLUGIN_GUID));
}

function appDir() {
	if (PLATFORM === 'darwin') return path.join(HOME, 'Library/Application Support', NAME);
	if (PLATFORM === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), NAME);
	return path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local/share'), NAME);
}

function logFile() {
	if (PLATFORM === 'darwin') return path.join(HOME, 'Library/Logs', NAME + '-bridge.log');
	return path.join(appDir(), 'bridge.log');
}

/** Where the commands go: ~/.local/bin on macOS and Linux, the app folder (put on the PATH) on Windows */
function binDir() {
	return PLATFORM === 'win32' ? path.join(appDir(), 'bin') : path.join(HOME, '.local/bin');
}

const launchAgentPlist = () => path.join(HOME, 'Library/LaunchAgents', LAUNCH_AGENT + '.plist');
const systemdUnitFile = () => path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'systemd/user', SYSTEMD_UNIT);
const autostartFile = () => path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'autostart', NAME + '-bridge.desktop');

// ------------------------------------------------------------------ bridge

function bridgeVersion() {
	return new Promise((resolve) => {
		const req = http.get({ host: '127.0.0.1', port: BRIDGE_PORT, path: '/oo/version', timeout: 1500 }, (res) => {
			let body = '';
			res.on('data', (c) => (body += c));
			res.on('end', () => {
				try { resolve(JSON.parse(body)); } catch (e) { resolve({ unknown: true }); }
			});
		});
		req.on('error', () => resolve(null));
		req.on('timeout', () => { req.destroy(); resolve(null); });
	});
}

async function waitForBridge(up) {
	for (let i = 0; i < 40; i++) {
		const v = await bridgeVersion();
		if (!!v === up) return v;
		await new Promise((r) => setTimeout(r, 250));
	}
	return bridgeVersion();
}

function shQuote(s) {
	return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/** Named launcher, so that login items show "zotero-for-onlyoffice-bridge" and not "node" */
function writeLauncher(dir) {
	const bridge = path.join(dir, 'zotero-for-onlyoffice-bridge.js');
	if (PLATFORM === 'win32') return bridge;
	const launcher = path.join(dir, 'zotero-for-onlyoffice-bridge');
	write(launcher, '#!/bin/sh\n' +
		'# zotero-for-onlyoffice-bridge: starts the bridge between the Zotero plugin in the\n' +
		'# ONLYOFFICE desktop editors and the Zotero app. Installed by Zotero for ONLYOFFICE\n' +
		'# (https://github.com/mihasm/zotero-for-onlyoffice); remove with: node install.js --uninstall\n' +
		'exec ' + shQuote(NODE) + ' ' + shQuote(bridge) + ' --log ' + shQuote(logFile()) + ' "$@"\n', 0o755);
	return launcher;
}

function xml(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function psQuote(s) {
	return "'" + String(s).replace(/'/g, "''") + "'";
}

/** PowerShell that starts the bridge without a console window, detached from whoever runs it */
function windowsStartScript(dir) {
	const bridge = path.join(dir, 'zotero-for-onlyoffice-bridge.js');
	return 'Start-Process -WindowStyle Hidden -FilePath ' + psQuote(NODE) +
		' -ArgumentList ' + psQuote('"' + bridge + '" --log "' + logFile() + '"');
}

/** The command line in the Windows Run key */
function windowsStartCommand(dir) {
	return 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "' +
		windowsStartScript(dir).replace(/"/g, '\\"') + '"';
}

function stopWindowsBridge() {
	// Only node processes running this bridge script
	tryRun('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
		"Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*zotero-for-onlyoffice-bridge.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"]);
}

function hasSystemd() {
	if (PLATFORM !== 'linux') return false;
	return tryRun('systemctl', ['--user', 'show-environment']).ok;
}

async function installAutostart(dir) {
	if (PLATFORM === 'darwin') {
		const launcher = writeLauncher(dir);
		const uid = String(process.getuid());
		tryRun('launchctl', ['bootout', 'gui/' + uid + '/' + LAUNCH_AGENT]);
		if (!DRY) await waitForBridge(false);
		write(launchAgentPlist(), '<?xml version="1.0" encoding="UTF-8"?>\n' +
			'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
			'<plist version="1.0">\n<dict>\n' +
			'\t<key>Label</key>\n\t<string>' + LAUNCH_AGENT + '</string>\n' +
			'\t<key>ProgramArguments</key>\n\t<array>\n\t\t<string>' + xml(launcher) + '</string>\n\t</array>\n' +
			'\t<key>RunAtLoad</key>\n\t<true/>\n' +
			'\t<key>KeepAlive</key>\n\t<true/>\n' +
			'\t<key>ProcessType</key>\n\t<string>Interactive</string>\n' +
			'</dict>\n</plist>\n');
		run('launchctl', ['bootstrap', 'gui/' + uid, launchAgentPlist()]);
		return 'LaunchAgent ' + LAUNCH_AGENT;
	}
	if (PLATFORM === 'win32') {
		stopWindowsBridge();
		if (!DRY) await waitForBridge(false);
		const cmd = windowsStartCommand(dir);
		run('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', WINDOWS_RUN_VALUE, '/t', 'REG_SZ', '/d', cmd, '/f']);
		// Started the way the next login starts it, so that it outlives this console
		run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', windowsStartScript(dir)]);
		return 'Run entry "' + WINDOWS_RUN_VALUE + '" (HKCU)';
	}
	const launcher = writeLauncher(dir);
	if (hasSystemd()) {
		write(systemdUnitFile(), '[Unit]\n' +
			'Description=Zotero for ONLYOFFICE bridge (between the ONLYOFFICE plugin and Zotero)\n' +
			'Documentation=https://github.com/mihasm/zotero-for-onlyoffice\n\n' +
			'[Service]\nExecStart=' + launcher + '\nRestart=on-failure\n\n' +
			'[Install]\nWantedBy=default.target\n');
		remove(autostartFile());
		run('systemctl', ['--user', 'daemon-reload']);
		run('systemctl', ['--user', 'enable', SYSTEMD_UNIT]);
		run('systemctl', ['--user', 'restart', SYSTEMD_UNIT]);
		return 'systemd user service ' + SYSTEMD_UNIT;
	}
	tryRun('pkill', ['-f', 'zotero-for-onlyoffice-bridge.js']);
	if (!DRY) await waitForBridge(false);
	write(autostartFile(), '[Desktop Entry]\nType=Application\nName=Zotero for ONLYOFFICE bridge\n' +
		'Comment=Lets the Zotero plugin in ONLYOFFICE talk to Zotero\nExec=' + launcher + '\n' +
		'NoDisplay=true\nX-GNOME-Autostart-enabled=true\n');
	if (!DRY) spawn(launcher, [], { detached: true, stdio: 'ignore' }).unref();
	return 'autostart entry ' + autostartFile();
}

function removeAutostart() {
	const removed = [];
	if (PLATFORM === 'darwin') {
		tryRun('launchctl', ['bootout', 'gui/' + process.getuid() + '/' + LAUNCH_AGENT]);
		if (remove(launchAgentPlist())) removed.push(launchAgentPlist());
	} else if (PLATFORM === 'win32') {
		if (tryRun('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', WINDOWS_RUN_VALUE, '/f']).ok) {
			removed.push('Run entry "' + WINDOWS_RUN_VALUE + '"');
		}
		stopWindowsBridge();
	} else {
		if (fs.existsSync(systemdUnitFile())) {
			tryRun('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]);
			remove(systemdUnitFile());
			tryRun('systemctl', ['--user', 'daemon-reload']);
			removed.push(systemdUnitFile());
		}
		if (remove(autostartFile())) removed.push(autostartFile());
		tryRun('pkill', ['-f', 'zotero-for-onlyoffice-bridge.js']);
	}
	return removed;
}

// ---------------------------------------------------------------- commands

function installCommands(dir) {
	const bin = binDir();
	const convert = path.join(dir, 'zotero-for-onlyoffice-convert.js');
	if (PLATFORM === 'win32') {
		// .cmd for cmd and PowerShell, an extensionless script for Git Bash
		write(path.join(bin, 'zotero-for-onlyoffice-convert.cmd'),
			'@echo off\r\nrem Zotero for ONLYOFFICE: converts Zotero citations of Word/LibreOffice documents\r\n' +
			'"' + NODE + '" "' + convert + '" %*\r\n');
		write(path.join(bin, 'zotero-for-onlyoffice-convert'),
			'#!/bin/sh\n# Zotero for ONLYOFFICE: converts Zotero citations of Word/LibreOffice documents\n' +
			'exec ' + shQuote(NODE.replace(/\\/g, '/')) + ' ' + shQuote(convert.replace(/\\/g, '/')) + ' "$@"\n', 0o755);
		addToWindowsPath(bin);
	} else {
		write(path.join(bin, 'zotero-for-onlyoffice-convert'),
			'#!/bin/sh\n# Zotero for ONLYOFFICE (https://github.com/mihasm/zotero-for-onlyoffice):\n' +
			'# converts the Zotero citations of Word/LibreOffice documents for ONLYOFFICE.\n' +
			'exec ' + shQuote(NODE) + ' ' + shQuote(convert) + ' "$@"\n', 0o755);
	}
	return bin;
}

function userPathWindows() {
	const r = tryRun('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetEnvironmentVariable('Path','User')"]);
	return r.ok ? r.out.trim() : '';
}

function addToWindowsPath(dir) {
	const current = userPathWindows();
	const parts = current.split(';').filter(Boolean);
	if (parts.some((p) => p.toLowerCase() === dir.toLowerCase())) return;
	run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
		"[Environment]::SetEnvironmentVariable('Path', " + psQuote(parts.concat([dir]).join(';')) + ", 'User')"]);
}

function removeFromWindowsPath(dir) {
	const current = userPathWindows();
	const parts = current.split(';').filter(Boolean);
	const kept = parts.filter((p) => p.toLowerCase() !== dir.toLowerCase());
	if (kept.length === parts.length) return;
	run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
		"[Environment]::SetEnvironmentVariable('Path', " + psQuote(kept.join(';')) + ", 'User')"]);
}

// ------------------------------------------------- macOS "Show Colors" key

function remapShowColors(on) {
	if (PLATFORM !== 'darwin') return;
	if (on) {
		// Cmd+Option+Ctrl+Shift+K: out of the way
		run('defaults', ['write', 'asc.onlyoffice.ONLYOFFICE', 'NSUserKeyEquivalents', '-dict-add', 'Show Colors', '@~^$k']);
	} else {
		const r = tryRun('defaults', ['read', 'asc.onlyoffice.ONLYOFFICE', 'NSUserKeyEquivalents']);
		if (r.ok && /Show Colors/.test(r.out)) {
			const left = r.out.split('\n').filter((l) => /=/.test(l) && !/Show Colors/.test(l));
			if (left.length) {
				tryRun('/usr/libexec/PlistBuddy', ['-c', 'Delete :NSUserKeyEquivalents:Show\\ Colors',
					path.join(HOME, 'Library/Preferences/asc.onlyoffice.ONLYOFFICE.plist')]);
			} else {
				tryRun('defaults', ['delete', 'asc.onlyoffice.ONLYOFFICE', 'NSUserKeyEquivalents']);
			}
		}
	}
}

// ------------------------------------------------------------------- main

function zoteroRunning() {
	return new Promise((resolve) => {
		const req = http.get({ host: '127.0.0.1', port: 23119, path: '/connector/ping', timeout: 1500 }, (res) => {
			res.resume();
			resolve(res.statusCode === 200);
		});
		req.on('error', () => resolve(false));
		req.on('timeout', () => { req.destroy(); resolve(false); });
	});
}

async function install() {
	const major = Number(process.versions.node.split('.')[0]);
	if (major < 18) throw new Error('Node.js 18 or newer is needed (this is ' + process.version + ')');
	if (!['darwin', 'win32', 'linux'].includes(PLATFORM)) throw new Error('unsupported system: ' + PLATFORM);

	say('Zotero for ONLYOFFICE: installing for ' + os.userInfo().username + ' on ' + PLATFORM);
	for (const target of pluginTargets()) {
		copyDir(path.join(HERE, 'plugin'), target);
		say('  plugin     ' + target);
	}

	const dir = appDir();
	if (!DRY) fs.mkdirSync(dir, { recursive: true });
	for (const f of ['bridge/zotero-for-onlyoffice-bridge.js', 'tools/zotero-for-onlyoffice-convert.js']) {
		const dst = path.join(dir, path.basename(f));
		if (DRY) say('  [dry run] copy ' + f + ' -> ' + dst);
		else fs.copyFileSync(path.join(HERE, f), dst);
	}
	say('  programs   ' + dir);
	say('  command    ' + path.join(installCommands(dir), 'zotero-for-onlyoffice-convert'));
	say('  autostart  ' + await installAutostart(dir));
	remapShowColors(true);
	if (PLATFORM === 'darwin') say('  shortcut   Cmd+Shift+C freed from the hidden "Show Colors" menu item');

	if (!DRY) {
		const v = await waitForBridge(true);
		say(v ? '  bridge     running on 127.0.0.1:' + BRIDGE_PORT + (v.version ? ' (' + v.version + ')' : '') +
			(v.nativeDialogs === false ? ', alerts appear inside ONLYOFFICE (install zenity or kdialog for native ones)' : '')
			: '  bridge     NOT running, see ' + logFile());
		if (!(await zoteroRunning())) say('\nZotero does not answer on 127.0.0.1:23119: start Zotero (7 or newer) before citing.');
		if (PLATFORM === 'win32') say('\nOpen a new terminal to use zotero-for-onlyoffice-convert.');
		else if (!(process.env.PATH || '').split(':').includes(binDir())) say('\nAdd ' + binDir() + ' to your PATH to use zotero-for-onlyoffice-convert.');
		say('\nDone. Restart ONLYOFFICE (or reopen your documents), then press ' +
			(PLATFORM === 'darwin' ? 'Cmd+Shift+C' : 'Ctrl+Shift+C') + ' in a document.');
	}
}

async function uninstall() {
	say('Zotero for ONLYOFFICE: uninstalling');
	for (const root of pluginRoots()) {
		const p = path.join(root, PLUGIN_GUID);
		if (remove(p)) say('  removed ' + p);
	}
	for (const r of removeAutostart()) say('  removed ' + r);
	const bin = binDir();
	for (const f of ['zotero-for-onlyoffice-convert', 'zotero-for-onlyoffice-convert.cmd']) {
		if (remove(path.join(bin, f))) say('  removed ' + path.join(bin, f));
	}
	if (PLATFORM === 'win32') removeFromWindowsPath(bin);
	if (remove(appDir())) say('  removed ' + appDir());
	if (PLATFORM === 'darwin' && remove(logFile())) say('  removed ' + logFile());
	remapShowColors(false);
	say('Done. Documents keep their citations; reinstall to edit them with Zotero again.');
}

async function status() {
	for (const root of pluginRoots()) {
		const p = path.join(root, PLUGIN_GUID);
		if (fs.existsSync(p)) {
			let v = '?';
			try { v = JSON.parse(fs.readFileSync(path.join(p, 'config.json'), 'utf8')).version; } catch (e) {}
			say('plugin     ' + p + ' (' + v + ')');
		}
	}
	say('programs   ' + (fs.existsSync(appDir()) ? appDir() : 'not installed'));
	const v = await bridgeVersion();
	say('bridge     ' + (v ? 'running (' + (v.version || '?') + ')' : 'not running') + ', log ' + logFile());
	say('Zotero     ' + ((await zoteroRunning()) ? 'running' : 'not running'));
}

const main = args.includes('--uninstall') ? uninstall : args.includes('--status') ? status : install;
if (args.includes('-h') || args.includes('--help')) {
	say('node install.js [--uninstall | --status] [--dry-run]');
} else {
	main().catch((e) => {
		console.error('\nInstallation failed: ' + e.message);
		process.exitCode = 1;
	});
}
