#!/usr/bin/env node
// zotero-for-onlyoffice-convert — part of Zotero for ONLYOFFICE
// (https://github.com/mihasm/zotero-for-onlyoffice), installed by its install.js.
//
// Converts the Zotero citations of a .docx written by Word or LibreOffice into the
// content controls the ONLYOFFICE plugin works with, so Zotero can edit and refresh
// them in ONLYOFFICE. It understands both ways Zotero stores citations there:
//
// - Fields (Word's default): a field "ADDIN ZOTERO_ITEM CSL_CITATION {...}" around
//   the citation text, "ADDIN ZOTERO_BIBL {...} CSL_BIBLIOGRAPHY" around the
//   bibliography.
// - Bookmarks (LibreOffice's .docx, Word's "store citations as bookmarks"): a
//   bookmark ZOTERO_BREF_<id> around the text, the field code in the custom
//   properties ZOTERO_BREF_<id>_1.._n.
//
// The document preferences (ZOTERO_PREF_1.._n) move to ZOTERO_DOCUMENT_DATA.
// Afterwards the citations are live in ONLYOFFICE only; Word and LibreOffice see
// them as plain text.
//
// Usage: zotero-for-onlyoffice-convert FILE.docx [OUT.docx]
// Without OUT the file is converted in place, after a copy
// "FILE (before Zotero for ONLYOFFICE).docx" is written next to it.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// --------------------------------------------------------------------- zip

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(buf) {
	if (zlib.crc32) return zlib.crc32(buf) >>> 0;
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** Entries of a zip archive, in order: {name, data, time, date} */
function readZip(buf) {
	let eocd = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
		if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
	}
	if (eocd < 0) throw new Error('not a .docx (zip) file');
	const count = buf.readUInt16LE(eocd + 10);
	let p = buf.readUInt32LE(eocd + 16);
	const entries = [];
	for (let i = 0; i < count; i++) {
		if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip directory');
		const method = buf.readUInt16LE(p + 10);
		const time = buf.readUInt16LE(p + 12);
		const date = buf.readUInt16LE(p + 14);
		const csize = buf.readUInt32LE(p + 20);
		const nameLen = buf.readUInt16LE(p + 28);
		const extraLen = buf.readUInt16LE(p + 30);
		const commentLen = buf.readUInt16LE(p + 32);
		const local = buf.readUInt32LE(p + 42);
		const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
		const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
		const raw = buf.subarray(start, start + csize);
		let data;
		if (method === 0) data = Buffer.from(raw);
		else if (method === 8) data = zlib.inflateRawSync(raw);
		else throw new Error('unsupported zip compression in ' + name);
		entries.push({ name, data, time, date });
		p += 46 + nameLen + extraLen + commentLen;
	}
	return entries;
}

function writeZip(entries) {
	const locals = [];
	const central = [];
	let offset = 0;
	for (const e of entries) {
		const name = Buffer.from(e.name, 'utf8');
		const comp = zlib.deflateRawSync(e.data);
		const crc = crc32(e.data);
		const h = Buffer.alloc(30);
		h.writeUInt32LE(0x04034b50, 0);
		h.writeUInt16LE(20, 4);
		h.writeUInt16LE(0x0800, 6); // UTF-8 names
		h.writeUInt16LE(8, 8);
		h.writeUInt16LE(e.time || 0, 10);
		h.writeUInt16LE(e.date || 0x21, 12);
		h.writeUInt32LE(crc, 14);
		h.writeUInt32LE(comp.length, 18);
		h.writeUInt32LE(e.data.length, 22);
		h.writeUInt16LE(name.length, 26);
		h.writeUInt16LE(0, 28);
		locals.push(h, name, comp);
		const c = Buffer.alloc(46);
		c.writeUInt32LE(0x02014b50, 0);
		c.writeUInt16LE(20, 4);
		c.writeUInt16LE(20, 6);
		c.writeUInt16LE(0x0800, 8);
		c.writeUInt16LE(8, 10);
		c.writeUInt16LE(e.time || 0, 12);
		c.writeUInt16LE(e.date || 0x21, 14);
		c.writeUInt32LE(crc, 16);
		c.writeUInt32LE(comp.length, 20);
		c.writeUInt32LE(e.data.length, 24);
		c.writeUInt16LE(name.length, 28);
		c.writeUInt32LE(offset, 42);
		central.push(c, name);
		offset += 30 + name.length + comp.length;
	}
	const centralBuf = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralBuf.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat(locals.concat([centralBuf, end]));
}

