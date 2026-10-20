/*
 * Zotero for ONLYOFFICE — https://github.com/mihasm/zotero-for-onlyoffice
 *
 * Zotero in the ONLYOFFICE desktop editors, used like the Zotero plugin in Word or
 * LibreOffice: Cmd+Shift+C (Ctrl+Shift+C) opens Zotero's own citation dialog,
 * Enter inserts the citation; on an existing citation it edits that citation.
 * A "Zotero" toolbar tab holds the other commands.
 *
 * Speaks Zotero's HTTP integration protocol (the one its Google Docs plugin
 * uses): POST /connector/document/execCommand starts a command, Zotero answers
 * with a request ({command, arguments}) that is carried out on the document and
 * answered via /connector/document/respond, until 'Document.complete'.
 * Requests go through the local bridge (bridge/zotero-for-onlyoffice-bridge.js),
 * which adds the CORS headers Zotero does not send, shows Zotero's alerts as
 * native dialogs and brings ONLYOFFICE back to the front.
 *
 * Fields are content controls:
 *   Tag   = Zotero field code ("ITEM CSL_CITATION {...}", "BIBL {...} CSL_BIBLIOGRAPHY", "TEMP")
 *   Alias = "Zotero Citation" / "Zotero Bibliography"
 * Document preferences live in the custom property ZOTERO_DOCUMENT_DATA.
 *
 * Based on GeneralPawz/onlyoffice-zotero (AGPL-3.0).
 */
