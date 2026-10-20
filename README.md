# Zotero for ONLYOFFICE

Cite with Zotero in the **ONLYOFFICE Desktop Editors** the way you do in Word or LibreOffice:
press **Cmd+Shift+C** (Ctrl+Shift+C on Windows and Linux), Zotero's own citation dialog opens,
type an author or a title, press **Enter**, and the citation is in your document. Put the cursor
on a citation and press the same keys to edit it.

ONLYOFFICE comes with a Zotero plugin of its own, but that one searches your library in a side
panel and formats citations itself. This plugin hands the work to the Zotero app, as Zotero's
Word, LibreOffice and Google Docs plugins do, so you get:

- **Zotero's citation dialog**, with everything it can do: page numbers and other locators,
  prefixes and suffixes, "omit author", several sources in one citation, and the classic view.
- **Every Zotero citation style**, including the ones you installed yourself, and Zotero's
  bibliography: Add/Edit Bibliography, Refresh, Document Preferences (style, language) and
  Unlink Citations, all on a **Zotero** tab in the toolbar.
- **Citations that stay live.** Refresh picks up changes in your library, and changing the
  style reformats the whole document.
- **Documents from Word and LibreOffice.** A converter turns their Zotero citations (fields or
  bookmarks) into live citations in ONLYOFFICE.
- **Native dialogs.** Zotero's questions ("You have modified this citation…") appear as normal
  system dialogs, and ONLYOFFICE comes back to the front after you pick a source.

## Requirements