// --------------------------------------------------------------------- xml

function unescapeXml(s) {
	return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (m, e) => {
		if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
		return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e];
	});
}

function escapeXml(s, attribute) {
	s = String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	return attribute ? s.replace(/"/g, '&quot;') : s;
}

/** Whether a fragment of document.xml opens and closes its own elements */
function balanced(fragment) {
	const stack = [];
	const re = /<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g;
	let m;
	while ((m = re.exec(fragment))) {
		if (!m[2]) continue;
		if (m[3]) continue;
		if (m[1]) {
			if (stack.pop() !== m[2]) return false;
		} else stack.push(m[2]);
	}
	return stack.length === 0;
}

const PARAGRAPH = /<w:p[ >]|<\/w:p>/;

function paragraphStart(doc, pos) {
	return Math.max(doc.lastIndexOf('<w:p>', pos), doc.lastIndexOf('<w:p ', pos));
}

function paragraphEnd(doc, pos) {
	const i = doc.indexOf('</w:p>', pos);
	return i < 0 ? -1 : i + 6;
}

let nextId = 1000000;

function control(alias, code, content) {
	return '<w:sdt><w:sdtPr><w:alias w:val="' + alias + '"/><w:tag w:val="' + escapeXml(code, true) + '"/>' +
		'<w:id w:val="' + (nextId++) + '"/></w:sdtPr><w:sdtContent>' + content + '</w:sdtContent></w:sdt>';
}

/** "ADDIN ZOTERO_ITEM CSL_CITATION {...}" / "ZOTERO_BIBL {...}" -> "ITEM CSL_CITATION {...}" / "BIBL {...}" */
function zoteroCode(raw) {
	const code = raw.trim().replace(/^ADDIN\s+/, '');
	if (!/^ZOTERO_(ITEM|CITATION|BIBL)\b/.test(code)) return null;
	return code.replace(/^ZOTERO_/, '');
}

/**
 * Wrap doc[start, end) in a content control. inner is what goes inside: the same
 * text without the field's or bookmark's own markup. Inline when the span stays in
 * one paragraph, otherwise (a bibliography) the paragraphs it touches become a
 * block-level control. Returns [newDoc, resumeAt] or null when it cannot be done.
 */
function wrap(doc, start, end, innerRanges, code) {
	const bibliography = code.startsWith('BIBL');
	const alias = bibliography ? 'Zotero Bibliography' : 'Zotero Citation';
	const span = doc.slice(start, end);
	const inner = innerRanges.map(([a, b]) => doc.slice(a, b)).join('');
	if (!PARAGRAPH.test(span) && balanced(inner)) {
		const c = control(alias, code, inner);
		return [doc.slice(0, start) + c + doc.slice(end), start + c.length];
	}
	if (!bibliography) return null;
	const p0 = paragraphStart(doc, start);
	const p1 = paragraphEnd(doc, end);
	if (p0 < 0 || p1 < 0) return null;
	const block = doc.slice(p0, start) + inner + doc.slice(end, p1);
	if (!balanced(block)) return null;
	const c = control(alias, code, block);
	return [doc.slice(0, p0) + c + doc.slice(p1), p0 + c.length];
}

// ------------------------------------------------------------- conversion

function customProperties(xml) {
	const props = {};
	const re = /<property\b[^>]*?\bname="([^"]+)"[^>]*>\s*<vt:lpwstr>([\s\S]*?)<\/vt:lpwstr>\s*<\/property>/g;
	let m;
	while ((m = re.exec(xml))) props[unescapeXml(m[1])] = unescapeXml(m[2]);
	return props;
}