(function (window) {
	'use strict';

	var BRIDGE = 'http://127.0.0.1:23120';
	var DATA_PROP = 'ZOTERO_DOCUMENT_DATA';
	// Zotero sends the bibliography style only once per document, so keep it in the file
	var BIB_STYLE_PROP = 'ZOTERO_BIBLIOGRAPHY_STYLE';
	var ALIAS_CITATION = 'Zotero Citation';
	var ALIAS_BIBLIOGRAPHY = 'Zotero Bibliography';
	var docId = 'oo-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

	var busy = false;
	var currentCommand = null;
	var bibStyle = null;

	// ------------------------------------------------------------- bridge helpers

	function log(msg) {
		try {
			fetch(BRIDGE + '/oo/log', { method: 'POST', body: String(msg) }).catch(function () {});
		} catch (e) {}
	}

	var IS_MAC = /Macintosh|Mac OS X/.test(navigator.userAgent);
	var SHORTCUT = IS_MAC ? 'Cmd+Shift+C' : 'Ctrl+Shift+C';

	// Zotero's button sets (0 OK, 1 OK/Cancel, 2 Yes/No, 3 Yes/No/Cancel), left to right,
	// with the answer each button gives Zotero
	var BUTTON_SETS = [
		[['OK', 1]],
		[['Cancel', 0], ['OK', 1]],
		[['No', 0], ['Yes', 1]],
		[['Cancel', 0], ['No', 1], ['Yes', 2]]
	];
	var dialogs = {};

	/** A dialog inside the editor, for when the bridge has no native one */
	function editorAlert(text, buttons) {
		var set = BUTTON_SETS[buttons] || BUTTON_SETS[0];
		var lines = String(text).split('\n').reduce(function (n, l) { return n + 1 + Math.floor(l.length / 60); }, 0);
		return new Promise(function (resolve) {
			var w = new window.Asc.PluginWindow();
			dialogs[w.id] = { window: w, set: set, resolve: resolve };
			w.show({
				url: 'dialog.html#' + encodeURIComponent(text),
				description: 'Zotero',
				isVisual: true,
				isModal: true,
				EditorsSupport: ['word'],
				size: [460, Math.min(420, 60 + lines * 18)],
				buttons: set.map(function (b, i) { return { text: b[0], primary: i === set.length - 1 }; })
			});
		});
	}

	/** Zotero's alert, answered with Zotero's code: a native dialog through the bridge, else one in the editor */
	function alertBox(text, icon, buttons) {
		return fetch(BRIDGE + '/oo/alert', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text: text, icon: icon == null ? 2 : icon, buttons: buttons || 0 })
		}).then(function (r) { return r.json(); }).then(function (j) {
			if (j.unsupported) throw new Error('no native dialogs');
			return j.result;
		}).catch(function () {
			return editorAlert(text, buttons || 0);
		});
	}

	function showError(text) {
		log('error: ' + text);
		return alertBox(text, 0, 0);
	}

	// ---------------------------------------------------------- editor API wrappers

	/** Run func inside the editor context (it only sees `Api` and `Asc.scope`) */
	function editor(func, scope) {
		return new Promise(function (resolve) {
			window.Asc.scope = scope || {};
			window.Asc.plugin.callCommand(func, false, true, resolve);
		});
	}

	function method(name, args) {
		return new Promise(function (resolve) {
			window.Asc.plugin.executeMethod(name, args || [], resolve);
		});
	}

	// ------------------------------------------------------- HTML -> run model

	/**
	 * Convert Zotero's formatted HTML into paragraphs of styled runs:
	 * [[{t, i, b, u, sup, sub, sc}, ...], ...]
	 */
	function htmlToParagraphs(html, splitEntries) {
		var doc = new DOMParser().parseFromString('<body>' + html + '</body>', 'text/html');
		var paragraphs = [];
		var current = [];

		function flush() {
			paragraphs.push(current);
			current = [];
		}

		function walk(node, fmt) {
			if (node.nodeType === 3) {
				var t = node.nodeValue;
				// Skip indentation whitespace between the bibliography's divs
				if (!t || (splitEntries && /^\s*$/.test(t) && /\n/.test(t))) return;
				current.push(Object.assign({ t: t }, fmt));
				return;
			}
			if (node.nodeType !== 1) return;
			var tag = node.tagName.toLowerCase();
			var f = Object.assign({}, fmt);
			if (tag === 'i' || tag === 'em') f.i = true;
			if (tag === 'b' || tag === 'strong') f.b = true;
			if (tag === 'u') f.u = true;
			if (tag === 'sup') f.sup = true;
			if (tag === 'sub') f.sub = true;
			var style = (node.getAttribute('style') || '').toLowerCase();
			if (/font-style:\s*italic/.test(style)) f.i = true;
			if (/font-style:\s*normal/.test(style)) f.i = false;
			if (/font-weight:\s*bold/.test(style)) f.b = true;
			if (/small-caps/.test(style)) f.sc = true;
			if (/text-decoration:\s*underline/.test(style)) f.u = true;
			if (/vertical-align:\s*super/.test(style)) f.sup = true;
			if (/vertical-align:\s*sub/.test(style)) f.sub = true;
			if (tag === 'br') {
				current.push({ br: true });
				return;
			}
			var isEntry = splitEntries && tag === 'div' && /csl-entry/.test(node.className || '');
			if (isEntry && current.length) flush();
			Array.prototype.forEach.call(node.childNodes, function (c) { walk(c, f); });
			// Numeric styles: "[1]" and the entry text are separate divs, aligned by a tab
			if (tag === 'div' && /csl-left-margin/.test(node.className || '')) current.push({ tab: true });
			if (isEntry) flush();
		}

		walk(doc.body, {});
		if (current.length) flush();
		if (!paragraphs.length) paragraphs.push([]);
		return paragraphs;
	}

	// ---------------------------------------------------------------- fields

	/** All Zotero content controls, in document order, as plain objects */
	function listFields() {
		return editor(function () {
			var out = [];
			Api.GetDocument().GetAllContentControls().forEach(function (cc) {
				var alias = cc.GetAlias() || '';
				if (alias.indexOf('Zotero') !== 0) return;
				var text = '';
				try { text = cc.GetRange().GetText({ Math: false, TableCellSeparator: ' ', ParaSeparator: '\n' }) || ''; } catch (e) {}
				out.push({
					id: String(cc.GetInternalId()),
					code: cc.GetTag() || '',
					text: text,
					noteIndex: 0,
					block: cc.GetClassType() === 'blockLvlSdt'
				});
			});
			return out;
		});
	}

	function fieldToWire(f) {
		return { id: f.id, code: f.code, text: f.text, noteIndex: f.noteIndex };
	}

	/** Write runs/paragraphs into the content control with the given internal id */
	function writeContent(id, paragraphs, bib) {
		return editor(function () {
			var s = Asc.scope;
			var target = null;
			Api.GetDocument().GetAllContentControls().forEach(function (cc) {
				if (String(cc.GetInternalId()) === s.id) target = cc;
			});
			if (!target) return false;
			var isBlock = target.GetClassType() === 'blockLvlSdt';

			function fillRuns(runs, add) {
				runs.forEach(function (r) {
					if (r.br || r.tab) {
						var special = Api.CreateRun();
						if (r.br) special.AddLineBreak();
						else special.AddTabStop();
						add(special);
						return;
					}
					var run = Api.CreateRun();
					run.AddText(r.t);
					if (r.i) run.SetItalic(true);
					if (r.b) run.SetBold(true);
					if (r.u) run.SetUnderline(true);
					if (r.sc) run.SetSmallCaps(true);
					if (r.sup) run.SetVertAlign('superscript');
					if (r.sub) run.SetVertAlign('subscript');
					add(run);
				});
			}

			if (isBlock) {
				// RemoveAllElements leaves the control showing its placeholder;
				// sdt.Push (unlike GetContent().Push) clears the placeholder state
				target.RemoveAllElements();
				s.paragraphs.forEach(function (runs) {
					var p = Api.CreateParagraph();
					if (s.bib) {
						if (s.bib.firstLineIndent != null) p.SetIndFirstLine(s.bib.firstLineIndent);
						if (s.bib.indent != null) p.SetIndLeft(s.bib.indent);
						if (s.bib.lineSpacing) p.SetSpacingLine(s.bib.lineSpacing, 'auto');
						if (s.bib.entrySpacing != null) p.SetSpacingAfter(s.bib.entrySpacing);
						if (s.bib.tabStops && s.bib.tabStops.length) {
							p.SetTabs(s.bib.tabStops, s.bib.tabStops.map(function () { return 'left'; }));
						}
					}
					fillRuns(runs, function (r) { p.AddElement(r); });
					target.Push(p);
				});
			} else {
				target.RemoveAllElements();
				var first = true;
				s.paragraphs.forEach(function (runs) {
					if (!first) {
						var br = Api.CreateRun();
						br.AddLineBreak();
						target.AddElement(br, target.GetElementsCount());
					}
					first = false;
					fillRuns(runs, function (r) { target.AddElement(r, target.GetElementsCount()); });
				});
			}
			return true;
		}, { id: id, paragraphs: paragraphs, bib: bib || null });
	}

	function getProp(name) {
		return editor(function () {
			var props = Api.GetDocument().GetCustomProperties();
			var v = props ? props.Get(Asc.scope.name) : null;
			return v == null ? '' : String(v);
		}, { name: name });
	}

	function setProp(name, value) {
		return editor(function () {
			Api.GetDocument().GetCustomProperties().Add(Asc.scope.name, Asc.scope.value);
			return null;
		}, { name: name, value: value });
	}

	function loadBibStyle() {
		if (bibStyle) return Promise.resolve(bibStyle);
		return getProp(BIB_STYLE_PROP).then(function (json) {
			try { bibStyle = json ? JSON.parse(json) : null; } catch (e) { bibStyle = null; }
			return bibStyle;
		});
	}

	function findById(id) {
		return listFields().then(function (fields) {
			for (var i = 0; i < fields.length; i++) if (fields[i].id === id) return fields[i];
			throw new Error('Field not found in document (it may have been deleted)');
		});
	}

	function mutateField(id, func, extra) {
		return editor(func, Object.assign({ id: id }, extra || {}));
	}

	// ------------------------------------------- citations from Word/LibreOffice

	/**
	 * A document whose Zotero citations were made in LibreOffice or Word with
	 * "store as bookmarks" keeps them as bookmarks ZOTERO_BREF_<id>, the field
	 * codes in the custom properties ZOTERO_BREF_<id>_1.._n and the document
	 * preferences in ZOTERO_PREF_1.._n. The editor API cannot wrap them in content
	 * controls (AddContentControl ignores the selection of a bookmark), so the
	 * file is converted outside the editor by tools/zotero-onlyoffice-convert.
	 */
	function findLegacy() {
		return editor(function () {
			var doc = Api.GetDocument();
			var props = doc.GetCustomProperties();
			if (!props) return null;
			function joined(prefix) {
				var out = '';
				for (var i = 1; i < 10000; i++) {
					var v = props.Get(prefix + i);
					if (v == null || v === '') break;
					out += String(v);
				}
				return out;
			}
			var data = props.Get(Asc.scope.dataProp);
			if (data != null && data !== '') return null;
			var prefs = joined('ZOTERO_PREF_');
			if (!prefs) return null;
			var marks = [];
			doc.GetAllBookmarksNames().forEach(function (name) {
				if (!/^ZOTERO_BREF_/.test(name)) return;
				var code = joined(name + '_');
				if (code) marks.push({ name: name, code: code });
			});
			return { prefs: prefs, marks: marks };
		}, { dataProp: DATA_PROP });
	}

	function checkLegacy() {
		return findLegacy().then(function (legacy) {
			if (!legacy) return;
			var n = legacy.marks.length;
			log('legacy document with ' + n + ' bookmark fields');
			throw new Error('This document has ' + n + ' Zotero citation' + (n === 1 ? '' : 's') +
				' from LibreOffice or Word, which Zotero cannot use in ONLYOFFICE.\n\n' +
				'Close the document and convert it once in a terminal:\n' +
				'zotero-for-onlyoffice-convert "path/to/file.docx"\n\n' +
				'It keeps a backup copy next to the file.');
		});
	}

	// ------------------------------------------------------------- dispatcher

	var handlers = {
		'Application.getActiveDocument': function () {
			return {
				documentID: docId,
				outputFormat: 'html',
				supportedNotes: [],
				supportsImportExport: false,
				supportsTextInsertion: false,
				supportsCitationMerging: false,
				processorName: 'ONLYOFFICE'
			};
		},

		'Document.activate': function () {
			return fetch(BRIDGE + '/oo/activate', { method: 'POST' })
				.catch(function () {})
				.then(function () { return method('FocusEditor'); })
				.then(function () { return null; });
		},

		'Document.canInsertField': function () { return true; },

		'Document.displayAlert': function (docID, text, icon, buttons) {
			// Answered by the bridge itself when it can show native dialogs
			return alertBox(text, icon, buttons);
		},

		'Document.getDocumentData': function () { return getProp(DATA_PROP); },

		'Document.setDocumentData': function (docID, data) {
			return setProp(DATA_PROP, data).then(function () { return null; });
		},

		'Document.setBibliographyStyle': function (docID, firstLineIndent, indent, lineSpacing, entrySpacing, tabStops) {
			bibStyle = {
				firstLineIndent: firstLineIndent,
				indent: indent,
				lineSpacing: lineSpacing,
				entrySpacing: entrySpacing,
				tabStops: tabStops || []
			};
			return setProp(BIB_STYLE_PROP, JSON.stringify(bibStyle)).then(function () { return null; });
		},

		'Document.cursorInField': function () {
			// Innermost content control at the cursor, walking out to a Zotero one
			return editor(function () {
				var cc = Api.GetDocument().GetCurrentContentControl();
				while (cc) {
					if ((cc.GetAlias() || '').indexOf('Zotero') === 0) return String(cc.GetInternalId());
					cc = cc.GetParentContentControl();
				}
				return null;
			}).then(function (internalId) {
				if (!internalId) return null;
				return listFields().then(function (fields) {
					for (var i = 0; i < fields.length; i++) {
						if (fields[i].id === internalId) return fieldToWire(fields[i]);
					}
					return null;
				});
			});
		},

		'Document.insertField': function () {
			var bibliography = currentCommand === 'addEditBibliography';
			return method('AddContentControl', [bibliography ? 1 : 2, {
				Tag: 'TEMP',
				Alias: bibliography ? ALIAS_BIBLIOGRAPHY : ALIAS_CITATION
			}]).then(function (cc) {
				if (!cc) throw new Error('Could not insert a field at the cursor');
				// Like Word, give new fields placeholder text: Zotero unlinks a
				// bibliography whose text is empty (ignoreEmptyBibliography)
				var id = String(cc.InternalId);
				var text = bibliography ? '{Bibliography}' : '{Citation}';
				return writeContent(id, [[{ t: text }]], null).then(function () {
					return { id: id, code: 'TEMP', text: text, noteIndex: 0 };
				});
			});
		},

		'Document.getFields': function () {
			return listFields().then(function (fields) { return fields.map(fieldToWire); });
		},

		'Document.convert': function () { throw new Error('Field conversion is not supported'); },
		'Document.convertPlaceholdersToFields': function () { throw new Error('Placeholders are not supported'); },
		'Document.importDocument': function () { throw new Error('Not supported'); },
		'Document.exportDocument': function () { throw new Error('Not supported'); },
		'Document.insertText': function () { throw new Error('Not supported'); },

		'Field.delete': function (docID, id) {
			return mutateField(id, function () {
				var id = Asc.scope.id;
				Api.GetDocument().GetAllContentControls().forEach(function (cc) {
					if (String(cc.GetInternalId()) === id) cc.Delete(false);
				});
				return null;
			}).then(function () { return null; });
		},

		'Field.removeCode': function (docID, id) {
			// Keep the visible text, drop the control
			return mutateField(id, function () {
				var id = Asc.scope.id;
				Api.GetDocument().GetAllContentControls().forEach(function (cc) {
					if (String(cc.GetInternalId()) === id) cc.Delete(true);
				});
				return null;
			}).then(function () { return null; });
		},

		'Field.select': function (docID, id) {
			return mutateField(id, function () {
				var id = Asc.scope.id;
				Api.GetDocument().GetAllContentControls().forEach(function (cc) {
					if (String(cc.GetInternalId()) === id) cc.Select();
				});
				return null;
			}).then(function () { return null; });
		},

		'Field.setCode': function (docID, id, code) {
			return mutateField(id, function () {
				var s = Asc.scope;
				Api.GetDocument().GetAllContentControls().forEach(function (cc) {
					if (String(cc.GetInternalId()) === s.id) cc.SetTag(s.code);
				});
				return null;
			}, { code: code }).then(function () { return null; });
		},

		'Field.setText': function (docID, id, text, isRich) {
			return findById(id).then(function (field) {
				var bibliography = field.block || /^BIBL\b/.test(field.code);
				var paragraphs = isRich === false
					? [[{ t: text }]]
					: htmlToParagraphs(text, bibliography);
				return (bibliography ? loadBibStyle() : Promise.resolve(null)).then(function (style) {
					return writeContent(id, paragraphs, style);
				});
			}).then(function (ok) {
				if (ok === false) throw new Error('Could not write to the field (it may have been deleted)');
				return null;
			});
		},

		'Document.complete': function () { return null; }
	};

	function dispatch(command, args) {
		var h = handlers[command];
		if (!h) return Promise.reject(new Error('Unsupported command: ' + command));
		// args[0] is the document id for everything except Application.*
		return Promise.resolve().then(function () { return h.apply(null, args || []); });
	}

	// -------------------------------------------------------------- transport

	function post(path, body) {
		return fetch(BRIDGE + path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		}).then(function (r) {
			return r.text().then(function (text) {
				if (!r.ok) {
					var err = new Error(r.status === 502
						? 'Zotero is not running. Start Zotero and press ' + SHORTCUT + ' again.'
						: r.status === 503 ? 'Zotero is still busy with another document command. Finish or close the open Zotero window, then try again.'
						: 'Zotero returned ' + r.status + ': ' + text);
					throw err;
				}
				return text;
			});
		}, function () {
			throw new Error('The Zotero for ONLYOFFICE bridge is not running, so ONLYOFFICE cannot reach Zotero.\n\n' +
				'It starts when you log in. To start it now, run "node install.js" again in the zotero-for-onlyoffice folder.');
		});
	}

	function run(command) {
		if (busy) {
			log('ignored ' + command + ': ' + currentCommand + ' still running');
			return;
		}
		busy = true;
		currentCommand = command;
		log('run ' + command);

		checkLegacy()
			.then(function () { return post('/connector/document/execCommand', { command: command, docId: docId }); })
			.then(function step(text) {
				var req = JSON.parse(text);
				if (req.command === 'Document.complete') return null;
				return dispatch(req.command, req.arguments).then(
					function (result) { return result === undefined ? null : result; },
					function (e) {
						log('handler ' + req.command + ' failed: ' + e.message);
						return { error: 'Alert', message: e.message, stack: e.stack || '' };
					}
				).then(function (result) {
					return post('/connector/document/respond', result).then(step);
				});
			})
			.catch(function (e) { showError(e.message); })
			.then(function () {
				busy = false;
				currentCommand = null;
			});
	}

	// ----------------------------------------------------------------- bootstrap

	var COMMANDS = [
		['addEditCitation', 'Add/Edit Citation', 'citation', 'Insert a citation at the cursor, or edit the one under it (' + SHORTCUT + ')'],
		['addEditBibliography', 'Add/Edit Bibliography', 'bibliography', 'Insert the bibliography at the cursor (on an empty line), or edit it'],
		['refresh', 'Refresh', 'refresh', 'Update all citations and the bibliography from your Zotero library'],
		['setDocPrefs', 'Document Preferences', 'preferences', 'Citation style and language of this document'],
		['removeCodes', 'Unlink Citations', 'unlink', 'Turn all citations into plain text that Zotero no longer updates']
	];

	function icon(name) {
		return 'resources/icons/%theme-type%(light|dark)/' + name + '%scale%(default).png';
	}

	function registerToolbar() {
		var tab = new window.Asc.ButtonToolbar();
		tab.text = 'Zotero';
		COMMANDS.forEach(function (c, i) {
			var b = new window.Asc.ButtonToolbar(tab);
			b.text = c[1];
			b.hint = c[3];
			b.icons = icon(c[2]);
			if (i === 2 || i === 4) b.separator = true;
			b.attachOnClick(function () { run(c[0]); });
		});
		window.Asc.Buttons.registerToolbarMenu();
	}

	function isCitationShortcut(e) {
		// Cmd+Shift+C / Ctrl+Shift+C, and Ctrl+Alt+C, Zotero's default in Word on Windows
		var c = e.keyCode === 67 || e.code === 'KeyC';
		if (!c) return false;
		if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey) return true;
		// On many keyboards Ctrl+Alt is AltGr, and AltGr+C types a character
		// (& on Slovenian and Croatian ones): only a plain "c" counts
		return e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey && (e.key || '').toLowerCase() === 'c';
	}

	window.Asc.plugin.init = function () {
		registerToolbar();
		window.Asc.plugin.attachEditorEvent('onKeyDown', function (e) {
			if (isCitationShortcut(e)) run('addEditCitation');
		});
		log('plugin loaded in ' + docId);
	};

	// Buttons of the in-editor dialogs
	window.Asc.plugin.button = function (index, windowId) {
		var d = dialogs[windowId];
		if (!d) return;
		delete dialogs[windowId];
		d.window.close();
		// -1 is the window's close box
		var b = d.set[index];
		d.resolve(b ? b[1] : 0);
		method('FocusEditor');
	};
})(window);