- [ONLYOFFICE Desktop Editors](https://www.onlyoffice.com/desktop) 9 or newer (tested with 9.2 and 9.3), on macOS,
  Windows or Linux. This plugin does not work in ONLYOFFICE Docs in the browser.
- [Zotero](https://www.zotero.org/download/) 7 or newer, running while you cite.
- [Node.js](https://nodejs.org) 18 or newer.

## Install

```sh
git clone https://github.com/mihasm/zotero-for-onlyoffice.git
cd zotero-for-onlyoffice
node install.js
```

Then restart ONLYOFFICE. The installer works the same in Terminal on macOS and Linux and in
PowerShell, cmd or Git Bash on Windows. It needs no administrator rights and installs only
for your user:

| | macOS | Windows | Linux |
|---|---|---|---|
| plugin | `~/Library/Application Support/asc.onlyoffice.ONLYOFFICE/data/sdkjs-plugins/` | `%LOCALAPPDATA%\ONLYOFFICE\DesktopEditors\data\sdkjs-plugins\` | `~/.local/share/onlyoffice/desktopeditors/sdkjs-plugins/` (also Flatpak and Snap, if found) |
| bridge and converter | `~/Library/Application Support/zotero-for-onlyoffice/` | `%LOCALAPPDATA%\zotero-for-onlyoffice\` | `~/.local/share/zotero-for-onlyoffice/` |
| started at login by | LaunchAgent `io.github.mihasm.zotero-for-onlyoffice` | a `Run` entry "Zotero for ONLYOFFICE bridge" | systemd user service `zotero-for-onlyoffice-bridge`, or an autostart entry |
| log | `~/Library/Logs/zotero-for-onlyoffice-bridge.log` | `%LOCALAPPDATA%\zotero-for-onlyoffice\bridge.log` | `~/.local/share/zotero-for-onlyoffice/bridge.log` |

- **Update:** `git pull`, then `node install.js` again.
- **Check:** `node install.js --status` shows what is installed and whether the bridge and
  Zotero are running.
- **Uninstall:** `node install.js --uninstall`. Your documents keep their citations as text.

## Use

| | |
|---|---|
| **Cmd+Shift+C** / **Ctrl+Shift+C** | Add a citation, or edit the one under the cursor |
| **Ctrl+Alt+C** | The same (Zotero's default shortcut in Word on Windows) |
| **Zotero** tab → Add/Edit Bibliography | Insert the bibliography on an empty line, or edit it |
| **Zotero** tab → Refresh | Update every citation and the bibliography from your library |
| **Zotero** tab → Document Preferences | Citation style and language of the document |
| **Zotero** tab → Unlink Citations | Turn all citations into plain text, for example before you send the file off |

The first citation in a document asks for a citation style, as in Word.

### Documents from Word or LibreOffice

Zotero stores citations differently in each word processor, and ONLYOFFICE cannot read the
Word and LibreOffice ones. Convert such a document once, with the document closed:

```sh
zotero-for-onlyoffice-convert "My paper.docx"
```

The converter keeps a copy, `My paper (before Zotero for ONLYOFFICE).docx`, next to the file.
It handles Word's fields and the bookmarks that LibreOffice and Word ("store citations as
bookmarks") write, for citations and the bibliography alike. If you press the shortcut in a
document that still needs converting, the plugin tells you so.

After the conversion, the citations are live in ONLYOFFICE only. Word and LibreOffice show them
as plain text. Going back the other way is not supported yet, so keep the backup if you need the
Word version.

## How it works

```
ONLYOFFICE ── plugin ──HTTP──▶ bridge (127.0.0.1:23120) ──HTTP──▶ Zotero (127.0.0.1:23119)
```

- **The plugin** (`plugin/`) is a background ONLYOFFICE plugin. It catches the shortcut, adds the
  toolbar tab, and carries out Zotero's commands on the document over Zotero's HTTP integration
  protocol, the one Zotero's Google Docs plugin uses. A citation is an inline content control
  (alias "Zotero Citation") whose tag holds Zotero's field code, and the bibliography is a block
  content control. The document preferences are in the custom property `ZOTERO_DOCUMENT_DATA`,
  so everything stays in the .docx.
- **The bridge** (`bridge/`) is a small Node server that runs on your computer only. The plugin
  needs it because Zotero does not let the editor's plugin frame call it directly (no CORS
  headers). The bridge also shows Zotero's dialogs natively and brings ONLYOFFICE back to the
  front. It accepts requests only from the ONLYOFFICE desktop editors, not from web pages. If
  ONLYOFFICE closes in the middle of a command, the bridge finishes that command for Zotero, so
  that Zotero does not get stuck on "a word processor command is already running".
- **The converter** (`tools/`) rewrites a .docx without any outside packages.

Nothing leaves your computer: the plugin talks to the bridge, and the bridge talks to the Zotero
app, all on 127.0.0.1.

## Troubleshooting

- **Nothing happens on the shortcut.** Is the plugin loaded? There should be a **Zotero** tab in
  the toolbar; if there isn't, restart ONLYOFFICE.
- **"Zotero is not running".** Start Zotero. In Zotero's settings → Advanced, "Allow other
  applications on this computer to communicate with Zotero" must be on (it is by default).
- **"The bridge is not running".** Run `node install.js` again, and check the log (see the
  table above).
- **macOS: the Colors panel opens.** ONLYOFFICE has a hidden "Show Colors" menu item on
  Cmd+Shift+C. The installer moves it to Cmd+Option+Ctrl+Shift+K; restart ONLYOFFICE once so the
  change takes effect.
- **Linux: alerts appear inside ONLYOFFICE.** Install `zenity` or `kdialog` for native dialogs,
  and `wmctrl` or `xdotool` so that ONLYOFFICE comes back to the front.
- **Zotero says a command is already running.** Close any open Zotero dialog. If none is open,
  restart Zotero.
- **Debugging.** Start the bridge by hand with `BRIDGE_DEBUG=1 node bridge/zotero-for-onlyoffice-bridge.js`
  to log every request.

## Limitations

- In-text citation styles only: footnote and endnote styles are not supported yet.
- Only the desktop editors are supported, not ONLYOFFICE Docs in the browser.
- The converter goes one way, from Word or LibreOffice to ONLYOFFICE.

## Development

```sh
npm test                 # converter and bridge tests (no Zotero needed)
sh scripts/build-icons.sh  # render the toolbar icons from icons-src/ (needs rsvg-convert)
```

## Credits and license

The plugin started from [GeneralPawz/onlyoffice-zotero](https://github.com/GeneralPawz/onlyoffice-zotero),
a Zotero integration for ONLYOFFICE and Euro-Office on Linux. The toolbar icons are drawn from
[Lucide](https://lucide.dev) (ISC), and the plugin icon is Zotero's. Zotero is a trademark of the
Corporation for Digital Scholarship and ONLYOFFICE a trademark of Ascensio System SIA; this
project is not affiliated with either.

[AGPL-3.0](LICENSE).
