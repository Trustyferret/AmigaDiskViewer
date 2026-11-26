# Amiga Disk Viewer: project notes

A single-page browser tool for exploring Amiga floppy images (ADF, ADZ): a disk map, a boot block decoder with a 68000 disassembler, a labelled hex view, a file tree with extract, previews of the files on the disk, and small edits saved as a copy. The user guide is `README.md`; keep it in step with the code. The complete viewer is also published as a website with GitHub Pages (https://trustyferret.github.io/AmigaDiskViewer/, served straight from `main`; `.nojekyll` turns off Jekyll). README screenshots live in `docs/screenshots/` and must show the sample disk only, never game disks (their art and music belong to others).

## Layout
- `index.html`: layout, all CSS, and the static "How it works" text. Loads the scripts as plain `<script src>` tags, not ES modules, so it works when opened from `file://`.
- `src/adf.js`: all disk-format knowledge. `analyse(bytes)` gives every block a role and an owner, builds the entry tree, and lists problems. `describeBlock()` labels fields for the hex view. `readFile()` extracts a file. No DOM code.
- `src/m68k.js`: a small 68000 disassembler. Unknown words become `dc.w`; it must never throw on any input (a test runs all 65,536 opcodes).
- `src/edit.js`: `EditSession` keeps the original bytes untouched; it fixes checksums and builds the copy name.
- `src/preview.js`: recognises files by content (`identify()`, cheap, used for the tree tags) and decodes them for the Preview tab (`decode()`): text and AmigaGuide, IFF ILBM/ACBM/PBM (HAM, EHB), 8SVX, Workbench icons, ProTracker modules, and PowerPacker PP20 unpacking. Other packers are only named. No DOM code.
- `src/modplayer.js`: ProTracker player. `create(mod, rate).render(L, R, n)` fills sample buffers; the page streams them to Web Audio in short chunks. `duration()` simulates the song without mixing.
- `src/build-files.js`: writes ILBM, 8SVX, icons, modules and PP20 files in memory, plus the sample disk's original content (picture, icons, sounds, tune, AmigaGuide, packed text).
- `src/build-adf.js`: writes valid OFS/FFS disks in memory, for the tests and the "Load sample disk" button.
- `src/app.js`: the page only. Rendering, events and audio output; no format logic.
- Each `src` file is wrapped as UMD: browser globals `ADF`, `M68K`, `ADFEdit`, `Preview`, `ModPlayer`, `BuildFiles`, `BuildADF`, and `require()` in Node. `build-files.js` must load before `build-adf.js`.

## Rules
- The parser never trusts a pointer. Range-check everything; each block can be claimed only once (`claim()`), which also stops loops. Report oddities as problems (`error` / `warning` / `info`); never throw.
- The same goes for `Preview.decode()` and the player: range-check every length and offset, turn damage into `notes`, never throw (tests feed them random and cut-off data). Recognise files by their contents, never by name.
- Game disks deliberately break rules (fake files that reserve trackloader tracks, "DOS" boot blocks with no root block, invalid bitmaps). Word problems neutrally, without assuming damage.
- Never write to the user's disk images. `tools/scan.js` is read-only, and the page only ever downloads a copy.

## Checking changes
- `node --test "tests/*.test.js"`: must pass with no warnings. The pre-commit hook in `.githooks/` runs it (enable per clone with `git config core.hooksPath .githooks`).
- `node tools/scan.js "E:\Games\ROMs\Commodore Amiga"`: about 2,190 real images. Expect 0 crashes and no unreadable images. The last run read back 57,558 files; 100 were incomplete, all on broken or cracked disks. It also decodes every file for the preview and plays each module briefly: about 2,400 IFF pictures, 1,880 icons, 1,235 sounds, 180 modules and 3,400 text files; all 594 PowerPacker files unpacked. Rob Northen ProPack (RNC, 3,290 files) is by far the most common packer the preview can't unpack yet.
- Screenshots: headless Edge with `--screenshot` on `index.html?sample&...`. For real images, `?open=<file:/// URL>` with `--allow-file-access-from-files` can fail to fetch from other drives; driving Edge through `--remote-debugging-port` and handing the file to the `#file` input with `DOM.setFileInputFiles` always works (Node's built-in WebSocket is enough). The same approach tests edit mode and the Preview tab's buttons.