function joined(props, prefix) {
	let out = '';
	for (let i = 1; (prefix + i) in props; i++) out += props[prefix + i];
	return out;
}

/** Bookmarks ZOTERO_BREF_<id> with their codes in the custom properties */
function convertBookmarks(doc, props, stats) {
	const startRe = /<w:bookmarkStart\b[^>]*?w:id="(\d+)"[^>]*?w:name="(ZOTERO_BREF_[^"]+)"[^>]*\/>|<w:bookmarkStart\b[^>]*?w:name="(ZOTERO_BREF_[^"]+)"[^>]*?w:id="(\d+)"[^>]*\/>/g;
	let pos = 0;
	for (;;) {
		startRe.lastIndex = pos;
		const m = startRe.exec(doc);
		if (!m) break;
		const id = m[1] || m[4];
		const name = m[2] || m[3];
		const endRe = new RegExp('<w:bookmarkEnd\\b[^>]*?w:id="' + id + '"[^>]*/>', 'g');
		endRe.lastIndex = m.index + m[0].length;
		const e = endRe.exec(doc);
		const code = zoteroCode(joined(props, name + '_'));
		const done = e && code && wrap(doc, m.index, e.index + e[0].length, [[m.index + m[0].length, e.index]], code);
		if (!done) {
			stats.failed.push(name);
			pos = m.index + m[0].length;
			continue;
		}
		code.startsWith('BIBL') ? stats.bibliographies++ : stats.citations++;
		[doc, pos] = done;
	}
	return doc;
}

/** Word fields: complex (fldChar begin/separate/end) and simple (fldSimple) */
function convertFields(doc, stats) {
	const token = /<w:r(?=[\s>])[^>]*?(\/?)>|<\/w:r>|<w:fldChar\b[^>]*?w:fldCharType="(begin|separate|end)"[^>]*>|<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>|<w:fldSimple\b[^>]*?w:instr="([^"]*)"[^>]*>([\s\S]*?)<\/w:fldSimple>/g;
	const stack = [];
	let runStart = -1;
	let pending = null; // 'separate' | 'end': applied at the end of the current run
	let pos = 0;
	for (;;) {
		token.lastIndex = pos;
		const m = token.exec(doc);
		if (!m) break;
		pos = m.index + m[0].length;
		const t = m[0];
		if (m[4] !== undefined) {
			const code = zoteroCode(unescapeXml(m[4]));
			if (!code) continue;
			const startTag = t.slice(0, t.indexOf('>') + 1);
			const done = wrap(doc, m.index, pos, [[m.index + startTag.length, pos - '</w:fldSimple>'.length]], code);
			if (!done) { stats.failed.push('fldSimple at ' + m.index); continue; }
			code.startsWith('BIBL') ? stats.bibliographies++ : stats.citations++;
			[doc, pos] = done;
			continue;
		}
		if (t.startsWith('<w:r') && !t.startsWith('<w:rPr')) {
			if (!m[1]) runStart = m.index;
			continue;
		}
		if (t === '</w:r>') {
			const field = stack[stack.length - 1];
			if (field && pending === 'separate') field.resultStart = pos;
			if (field && pending === 'end') {
				stack.pop();
				field.end = pos;
				if (field.resultStart == null) field.resultStart = field.resultEnd;
				const code = zoteroCode(field.instr);
				if (code) {
					const done = wrap(doc, field.start, field.end, [[field.resultStart, field.resultEnd]], code);
					if (done) {
						code.startsWith('BIBL') ? stats.bibliographies++ : stats.citations++;
						[doc, pos] = done;
					} else stats.failed.push('field at ' + field.start);
				}
			}
			pending = null;
			continue;
		}
		if (m[2] === 'begin') {
			stack.push({ start: runStart, instr: '', resultStart: null, resultEnd: null });
		} else if (m[2] === 'separate') {
			if (stack.length) pending = 'separate';
		} else if (m[2] === 'end') {
			if (stack.length) {
				stack[stack.length - 1].resultEnd = runStart;
				pending = 'end';
			}
		} else if (m[3] !== undefined && stack.length && stack[stack.length - 1].resultStart == null) {
			stack[stack.length - 1].instr += unescapeXml(m[3]);
		}
	}
	return doc;
}

