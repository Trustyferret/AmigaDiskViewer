# Amiga Disk Viewer

A web page that shows what is on an Amiga floppy disk image, block by block, and explains the AmigaDOS disk format as you explore.

It runs entirely in your browser: nothing is uploaded and nothing needs installing.

## Opening a disk

1. Double-click `index.html` (it opens in your browser).
2. Drag an `.adf` or `.adz` file onto the page, or click **Open disk…**.
   **Load sample disk** builds a small demo disk instead.

ADF is the standard image of an 880 KB DD floppy (HD 1.76 MB images work too, as do images with 81–84 cylinders). ADZ is a gzipped ADF; the page unpacks it itself.

## What you see

- **Top bar:** the disk size, its DOS type (OFS, FFS, international, directory cache, or "not an AmigaDOS disk"), its name, the number of files and folders, used and free space, and whether it is bootable.
- **Disk map:** one square for each 512-byte block. Each row is one cylinder: head 0 (the top side) on the left, head 1 on the right. The colour shows what the block is used for; hover over a legend entry for an explanation. Hover over a square to see its block number and owner, and click it to look inside.
- **Files:** the folder tree. Click a file to light up its blocks on the map and see its size, protection bits, date, comment, and how many pieces it is stored in. **Extract file…** saves a copy to your computer.
- **Boot block tab:** the DOS type, checksum, root pointer, any text in the boot block, and a 68000 disassembly of the boot code. `jsr -nn(a6)` calls are named (e.g. `DoIO`, `AllocMem`), and so are the trackdisk I/O request fields that trackloaders fill in.
- **Block tab:** a hex and ASCII view of one block. Each field is coloured; hover over a byte to see which field it belongs to. The table below lists every field. Click a pointer, or double-click it in the hex view, to follow it to its block. ◀ ▶ step through the disk.
- **Problems tab:** everything that doesn't add up, such as wrong checksums, loops, blocks used twice, or bitmap disagreements. Game disks often break the rules on purpose (copy protection, data hidden from AmigaDOS), so a problem here does not always mean damage.
- **How it works tab:** a short explanation of the Amiga disk format.

## Editing

Tick **Edit mode** to change bytes:

1. In the Block tab, click a byte and type two hex digits. Arrow keys move, Esc stops.
2. Changed bytes turn orange. Blocks with changes get an orange corner on the map.
3. If a block's checksum is now wrong, a **Fix checksum** button appears (there is one for the boot block on the Boot block tab too).
4. **Save as copy…** downloads the edited disk as `<name>-edited.adf`. **Undo all edits** puts everything back.

Your original file is never changed. A web page cannot write to it anyway.

## For developers

- No build step and no dependencies. The parsing code (`src/adf.js`, `src/m68k.js`, `src/edit.js`, `src/build-adf.js`) is plain JavaScript that runs both in the browser and in Node.
- `npm test` (or `node --test "tests/*.test.js"`) runs the tests. They build their own disks in memory, so no disk images are stored in the repository.
- `node tools/scan.js <folder>` reads every ADF/ADZ under a folder (read-only) and reports what the parser makes of them. It's a good check after changing the parser.
- `index.html?sample` opens the sample disk directly. Add `&tab=block&block=880`, `&file=docs/Story.txt` or `&edit=1` to choose what it shows; this is handy for screenshots.
