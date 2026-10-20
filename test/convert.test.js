'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { convertDocx, readZip, writeZip, balanced } = require('../tools/zotero-for-onlyoffice-convert.js');

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const CITE = 'ZOTERO_ITEM CSL_CITATION {"citationID":"abc","properties":{"formattedCitation":"(Doe 2020)","plainCitation":"(Doe 2020)","noteIndex":0},"citationItems":[{"id":1,"uris":["http://zotero.org/users/local/x/items/AAAA1111"]}],"schema":"https://github.com/citation-style-language/schema/raw/master/csl-citation.json"}';
const BIBL = 'ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY';
const PREFS = '<data data-version="3" zotero-version="7.0"><session id="s1"/><style id="http://www.zotero.org/styles/apa" locale="en-US" hasBibliography="1" bibliographyStyleHasBeenSet="1"/><prefs><pref name="fieldType" value="Bookmark"/></prefs></data>';

function esc(s) {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function customXml(props) {
	let pid = 2;
	return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
		Object.entries(props).map(([n, v]) => '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="' + (pid++) + '" name="' + n + '"><vt:lpwstr>' + esc(v) + '</vt:lpwstr></property>').join('') +
		'</Properties>';
}

/** Split a value into 255-character chunks the way Zotero stores long codes */
function chunks(prefix, value) {
	const out = {};
	for (let i = 0; i * 255 < value.length; i++) out[prefix + (i + 1)] = value.slice(i * 255, (i + 1) * 255);
	return out;
}

function docx(body, props) {
	return writeZip([
		{ name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
		{ name: 'word/document.xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><w:document ' + W + '><w:body>' + body + '</w:body></w:document>') },
		{ name: 'docProps/custom.xml', data: Buffer.from(customXml(props)) },
	]);
}

function read(buf, name) {
	return readZip(buf).find((e) => e.name === name).data.toString('utf8');
}

const run = (t) => '<w:r><w:rPr><w:position w:val="0"/></w:rPr><w:t xml:space="preserve">' + t + '</w:t></w:r>';

test('bookmark citations (LibreOffice) become content controls', () => {
	const body =
		'<w:p>' + run('Text ') + '<w:bookmarkStart w:id="1" w:name="ZOTERO_BREF_aaaa"/>' + run('(Doe 2020)') + '<w:bookmarkEnd w:id="1"/>' + run(' more.') + '</w:p>' +
		'<w:p><w:bookmarkStart w:id="2" w:name="ZOTERO_BREF_bbbb"/>' + run('Doe, J. 2020. Title.') + '</w:p>' +
		'<w:p>' + run('Roe, R. 2021. Other.') + '<w:bookmarkEnd w:id="2"/></w:p>' +
		'<w:p><w:bookmarkStart w:id="3" w:name="_Toc1"/>' + run('Heading') + '<w:bookmarkEnd w:id="3"/></w:p>';
	const props = { ...chunks('ZOTERO_PREF_', PREFS), ...chunks('ZOTERO_BREF_aaaa_', CITE), ...chunks('ZOTERO_BREF_bbbb_', BIBL), Other: 'kept' };
	const r = convertDocx(docx(body, props));
	assert.strictEqual(r.citations, 1);
	assert.strictEqual(r.bibliographies, 1);
	assert.deepStrictEqual(r.failed, []);

	const doc = read(r.buffer, 'word/document.xml');
	assert.ok(balanced(doc));
	assert.ok(!doc.includes('ZOTERO_BREF'));
	assert.ok(doc.includes('_Toc1'), 'other bookmarks stay');
	assert.match(doc, /<w:sdt><w:sdtPr><w:alias w:val="Zotero Citation"\/><w:tag w:val="ITEM CSL_CITATION \{&quot;citationID&quot;:&quot;abc&quot;/);
	assert.match(doc, /<w:alias w:val="Zotero Bibliography"\/><w:tag w:val="BIBL \{&quot;uncited/);
	// The citation stays inline, inside its paragraph
	assert.match(doc, /Text <\/w:t><\/w:r><w:sdt>.*?\(Doe 2020\).*?<\/w:sdt><w:r>/);
	// The bibliography control holds both of its paragraphs
	assert.match(doc, /<w:sdtContent><w:p>.*Doe, J\. 2020.*<\/w:p><w:p>.*Roe, R\. 2021.*<\/w:p><\/w:sdtContent>/);

	const custom = read(r.buffer, 'docProps/custom.xml');
	assert.ok(!custom.includes('ZOTERO_BREF') && !custom.includes('ZOTERO_PREF'));
	assert.ok(custom.includes('name="Other"'));
	const data = custom.match(/name="ZOTERO_DOCUMENT_DATA"><vt:lpwstr>(.*?)<\/vt:lpwstr>/)[1];
	assert.ok(data.includes('&lt;pref name="fieldType" value="Http"/&gt;'));
	assert.ok(data.includes('bibliographyStyleHasBeenSet="0"'));
});

test('Word field citations become content controls', () => {
	const field = (code, result) =>
		'<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
		'<w:r><w:instrText xml:space="preserve"> ADDIN ' + esc(code.slice(0, 40)) + '</w:instrText></w:r>' +
		'<w:r><w:instrText xml:space="preserve">' + esc(code.slice(40)) + ' </w:instrText></w:r>' +
		'<w:r><w:fldChar w:fldCharType="separate"/></w:r>' + result + '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
	const body =
		'<w:p>' + run('As shown ') + field(CITE, run('(Doe ') + run('2020)')) + run('.') + '</w:p>' +
		'<w:p>' + run('Page ') + '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' + run('3') + '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>' +
		'<w:p><w:fldSimple w:instr=" ADDIN ' + esc(CITE) + '">' + run('(Doe 2020)') + '</w:fldSimple></w:p>' +
		'<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> ADDIN ' + esc(BIBL) + '</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' + run('Doe, J. 2020.') + '</w:p>' +
		'<w:p>' + run('Roe, R. 2021.') + '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';
	const props = { ...chunks('ZOTERO_PREF_', PREFS.replace('Bookmark', 'Field')) };
	const r = convertDocx(docx(body, props));
	assert.strictEqual(r.citations, 2);
	assert.strictEqual(r.bibliographies, 1);
	assert.deepStrictEqual(r.failed, []);

	const doc = read(r.buffer, 'word/document.xml');
	assert.ok(balanced(doc));
	assert.ok(!doc.includes('ADDIN'));
	assert.ok(doc.includes('PAGE'), 'other fields stay');
	assert.strictEqual((doc.match(/<w:fldChar /g) || []).length, 3, 'only the PAGE field keeps its field characters');
	assert.match(doc, /As shown <\/w:t><\/w:r><w:sdt>.*?<w:sdtContent><w:r>.*?\(Doe <\/w:t><\/w:r><w:r>.*?2020\)<\/w:t><\/w:r><\/w:sdtContent><\/w:sdt><w:r>/);
	assert.match(doc, /<w:alias w:val="Zotero Bibliography"\/>.*Doe, J\. 2020\..*Roe, R\. 2021\..*<\/w:sdtContent><\/w:sdt>/);
});

test('refuses documents without Zotero data or already converted', () => {
	assert.throws(() => convertDocx(docx('<w:p/>', { A: 'b' })), /no Zotero document preferences/);
	const once = convertDocx(docx('<w:p><w:bookmarkStart w:id="1" w:name="ZOTERO_BREF_x"/>' + run('(X)') + '<w:bookmarkEnd w:id="1"/></w:p>',
		{ ...chunks('ZOTERO_PREF_', PREFS), ...chunks('ZOTERO_BREF_x_', CITE) }));
	assert.throws(() => convertDocx(once.buffer), /already converted/);
});

test('zip round trip keeps every entry', () => {
	const entries = [{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'dir/ž.xml', data: Buffer.alloc(100000, 7) }];
	const back = readZip(writeZip(entries));
	assert.deepStrictEqual(back.map((e) => e.name), ['a.txt', 'dir/ž.xml']);
	assert.ok(back[1].data.equals(entries[1].data));
});
