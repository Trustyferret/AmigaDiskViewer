# Amiga Disk Viewer: project notes

A single-page browser tool for exploring Amiga floppy images (ADF, ADZ): a disk map, a boot block decoder with a 68000 disassembler, a labelled hex view, a file tree with extract, and small edits saved as a copy. The user guide is `README.md`; keep it in step with the code.

## Layout
- `index.html`: layout, all CSS, and the static "How it works" text. Loads the scripts as plain `<script src>` tags, not ES modules, so it works when opened from `file://`.
- `src/adf.js`: all disk-format knowledge. `analyse(bytes)` gives every block a role and an owner, builds the entry tree, and lists problems. `describeBlock()` labels fields for the hex view. `readFile()` extracts a file. No DOM code.
- `src/m68k.js`: a small 68000 disassembler. Unknown words become `dc.w`; it must never throw on any input (a test runs all 65,536 opcodes).
- `src/edit.js`: `EditSession` keeps the original bytes untouched; it fixes checksums and builds the copy name.
- `src/build-adf.js`: writes valid OFS/FFS disks in memory, for the tests and the "Load sample disk" button.
- `src/app.js`: the page only. Rendering and events; no format logic.
- Each `src` file is wrapped as UMD: browser globals `ADF`, `M68K`, `ADFEdit`, `BuildADF`, and `require()` in Node.

## Rules
- The parser never trusts a pointer. Range-check everything; each block can be claimed only once (`claim()`), which also stops loops. Report oddities as problems (`error` / `warning` / `info`); never throw.
- Game disks deliberately break rules (fake files that reserve trackloader tracks, "DOS" boot blocks with no root block, invalid bitmaps). Word problems neutrally, without assuming damage.
- Never write to the user's disk images. `tools/scan.js` is read-only, and the page only ever downloads a copy.

## Checking changes
- `node --test tests/`: must pass with no warnings. The pre-commit hook in `.githooks/` runs it (enable per clone with `git config core.hooksPath .githooks`).
- `node tools/scan.js "E:\Games\ROMs\Commodore Amiga"`: about 2,190 real images. Expect 0 crashes and no unreadable images. The last run read back 57,558 files; 100 were incomplete, all on broken or cracked disks.
- Screenshots: headless Edge with `--screenshot` on `index.html?sample&...`. For real images, add `--allow-file-access-from-files` and use `?open=<url-encoded file:/// URL>`. To test edit mode, drive Edge through `--remote-debugging-port` (Node's built-in WebSocket is enough).