/**
 * Convert a .docx buffer. Returns {buffer, citations, bibliographies, failed};
 * throws when the document has nothing to convert.
 */
function convertDocx(input) {
	const entries = readZip(input);
	const get = (name) => entries.find((e) => e.name === name);
	const docEntry = get('word/document.xml');
	if (!docEntry) throw new Error('not a Word document (no word/document.xml)');
	const customEntry = get('docProps/custom.xml');
	const custom = customEntry ? customEntry.data.toString('utf8') : '';
	const props = customProperties(custom);
	if ('ZOTERO_DOCUMENT_DATA' in props) throw new Error('already converted for ONLYOFFICE');
	const prefs = joined(props, 'ZOTERO_PREF_');
	if (!prefs) throw new Error('no Zotero document preferences (ZOTERO_PREF_1): no Zotero citations from Word or LibreOffice in this file');

	const stats = { citations: 0, bibliographies: 0, failed: [] };
	let doc = docEntry.data.toString('utf8');
	doc = convertBookmarks(doc, props, stats);
	doc = convertFields(doc, stats);
	if (!stats.citations && !stats.bibliographies && !stats.failed.length) throw new Error('no Zotero citations found');
	docEntry.data = Buffer.from(doc, 'utf8');

	// The field type changes, and Zotero has to send the bibliography style again
	const data = prefs
		.replace(/(<pref name="fieldType" value=")[^"]*(")/, '$1Http$2')
		.replace(/bibliographyStyleHasBeenSet="1"/, 'bibliographyStyleHasBeenSet="0"');
	let xml = custom.replace(/<property\b[^>]*?\bname="ZOTERO_(BREF|PREF)_[^"]*"[^>]*>[\s\S]*?<\/property>/g, '');
	const pids = (xml.match(/\bpid="(\d+)"/g) || []).map((s) => Number(s.replace(/\D/g, '')));
	xml = xml.replace('</Properties>', '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="' +
		(Math.max(1, ...pids) + 1) + '" name="ZOTERO_DOCUMENT_DATA"><vt:lpwstr>' + escapeXml(data) + '</vt:lpwstr></property></Properties>');
	customEntry.data = Buffer.from(xml, 'utf8');

	return { buffer: writeZip(entries), ...stats };
}

function main(argv) {
	const args = argv.filter((a) => a !== '--');
	if (args.length < 1 || args.length > 2 || args[0] === '-h' || args[0] === '--help') {
		console.log('Usage: zotero-for-onlyoffice-convert FILE.docx [OUT.docx]\n\n' +
			'Converts the Zotero citations of a Word or LibreOffice document for the\n' +
			'Zotero plugin in ONLYOFFICE. Without OUT, FILE is converted in place and a\n' +
			'backup "FILE (before Zotero for ONLYOFFICE).docx" is kept next to it.\n' +
			'Close the document in every editor first.');
		return args.length ? 0 : 2;
	}
	const src = args[0];
	let result;
	try {
		result = convertDocx(fs.readFileSync(src));
	} catch (e) {
		console.error(path.basename(src) + ': ' + e.message);
		return 1;
	}
	let dst = args[1];
	if (!dst) {
		dst = src;
		const backup = src.replace(/\.docx$/i, '') + ' (before Zotero for ONLYOFFICE).docx';
		fs.copyFileSync(src, backup);
		console.log('backup: ' + backup);
	}
	const tmp = dst + '.converting';
	fs.writeFileSync(tmp, result.buffer);
	fs.renameSync(tmp, dst);
	console.log('converted ' + result.citations + ' citation' + (result.citations === 1 ? '' : 's') +
		' and ' + result.bibliographies + ' bibliograph' + (result.bibliographies === 1 ? 'y' : 'ies') + ': ' + dst);
	if (result.failed.length) {
		console.error('could not convert ' + result.failed.length + ' Zotero field(s), left as plain text: ' + result.failed.join(', '));
		return 1;
	}
	return 0;
}

module.exports = { convertDocx, readZip, writeZip, balanced };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
