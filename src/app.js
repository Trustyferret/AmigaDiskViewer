/*
 * app.js — the web page: opening files, the disk map, the file tree and the detail tabs.
 * All the disk knowledge lives in adf.js / m68k.js / edit.js; this file only draws.
 */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hx = ADF.hex;

  const COLORS = {
    unknown: '#4a4f5a', free: '#272c36', boot: '#e5534b', root: '#f2c14e', bitmap: '#b48cf2', bitmapext: '#8a63d2',
    dir: '#4fa8ff', file: '#3fd48f', ext: '#1fa36b', data: '#3b7560', dircache: '#ff9f43', orphan: '#d6337a',
    link: '#a3d977', empty: '#1f232b', raw: '#8f6c52',
  };
  const roleColor = r => COLORS[ADF.ROLES[r].key];

  const state = {
    name: '', session: null, an: null, block: 0, entryPath: null, open: new Set(['']),
    tab: 'boot', sel: -1, pending: null, editing: false, changedBlocks: new Set(),
    kinds: new Map(), previews: new Map(), zoom: 'fit', iconPal: null, guideNode: null,
  };

  // ---------- loading ----------

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.style.display = 'none'; }, 6000);
  }

  /** `source` is a File, or a Blob with a name; gzipped images (.adz) are unpacked first. */
  async function openFile(source, name) {
    name = name || source.name;
    try {
      let bytes = new Uint8Array(await source.arrayBuffer());
      if (bytes[0] === 0x1F && bytes[1] === 0x8B) {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      }
      load(bytes, name);
    } catch (e) {
      toast('Could not open ' + name + ': ' + e.message);
    }
  }

  function load(bytes, name) {
    const an = ADF.analyse(bytes);
    if (!an.geo) { toast(name + ': ' + an.error); return; }
    state.name = name;
    state.session = new ADFEdit.EditSession(bytes);
    state.an = an;
    state.block = an.isDosFs ? an.rootBlock : 0;
    state.entryPath = null; state.open = new Set(['']); state.sel = -1; state.pending = null;
    scanKinds();
    $('#editMode').disabled = false;
    document.title = name + ' — Amiga Disk Viewer';
    $('#welcome').hidden = true; $('#map').hidden = false;
    renderAll();
  }

  function reanalyse() {
    state.an = ADF.analyse(state.session.bytes);
    const s = state.session, changed = new Set();
    for (let i = 0; i < s.bytes.length; i++) if (s.bytes[i] !== s.original[i]) changed.add(Math.floor(i / 512));
    state.changedBlocks = changed;
    scanKinds();
  }

  /** Recognise every file (for the tags in the tree) and forget earlier previews. */
  function scanKinds() {
    state.kinds = new Map(); state.previews = new Map();
    if (!state.an.isDosFs) return;
    for (const e of state.an.entries) {
      if (e.kind !== 'file') continue;
      const k = Preview.identify(ADF.readFile(state.an, state.session.bytes, e).data);
      if (k && k.kind !== 'other') state.kinds.set(e.path, k);
    }
  }

  const entry = () => state.entryPath === null ? null : (state.an.entries.find(e => e.path === state.entryPath) || null);

  function download(bytes, name) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ---------- top bar ----------

  function renderSummary() {
    const an = state.an, g = an.geo, st = an.stats;
    const chips = [];
    chips.push(esc(state.name));
    chips.push(g.kind + ' · ' + g.cylinders + ' cylinders · ' + g.blocks + ' blocks');
    chips.push(an.boot.isDos ? esc(an.boot.typeText) + ' ' + esc(an.boot.fs.name) : 'Not an AmigaDOS disk (' + esc(an.boot.typeText) + ')');
    if (an.isDosFs) {
      chips.push('“' + esc(an.root.name) + '”');
      chips.push(st.files + ' files, ' + st.dirs + ' folders');
      chips.push(st.used + ' used / ' + st.free + ' free blocks');
    }
    chips.push(an.boot.checksumOk ? '<span class="ok">✓ bootable</span>' : '<span class="warn">not bootable</span>');
    $('#summary').innerHTML = chips.map(c => '<span class="chip">' + c + '</span>').join('');
    const edits = state.session.changedCount();
    $('#editCount').textContent = edits ? edits + ' byte' + (edits === 1 ? '' : 's') + ' changed' : '';
    $('#undo').disabled = !edits; $('#save').disabled = !edits;
  }

  // ---------- disk map ----------

  const CELL = 10, STEP = 11, HEADGAP = 10, LEFT = 30, TOP = 20;
  function mapLayout() {
    const g = state.an.geo, headW = g.sectors * STEP + HEADGAP;
    return { g, headW, width: LEFT + 2 * headW, height: TOP + g.cylinders * STEP + 2 };
  }
  function cellPos(n, lay) {
    const loc = ADF.location(n, lay.g);
    return { x: LEFT + loc.head * lay.headW + loc.sector * STEP, y: TOP + loc.cylinder * STEP };
  }
  function blockAt(px, py) {
    const lay = mapLayout(), g = lay.g;
    const cyl = Math.floor((py - TOP) / STEP);
    const rel = px - LEFT, head = rel >= lay.headW ? 1 : 0;
    const sx = rel - head * lay.headW, sector = Math.floor(sx / STEP);
    if (cyl < 0 || cyl >= g.cylinders || rel < 0 || sector < 0 || sector >= g.sectors) return -1;
    return (cyl * 2 + head) * g.sectors + sector;
  }

  function drawMap() {
    const cv = $('#map'), lay = mapLayout(), an = state.an;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(lay.width * dpr); cv.height = Math.round(lay.height * dpr);
    cv.style.width = lay.width + 'px'; cv.style.height = lay.height + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, lay.width, lay.height);

    ctx.fillStyle = '#8b93a3'; ctx.font = '11px system-ui, sans-serif'; ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText('Head 0', LEFT, 8); ctx.fillText('Head 1', LEFT + lay.headW, 8);
    ctx.textAlign = 'right';
    for (let c = 0; c < lay.g.cylinders; c += 10) ctx.fillText(String(c), LEFT - 6, TOP + c * STEP + CELL / 2);

    const e = entry();
    const focus = e ? new Set(e.blocks) : null;
    for (let n = 0; n < lay.g.blocks; n++) {
      const p = cellPos(n, lay);
      ctx.globalAlpha = focus && !focus.has(n) ? 0.22 : 1;
      ctx.fillStyle = roleColor(an.roles[n]);
      ctx.fillRect(p.x, p.y, CELL, CELL);
      if (state.changedBlocks.has(n)) {
        ctx.globalAlpha = 1; ctx.fillStyle = '#ff8a3d';
        ctx.beginPath(); ctx.moveTo(p.x + CELL, p.y); ctx.lineTo(p.x + CELL, p.y + 5); ctx.lineTo(p.x + CELL - 5, p.y); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    const p = cellPos(state.block, lay);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
    ctx.strokeRect(p.x - 1, p.y - 1, CELL + 2, CELL + 2);
    $('#mapHint').textContent = '· one square per 512-byte block · rows are cylinders';
  }

  function describeHover(n) {
    const an = state.an, loc = ADF.location(n, an.geo), r = an.roles[n];
    let s = '<b>Block ' + n + '</b> · cylinder ' + loc.cylinder + ', head ' + loc.head + ', sector ' + loc.sector +
      '<br><span style="color:' + roleColor(r) + '">■</span> ' + ADF.ROLES[r].label;
    const own = an.owner[n];
    if (own >= 0 && an.entries[own]) s += ' · ' + esc(an.entries[own].path || an.entries[own].name + ':');
    return s;
  }

  function renderLegend() {
    const counts = new Map();
    for (const r of state.an.roles) counts.set(r, (counts.get(r) || 0) + 1);
    $('#legend').innerHTML = ADF.ROLES.map((info, r) => counts.has(r) ?
      '<div title="' + esc(info.about) + '"><i style="background:' + COLORS[info.key] + '"></i>' + info.label + '<b>' + counts.get(r) + '</b></div>' : '').join('');
  }

  // ---------- file tree ----------

  function renderTree() {
    const an = state.an, tree = $('#tree');
    if (!an.isDosFs) {
      tree.className = 'muted';
      tree.innerHTML = an.boot.isDos ?
        'The boot block starts with "DOS", but there is no root block, so there are no files to list. Games often do this: they boot like a DOS disk, then load everything with their own trackloader. Look at the boot code to see how.' :
        'This is not an AmigaDOS disk, so there are no files to list. The program on it loads its data with its own trackloader. Look at the boot block to see how it starts.';
      $('#fileInfo').innerHTML = '';
      return;
    }
    tree.className = '';
    const rows = [];
    const add = (e, depth) => {
      const isDir = e.kind === 'dir' || e.kind === 'root';
      const open = state.open.has(e.path);
      const color = e.kind === 'root' ? COLORS.root : isDir ? COLORS.dir : e.kind === 'file' ? COLORS.file : COLORS.link;
      const size = e.kind === 'file' ? fmtSize(e.size) : isDir ? e.children.length + (e.children.length === 1 ? ' item' : ' items') : e.kind;
      const k = state.kinds.get(e.path);
      const tag = k ? '<span class="tag t-' + k.kind + '" title="' + esc(k.label) + ': click to preview">' + TAGS[k.kind] + '</span>' : '';
      rows.push('<div class="row' + (state.entryPath === e.path ? ' sel' : '') + '" data-path="' + esc(e.path) + '" style="padding-left:' + (6 + depth * 14) + 'px">' +
        '<span class="tw">' + (isDir && e.children.length ? (open ? '▾' : '▸') : '') + '</span>' +
        '<span class="sq" style="background:' + color + '"></span>' +
        '<span class="nm">' + esc(e.kind === 'root' ? e.name + ':' : e.name) + '</span>' + tag + '<span class="sz">' + size + '</span></div>');
      if (isDir && open) e.children.forEach(c => add(c, depth + 1));
    };
    add(an.entries[0], 0);
    tree.innerHTML = rows.join('');
    renderFileInfo();
  }

  const TAGS = { text: 'TXT', image: 'PIC', icon: 'ICON', sound: 'SFX', music: 'MOD', packed: 'PP' };

  function fmtSize(n) { return n < 1024 ? n + ' B' : (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB'; }

  function renderFileInfo() {
    const e = entry(), box = $('#fileInfo');
    if (!e) { box.innerHTML = '<p class="muted">Click a file or folder to light up its blocks on the map.</p>'; return; }
    const an = state.an;
    const exts = e.blocks.filter(n => an.roles[n] === ADF.ROLE.EXT).length;
    let runs = 0;
    e.dataBlocks.forEach((d, i) => { if (i === 0 || d !== e.dataBlocks[i - 1] + 1) runs++; });
    const rows = [
      ['Path', esc(e.kind === 'root' ? e.name + ':' : e.path)],
      ['Type', { root: 'Root folder (the disk)', dir: 'Folder', file: 'File', softlink: 'Soft link → ' + esc(e.target), hardlink: 'Hard link → ' + esc(e.target) }[e.kind]],
      ['Header block', '<button class="link" data-goto="' + e.block + '">' + e.block + '</button>'],
    ];
    if (e.kind === 'file') {
      rows.push(['Size', e.size.toLocaleString() + ' bytes']);
      rows.push(['Blocks', e.dataBlocks.length + ' data' + (exts ? ', ' + exts + ' extension' : '') + ' + 1 header']);
      if (e.dataBlocks.length) {
        rows.push(['First data block', '<button class="link" data-goto="' + e.dataBlocks[0] + '">' + e.dataBlocks[0] + '</button>']);
        rows.push(['Fragments', runs === 1 ? 'stored in one continuous run' : 'stored in ' + runs + ' separate runs']);
      }
    }
    if (e.kind !== 'root') rows.push(['Protection', '<span class="mono">' + ADF.formatProtect(e.protect) + '</span>']);
    rows.push(['Date', ADF.formatDate(e.date)]);
    if (e.comment) rows.push(['Comment', esc(e.comment)]);
    box.innerHTML = '<table class="kv">' + rows.map(r => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>').join('') + '</table>' +
      (e.kind === 'file' ? '<p><button id="extract">Extract file…</button></p>' : '');
  }

  // ---------- tabs ----------

  function setTab(t) {
    state.tab = t;
    document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    document.querySelectorAll('.tab').forEach(d => d.classList.toggle('on', d.id === 'tab-' + t));
  }

  function renderBoot() {
    const an = state.an, b = an.boot, bytes = state.session.bytes;
    const fsText = b.isDos ? esc(b.typeText) + ' — ' + esc(b.fs.full) +
      (b.fs.intl ? ', international names' : '') + (b.fs.dircache ? ', directory cache' : '') + (b.fs.longNames ? ', long file names' : '')
      : esc(b.typeText) + ' — <b>not an AmigaDOS disk</b> (no "DOS" at the start)';
    const rootNote = b.rootPointer === an.geo.root ? ' (the usual value)' : ' (AmigaDOS ignores this and uses ' + an.geo.root + ')';
    const csText = b.checksumOk ?
      '<span class="ok">✓ $' + hx(b.checksum) + ' is correct</span>: Kickstart will run the boot code' :
      '<span class="bad">✗ $' + hx(b.checksum) + '</span>, should be $' + hx(b.expectedChecksum) + ': Kickstart will not boot from this disk' +
      (state.editing ? ' &nbsp;<button data-fix="boot">Fix boot checksum</button>' : '');
    const strs = b.strings.length ?
      '<ul class="mono">' + b.strings.slice(0, 30).map(s => '<li><span class="muted">$' + hx(s.offset, 3) + '</span> ' + esc(s.text) + '</li>').join('') + '</ul>' :
      '<p class="muted">None.</p>';
    const lines = M68K.disassemble(bytes.subarray(0, 1024), 12, 1024);
    const dis = '<table class="dis">' + lines.map(l => '<tr><td class="ad">$' + hx(l.addr, 3) + '</td><td class="by">' + esc(l.bytes.length > 30 ? l.bytes.slice(0, 29) + '…' : l.bytes) + '</td><td class="in">' + esc(l.text) + '</td><td class="cm">' + (l.comment ? '; ' + esc(l.comment) : '') + '</td></tr>').join('') + '</table>';
    $('#tab-boot').innerHTML =
      '<table class="kv">' +
      '<tr><td>Disk type</td><td>' + fsText + '</td></tr>' +
      '<tr><td>Checksum</td><td>' + csText + '</td></tr>' +
      '<tr><td>Root pointer</td><td>' + b.rootPointer + rootNote + '</td></tr>' +
      '<tr><td>Boot code</td><td>' + esc(b.recognised) + '</td></tr>' +
      '</table>' +
      '<p>View in hex: <button class="link" data-goto="0">block 0</button> · <button class="link" data-goto="1">block 1</button></p>' +
      '<div class="explain">' + esc(ADF.EXPLAIN.boot0) + '</div>' +
      '<h3>Text found in the boot block</h3>' + strs +
      '<h3>Boot code disassembly (68000)</h3>' +
      '<p class="muted">Code starts at byte 12 ($00C). Addresses are offsets into the boot block. This is a straight top-to-bottom reading: data mixed in with the code can show up as odd instructions.</p>' + dis;
  }

  function renderBlock() {
    const an = state.an, bytes = state.session.bytes, n = state.block, N = an.geo.blocks;
    const d = ADF.describeBlock(an, bytes, n);
    const loc = ADF.location(n, an.geo);
    const own = an.owner[n];
    const ownText = own >= 0 && an.entries[own] ? ' · belongs to <b>' + esc(an.entries[own].path || an.entries[own].name + ':') + '</b>' : '';
    let csLine = '';
    if (d.checksum) {
      csLine = d.checksum.ok ? '<span class="ok">✓ checksum correct</span>' :
        '<span class="bad">✗ checksum wrong</span> (stored $' + hx(d.checksum.stored) + ', should be $' + hx(d.checksum.expected) + ')';
      if (state.editing && !d.checksum.ok) csLine += ' &nbsp;<button data-fix="' + (d.checksum.boot ? 'boot' : 'block:' + d.checksum.off) + '">Fix checksum</button>';
    }

    // Which field each byte belongs to
    const fieldOf = new Int16Array(512).fill(-1);
    d.fields.forEach((f, i) => { for (let k = f.off; k < f.off + f.len && k < 512; k++) fieldOf[k] = i; });
    const base = n * 512, s = state.session;
    let hex = '';
    for (let row = 0; row < 32; row++) {
      let hb = '', asc = '';
      for (let c = 0; c < 16; c++) {
        const o = row * 16 + c, v = bytes[base + o], fi = fieldOf[o];
        const g = fi >= 0 ? d.fields[fi].group : 'none';
        let cls = 'g-' + g + (v === 0 ? ' z' : '') + (s.isChanged(base + o) ? ' ch' : '');
        const sel = state.sel === base + o;
        if (sel) cls += state.pending !== null ? ' sel pend' : ' sel';
        const txt = sel && state.pending !== null ? state.pending.toString(16).toUpperCase() + '_' : v.toString(16).toUpperCase().padStart(2, '0');
        hb += (c === 8 ? '<span class="gap"></span>' : '') + '<span class="b ' + cls + '" data-o="' + o + '" data-f="' + fi + '">' + txt + '</span>';
        asc += '<span class="a ' + cls.replace(/ sel| pend/g, '') + '" data-o="' + o + '" data-f="' + fi + '">' + (v >= 32 && v < 127 ? esc(String.fromCharCode(v)) : '.') + '</span>';
      }
      hex += '<div class="hr"><span class="ho">$' + hx(row * 16, 3) + '</span>' + hb + '<span class="asc">' + asc + '</span></div>';
    }

    const shown = d.fields.filter(f => !(f.group === 'table' && f.value === '0'));
    const fieldRows = shown.map(f => '<tr data-f="' + d.fields.indexOf(f) + '"><td class="mono">$' + hx(f.off, 3) + '</td><td class="mono">' + f.len + '</td><td class="g-' + f.group + '">' + esc(f.name) + '</td><td>' +
      (f.ptr !== undefined && f.ptr < N ? '<button class="link" data-goto="' + f.ptr + '">' + esc(f.value) + '</button>' : esc(f.value)) + '</td></tr>').join('');

    $('#tab-block').innerHTML =
      '<div class="blocknav"><button data-goto="' + Math.max(0, n - 1) + '"' + (n ? '' : ' disabled') + '>◀</button>' +
      'Block <input type="number" id="goto" min="0" max="' + (N - 1) + '" value="' + n + '"> of ' + (N - 1) +
      '<button data-goto="' + Math.min(N - 1, n + 1) + '"' + (n < N - 1 ? '' : ' disabled') + '>▶</button>' +
      (an.isDosFs ? '<button data-goto="' + an.rootBlock + '">Root</button>' : '') + '</div>' +
      '<div class="blocktitle"><span style="color:' + roleColor(an.roles[n]) + '">■</span> Block ' + n + ' — ' + esc(d.title) + '</div>' +
      '<div class="muted">Cylinder ' + loc.cylinder + ', head ' + loc.head + ', sector ' + loc.sector + ' · file offset $' + hx(loc.offset, 6) + ownText + '</div>' +
      (csLine ? '<div style="margin-top:4px">' + csLine + '</div>' : '') +
      (d.explain ? '<div class="explain">' + esc(d.explain) + '</div>' : '') +
      (state.editing ? '<p class="warn">Edit mode: click a byte and type two hex digits. Arrow keys move, Esc stops editing that byte.</p>' : '') +
      '<div class="hex" id="hex">' + hex + '</div>' +
      '<div id="fieldStatus" class="muted">Hover over a byte to see which field it belongs to. Double-click a pointer to follow it.</div>' +
      (fieldRows ? '<table class="fields"><tr><th>Offset</th><th>Bytes</th><th>Field</th><th>Value</th></tr>' + fieldRows + '</table>' : '');
    renderBlock.desc = d;
  }

  function renderProblems() {
    const an = state.an, ps = an.problems;
    const errs = ps.filter(p => p.level === 'error').length, warns = ps.filter(p => p.level === 'warning').length;
    $('#probBadge').innerHTML = ps.length ? '<span class="badge' + (errs ? '' : ' info') + '">' + ps.length + '</span>' : '';
    if (!ps.length) { $('#tab-problems').innerHTML = '<p class="ok">No problems found. Every pointer, checksum and bitmap bit checked out.</p>'; return; }
    const icon = { error: '<span class="lvl bad">error</span>', warning: '<span class="lvl warn">warning</span>', info: '<span class="lvl muted">note</span>' };
    $('#tab-problems').innerHTML =
      '<p>' + errs + ' error(s), ' + warns + ' warning(s), ' + (ps.length - errs - warns) + ' note(s). ' +
      '<span class="muted">Game disks often break the rules on purpose: copy protection, or hiding data from AmigaDOS.</span></p>' +
      '<ul class="problems">' + ps.map(p => '<li>' + icon[p.level] + ' ' + esc(p.message) +
        (p.block !== null && p.block !== undefined ? ' <button class="link" data-goto="' + p.block + '">block ' + p.block + '</button>' : '') + '</li>').join('') + '</ul>' +
      (an.moreProblems ? '<p class="muted">…and ' + an.moreProblems + ' more.</p>' : '');
  }

  function renderAll() {
    if (!state.an) return;
    renderSummary(); drawMap(); renderLegend(); renderTree(); renderBoot(); renderBlock(); renderProblems(); renderPreview();
  }

  /** Select a file or folder: light it up on the map, and preview it (switching to the Preview tab if it's a recognised file). */
  function selectEntry(path) {
    state.entryPath = path; state.guideNode = null; state.iconPal = null;
    renderTree(); drawMap();
    const e = entry();
    if (e && e.kind === 'file' && previewOf(e).kind !== 'none') setTab('preview');
    renderPreview();
  }

  // ---------- preview ----------

  function previewOf(e) {
    let pv = state.previews.get(e.path);
    if (!pv) {
      const r = ADF.readFile(state.an, state.session.bytes, e);
      pv = Preview.decode(r.data, e.name);
      if (!r.complete) pv.notes = (pv.notes || []).concat('Some of this file\'s blocks are missing or damaged, so the preview may be incomplete.');
      state.previews.set(e.path, pv);
    }
    return pv;
  }

  const fmtBytes = n => n.toLocaleString('en-GB') + ' bytes';
  const fmtTime = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  const rgb = c => 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
  /** Width available for pictures in the right-hand pane. */
  const paneWidth = () => Math.max(200, $('#detailPane').clientWidth - 30);

  function renderPreview() {
    stopAudio();
    const box = $('#tab-preview'), e = state.an ? entry() : null;
    if (!e || e.kind !== 'file') {
      box.innerHTML = '<p class="muted">Click a file in the file list to preview it. Pictures, Workbench icons, sounds, music and text (including AmigaGuide) are recognised by what is inside them, and PowerPacker files are unpacked first. Recognised files have a coloured tag in the list.</p>';
      return;
    }
    const pv = previewOf(e);
    let h = '<div class="pv-head"><b>' + esc(e.name) + '</b> · ' + esc(pv.label) + '</div>';
    if (pv.details) h += '<div class="muted">' + pv.details.map(esc).join(' · ') + '</div>';
    if (pv.packed) {
      const p = pv.packed;
      h += '<div class="explain">Packed with ' + p.format + ': ' + fmtBytes(p.packedSize) +
        (p.data ? ', unpacked to ' + fmtBytes(p.unpackedSize) + ' (' + Math.round(100 * p.packedSize / p.unpackedSize) + '%). What follows is the unpacked file. &nbsp;<button id="pvExtract">Extract unpacked…</button>' : '.') + '</div>';
    }
    if (pv.kind === 'image') h += imageHtml(pv);
    else if (pv.kind === 'icon') h += iconHtml(pv);
    else if (pv.kind === 'sound') h += soundHtml(pv);
    else if (pv.kind === 'music') h += musicHtml(pv);
    else if (pv.kind === 'text') h += textHtml(pv);
    else h += '<p class="muted">' + esc(pv.note) + '</p>';
    if (pv.notes && pv.notes.length) h += '<ul class="muted">' + pv.notes.map(n => '<li>' + esc(n) + '</li>').join('') + '</ul>';
    box.innerHTML = h;
    drawPreview();
  }

  /** Draw the canvases of the current preview (also called when the window is resized). */
  function drawPreview() {
    const e = state.an && entry();
    if (!e || e.kind !== 'file') return;
    const pv = previewOf(e);
    if (pv.kind === 'image') drawImage(pv);
    else if (pv.kind === 'icon') drawIcons(pv);
    else if (pv.kind === 'sound') drawWave(pv);
  }

  // Pictures

  function imageHtml(pv) {
    const zooms = [['fit', 'Fit'], ['1', '1×'], ['2', '2×'], ['3', '3×']];
    let h = '<div class="pv-tools">Zoom: ' + zooms.map(([z, t]) => '<button data-zoom="' + z + '"' + (state.zoom === z ? ' class="on"' : '') + '>' + t + '</button>').join('') +
      '<span class="muted">Pixels are drawn in their Amiga shape' + (Math.abs(pv.aspect - 1) > 0.02 ? ' (' + (pv.aspect < 1 ? 'taller' : 'wider') + ' than square)' : '') + '.</span></div>' +
      '<canvas id="pvImage" class="pixel"></canvas>';
    if (pv.palette && pv.palette.length) {
      h += '<div class="swatches" title="The colour palette">' + pv.palette.slice(0, 256).map((c, i) => '<i style="background:' + rgb(c) + '" title="Colour ' + i + ': ' + c.join(', ') + '"></i>').join('') + '</div>';
    }
    return h;
  }

  function drawImage(pv) {
    const cv = $('#pvImage');
    if (!cv) return;
    cv.width = pv.width; cv.height = pv.height;
    cv.getContext('2d').putImageData(new ImageData(pv.rgba, pv.width, pv.height), 0, 0);
    let s = +state.zoom;
    if (state.zoom === 'fit') { s = Math.min(4, paneWidth() / (pv.width * pv.aspect)); if (s >= 1) s = Math.floor(s); }
    cv.style.width = Math.round(pv.width * pv.aspect * s) + 'px';
    cv.style.height = Math.round(pv.height * s) + 'px';
  }

  // Icons

  function iconHtml(pv) {
    const pal = state.iconPal || pv.suggested;
    let h = '<div class="pv-tools">Colours: <button data-iconpal="wb13"' + (pal === 'wb13' ? ' class="on"' : '') + '>Workbench 1.x</button>' +
      '<button data-iconpal="wb20"' + (pal === 'wb20' ? ' class="on"' : '') + '>Workbench 2.0 and later</button>' +
      '<span class="muted">An icon file holds colour numbers, not colours: the Workbench palette decides how it looks.</span></div>' +
      '<div class="pv-icons"><figure><canvas class="pixel" data-icon="0"></canvas><figcaption>Normal</figcaption></figure>' +
      '<figure><canvas class="pixel" data-icon="1"></canvas><figcaption>' + (pv.images.length > 1 ? 'Selected' : 'Selected (Workbench inverts the colours)') + '</figcaption></figure></div>';
    const rows = [['Type', esc(pv.iconType)]];
    if (pv.defaultTool) rows.push(['Default tool', '<span class="mono">' + esc(pv.defaultTool) + '</span>']);
    if (pv.toolTypes.length) rows.push(['Tool types', pv.toolTypes.map(t => '<div class="mono">' + esc(t) + '</div>').join('')]);
    if (pv.stack) rows.push(['Stack size', pv.stack.toLocaleString('en-GB') + ' bytes']);
    return h + '<table class="kv" style="margin-top:12px">' + rows.map(r => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>').join('') + '</table>';
  }

  function drawIcons(pv) {
    const pal = pv.palettes[state.iconPal || pv.suggested];
    document.querySelectorAll('#tab-preview canvas[data-icon]').forEach(cv => {
      const which = +cv.dataset.icon, im = pv.images[Math.min(which, pv.images.length - 1)];
      const invert = which === 1 && pv.images.length === 1 ? (1 << im.depth) - 1 : 0;
      cv.width = im.width; cv.height = im.height;
      const img = new ImageData(im.width, im.height);
      for (let i = 0; i < im.pixels.length; i++) {
        const c = pal[(im.pixels[i] ^ invert) % pal.length];
        img.data.set([c[0], c[1], c[2], 255], i * 4);
      }
      cv.getContext('2d').putImageData(img, 0, 0);
      const s = Math.max(1, Math.min(4, Math.floor(160 / im.height)));
      cv.style.width = Math.round(im.width * pv.aspect * s) + 'px';
      cv.style.height = im.height * s + 'px';
    });
  }

  // Sounds

  function soundHtml(pv) {
    const rows = [];
    if (pv.name) rows.push(['Name', esc(pv.name)]);
    if (pv.author) rows.push(['Author', esc(pv.author)]);
    if (pv.copyright) rows.push(['Copyright', esc(pv.copyright)]);
    if (pv.annotation) rows.push(['Note', esc(pv.annotation)]);
    return '<div class="pv-tools"><button id="pvPlay">▶ Play</button><span id="pvStatus" class="muted"></span></div>' +
      '<div class="wavewrap"><canvas id="pvWave"></canvas><div class="playhead" id="pvHead"></div></div>' +
      (rows.length ? '<table class="kv" style="margin-top:12px">' + rows.map(r => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>').join('') + '</table>' : '');
  }

  function drawWave(pv) {
    const cv = $('#pvWave');
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const d = pv.samples, n = d.length, mid = h / 2;
    if (pv.loopLength) {
      g.fillStyle = 'rgba(242,193,78,.12)';
      g.fillRect(pv.loopStart / n * w, 0, pv.loopLength / n * w, h);
    }
    g.fillStyle = '#2c313b'; g.fillRect(0, mid, w, 1);
    g.fillStyle = '#9fd36b';
    for (let x = 0; x < w; x++) {
      const a = Math.floor(x / w * n), b = Math.max(a + 1, Math.floor((x + 1) / w * n));
      let lo = 0, hi = 0;
      for (let i = a; i < b && i < n; i++) { if (d[i] < lo) lo = d[i]; if (d[i] > hi) hi = d[i]; }
      g.fillRect(x, mid - hi / 128 * mid, 1, Math.max(1, (hi - lo) / 128 * mid));
    }
  }

  // Music

  function musicHtml(pv) {
    const len = ModPlayer.duration(pv);
    const inst = pv.samples.map((s, i) => s.length || s.name ? '<tr><td class="mono">' + (i + 1).toString(16).toUpperCase().padStart(2, '0') + '</td><td>' + esc(s.name) + '</td><td>' +
      (s.length ? fmtBytes(s.length) : '') + '</td><td>' + (s.length ? s.volume : '') + '</td><td>' + (s.loopLength > 2 ? 'loops' : '') + '</td><td>' +
      (s.data.length ? '<button data-smp="' + i + '" title="Play this instrument at C-2">▶</button>' : '') + '</td></tr>' : '').join('');
    return '<div class="pv-tools"><button id="pvPlay">▶ Play</button><span id="pvStatus" class="muted">' +
      (pv.title ? '“' + esc(pv.title) + '” · ' : '') + (len >= 1800 ? 'plays forever' : 'about ' + fmtTime(len) + ' before it repeats') + '</span></div>' +
      '<div class="pattern" id="pvPattern">' + patternHtml(pv, pv.order[0] || 0) + '</div>' +
      '<h3>Instruments</h3><table class="fields"><tr><th>#</th><th>Name</th><th>Length</th><th>Volume</th><th>Loop</th><th></th></tr>' + inst + '</table>' +
      '<p class="muted">Instrument names are often used for messages from the musician, as above.</p>';
  }

  function patternHtml(pv, pat) {
    const hex2 = v => v.toString(16).toUpperCase().padStart(2, '0');
    let h = '';
    for (let r = 0; r < 64; r++) {
      let line = '<span class="rn">' + hex2(r) + '</span>';
      for (let c = 0; c < pv.channels; c++) {
        const k = ModPlayer.cell(pv, pat, r, c);
        const fx = k.effect || k.param ? k.effect.toString(16).toUpperCase() + hex2(k.param) : '...';
        const empty = !k.period && !k.sample && fx === '...';
        line += ' <span class="sep">|</span> ' + (empty ? '<span class="z">--- .. ...</span>' :
          ModPlayer.noteName(k.period) + ' ' + (k.sample ? hex2(k.sample) : '..') + ' ' + fx);
      }
      h += '<div data-r="' + r + '"' + (r % 16 === 0 ? ' class="beat"' : '') + '>' + line + '</div>';
    }
    return h;
  }

  // Text

  function textHtml(pv) {
    const LIMIT = 300000;
    if (!pv.guide) {
      const t = pv.text.length > LIMIT ? pv.text.slice(0, LIMIT) : pv.text;
      return '<pre class="pv-text">' + esc(t) + '</pre>' + (t.length < pv.text.length ? '<p class="muted">Only the first ' + LIMIT.toLocaleString('en-GB') + ' characters are shown.</p>' : '');
    }
    const nodes = pv.guide.nodes;
    const find = name => nodes.find(n => n.name.toLowerCase() === String(name).toLowerCase());
    const node = (state.guideNode && find(state.guideNode)) || find('main') || nodes[0];
    const seg = s => {
      let t = esc(s.t);
      if (s.b) t = '<b>' + t + '</b>';
      if (s.i) t = '<i>' + t + '</i>';
      if (s.u) t = '<u>' + t + '</u>';
      if (s.link !== undefined) return find(s.link) ? '<button class="link" data-gnode="' + esc(s.link) + '">' + t + '</button>' : '<span class="ext" title="Links to a page that is not in this file">' + t + '</span>';
      if (s.external) return '<span class="ext" title="Links to another file">' + t + '</span>';
      return t;
    };
    return '<div class="pv-tools">Page: <select id="pvNode">' + nodes.map(n => '<option value="' + esc(n.name) + '"' + (n === node ? ' selected' : '') + '>' + esc(n.title || n.name) + '</option>').join('') + '</select>' +
      (node !== nodes[0] ? '<button data-gnode="' + esc(nodes[0].name) + '">Contents</button>' : '') + '</div>' +
      '<pre class="pv-text">' + node.lines.map(l => l.map(seg).join('')).join('\n') + '</pre>';
  }

  // ---------- sound output ----------

  const audio = { ctx: null, timer: 0, nodes: [], queue: [], anim: 0, lastPat: -1 };

  function audioCtx() {
    if (!audio.ctx) audio.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (audio.ctx.state === 'suspended') audio.ctx.resume();
    return audio.ctx;
  }

  function stopAudio() {
    clearInterval(audio.timer); cancelAnimationFrame(audio.anim);
    audio.timer = 0; audio.queue = []; audio.lastPat = -1;
    for (const n of audio.nodes) { try { n.stop(); } catch (err) { /* already stopped */ } }
    audio.nodes = [];
    const b = $('#pvPlay');
    if (b) b.textContent = '▶ Play';
    const head = $('#pvHead');
    if (head) head.style.display = 'none';
    document.querySelectorAll('#pvPattern .now').forEach(x => x.classList.remove('now'));
  }
  const playing = () => audio.nodes.length > 0 || audio.timer !== 0;

  /** Play 8-bit samples. Looping samples play for `seconds`; others play once. */
  function playSamples(data, rate, opts) {
    stopAudio();
    if (!data.length) return;
    const c = audioCtx();
    // Web Audio buffers must be 3,000 Hz or more, so very slow sounds are stretched first.
    const k = rate < 3000 ? Math.ceil(3000 / rate) : 1;
    const buf = c.createBuffer(1, data.length * k, rate * k), ch = buf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = data[Math.floor(i / k)] / 128;
    const src = c.createBufferSource();
    src.buffer = buf; src.connect(c.destination);
    const o = opts || {};
    if (o.loopLength > 2) { src.loop = true; src.loopStart = o.loopStart / rate; src.loopEnd = (o.loopStart + o.loopLength) / rate; }
    const start = c.currentTime + 0.02;
    src.start(start);
    if (src.loop) src.stop(start + (o.seconds || 1.5));
    src.onended = () => { if (audio.nodes.includes(src)) stopAudio(); };
    audio.nodes.push(src);
    const b = $('#pvPlay');
    if (b && o.button) b.textContent = '■ Stop';
    const head = $('#pvHead'), cv = $('#pvWave');
    if (o.button && head && cv) {
      head.style.display = 'block';
      const total = src.loop ? (o.seconds || 1.5) : data.length / rate;
      const step = () => {
        const t = c.currentTime - start;
        let pos = t * rate;
        if (src.loop && pos > o.loopStart + o.loopLength) pos = o.loopStart + (pos - o.loopStart) % o.loopLength;
        head.style.left = Math.max(0, Math.min(1, pos / data.length)) * cv.clientWidth + 'px';
        if (t < total && audio.nodes.includes(src)) audio.anim = requestAnimationFrame(step);
      };
      step();
    }
  }

  /** Stream a module: render short chunks ahead of time and queue them back to back. */
  function playModule(pv) {
    stopAudio();
    const c = audioCtx(), player = ModPlayer.create(pv, c.sampleRate), CHUNK = 2048;
    let t = c.currentTime + 0.05;
    const pump = () => {
      const ahead = document.hidden ? 3 : 0.4;   // timers slow down in background tabs
      while (t < c.currentTime + ahead) {
        audio.queue.push({ t, pos: player.position() });
        const buf = c.createBuffer(2, CHUNK, c.sampleRate);
        player.render(buf.getChannelData(0), buf.getChannelData(1), CHUNK);
        const src = c.createBufferSource();
        src.buffer = buf; src.connect(c.destination); src.start(t);
        src.onended = () => { const i = audio.nodes.indexOf(src); if (i >= 0) audio.nodes.splice(i, 1); };
        audio.nodes.push(src);
        t += CHUNK / c.sampleRate;
      }
      while (audio.queue.length > 1 && audio.queue[1].t <= c.currentTime) audio.queue.shift();
      if (audio.queue.length) showPosition(pv, audio.queue[0].pos);
    };
    pump();
    audio.timer = setInterval(pump, 50);
    const b = $('#pvPlay');
    if (b) b.textContent = '■ Stop';
  }

  function showPosition(pv, pos) {
    const box = $('#pvPattern');
    if (!box) return;
    if (pos.pattern !== audio.lastPat) { box.innerHTML = patternHtml(pv, pos.pattern); audio.lastPat = pos.pattern; }
    const old = box.querySelector('.now'), row = box.querySelector('[data-r="' + pos.row + '"]');
    if (old !== row) {
      if (old) old.classList.remove('now');
      if (row) { row.classList.add('now'); box.scrollTop = row.offsetTop - box.offsetTop - box.clientHeight / 2 + row.clientHeight / 2; }
    }
    $('#pvStatus').textContent = 'Position ' + (pos.order + 1) + ' of ' + pv.songLength + ' · pattern ' + pos.pattern + ' · row ' + pos.row +
      (pos.loops ? ' · playing again' : '');
  }

  function onPreviewClick(t) {
    const e = entry(), pv = e && previewOf(e);
    if (!pv) return;
    if (t.dataset.zoom) { state.zoom = t.dataset.zoom; renderPreview(); return; }
    if (t.dataset.iconpal) { state.iconPal = t.dataset.iconpal; renderPreview(); return; }
    if (t.dataset.gnode) { state.guideNode = t.dataset.gnode; renderPreview(); $('#detailPane').scrollTop = 0; return; }
    if (t.id === 'pvExtract') { download(pv.packed.data, e.name + '.unpacked'); return; }
    if (t.dataset.smp) {
      const s = pv.samples[+t.dataset.smp];
      playSamples(s.data, 3546895 / 428, { loopStart: s.loopStart, loopLength: s.loopLength });
      return;
    }
    if (t.id === 'pvPlay') {
      if (playing()) { stopAudio(); return; }
      if (pv.kind === 'music') playModule(pv);
      else if (pv.kind === 'sound') playSamples(pv.samples, pv.rate, { loopStart: pv.loopStart, loopLength: pv.loopLength, seconds: Math.max(2, pv.samples.length / pv.rate), button: true });
    }
  }

  function goBlock(n, keepSel) {
    const N = state.an.geo.blocks;
    if (!(n >= 0 && n < N)) return;
    state.block = n;
    if (!keepSel) { state.sel = -1; state.pending = null; }
    drawMap(); renderBlock(); setTab('block');
  }

  // ---------- editing ----------

  function afterEdit() { reanalyse(); renderAll(); }

  function onKey(ev) {
    if (!state.editing || state.sel < 0 || state.tab !== 'block') return;
    if (ev.target && ev.target.tagName === 'INPUT') return;
    const base = state.block * 512, rel = state.sel - base;
    const move = d => { const r = rel + d; if (r >= 0 && r < 512) { state.sel = base + r; state.pending = null; renderBlock(); } ev.preventDefault(); };
    if (ev.key === 'ArrowLeft') return move(-1);
    if (ev.key === 'ArrowRight') return move(1);
    if (ev.key === 'ArrowUp') return move(-16);
    if (ev.key === 'ArrowDown') return move(16);
    if (ev.key === 'Escape') { state.sel = -1; state.pending = null; renderBlock(); return; }
    if (/^[0-9a-fA-F]$/.test(ev.key)) {
      ev.preventDefault();
      const v = parseInt(ev.key, 16);
      if (state.pending === null) { state.pending = v; renderBlock(); return; }
      state.session.setByte(state.sel, state.pending * 16 + v);
      state.pending = null;
      if (rel < 511) state.sel++;
      afterEdit();
    }
  }

  // ---------- events ----------

  function wire() {
    const pick = () => $('#file').click();
    $('#open').onclick = pick; $('#open2').onclick = pick;
    $('#file').onchange = e => { if (e.target.files[0]) openFile(e.target.files[0]); e.target.value = ''; };
    const sample = () => load(BuildADF.sampleDisk(), 'Sample Disk.adf');
    $('#sample').onclick = sample; $('#sample2').onclick = sample;

    let depth = 0;
    window.addEventListener('dragenter', e => { e.preventDefault(); depth++; document.body.classList.add('dragging'); });
    window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => {
      e.preventDefault(); depth = 0; document.body.classList.remove('dragging');
      const f = e.dataTransfer.files[0];
      if (f) openFile(f);
    });

    const cv = $('#map');
    cv.addEventListener('mousemove', e => {
      const r = cv.getBoundingClientRect(), n = blockAt(e.clientX - r.left, e.clientY - r.top);
      $('#hoverInfo').innerHTML = n >= 0 ? describeHover(n) : '';
    });
    cv.addEventListener('mouseleave', () => { $('#hoverInfo').innerHTML = ''; });
    cv.addEventListener('click', e => {
      const r = cv.getBoundingClientRect(), n = blockAt(e.clientX - r.left, e.clientY - r.top);
      if (n >= 0) goBlock(n);
    });

    $('#tree').addEventListener('click', e => {
      const row = e.target.closest('.row');
      if (!row) return;
      const path = row.dataset.path;
      const en = state.an.entries.find(x => x.path === path);
      if (!en) return;
      if ((en.kind === 'dir' || en.kind === 'root') && (state.entryPath === path || e.target.classList.contains('tw'))) {
        state.open.has(path) ? state.open.delete(path) : state.open.add(path);
      } else if (en.kind === 'dir') state.open.add(path);
      selectEntry(path);
    });

    // Buttons inside rendered panels, handled in one place.
    document.addEventListener('click', e => {
      const pt = e.target.closest('#tab-preview button');
      if (pt) return onPreviewClick(pt);
      const t = e.target.closest('[data-goto],[data-fix],#extract');
      if (!t) return;
      if (t.dataset.goto !== undefined) return goBlock(+t.dataset.goto);
      if (t.id === 'extract') {
        const en = entry();
        const r = ADF.readFile(state.an, state.session.bytes, en);
        if (!r.complete) toast('Some of this file\'s blocks are missing or damaged; the saved copy is incomplete.');
        return download(r.data, en.name);
      }
      if (t.dataset.fix === 'boot') state.session.fixBootChecksum();
      else state.session.fixBlockChecksum(state.block, +t.dataset.fix.split(':')[1]);
      afterEdit();
    });

    document.querySelectorAll('.tabs button').forEach(b => { b.onclick = () => { setTab(b.dataset.tab); if (b.dataset.tab === 'preview') drawPreview(); }; });
    $('#tab-preview').addEventListener('change', e => {
      if (e.target.id === 'pvNode') { state.guideNode = e.target.value; renderPreview(); }
    });
    let resizeTimer = 0;
    window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.tab === 'preview') drawPreview(); }, 100); });

    const blockTab = $('#tab-block');
    blockTab.addEventListener('change', e => { if (e.target.id === 'goto') goBlock(parseInt(e.target.value, 10)); });
    let lastF = null;
    blockTab.addEventListener('mouseover', e => {
      const el = e.target.closest('[data-f]');
      const f = el ? el.dataset.f : null;
      if (f === lastF) return;
      blockTab.querySelectorAll('.hl').forEach(x => x.classList.remove('hl'));
      lastF = f;
      const d = renderBlock.desc;
      if (f === null || f === '-1' || !d) { $('#fieldStatus').textContent = el && el.dataset.o ? 'Byte $' + hx(+el.dataset.o, 3) + ': not part of any field.' : ''; return; }
      blockTab.querySelectorAll('.hex [data-f="' + f + '"]').forEach(x => x.classList.add('hl'));
      const fd = d.fields[+f];
      $('#fieldStatus').innerHTML = '<b class="g-' + fd.group + '">' + esc(fd.name) + '</b> · bytes $' + hx(fd.off, 3) + '–$' + hx(fd.off + fd.len - 1, 3) +
        (fd.value ? ' · ' + esc(fd.value) : '') + (fd.ptr !== undefined ? ' · double-click to go there' : '');
    });
    blockTab.addEventListener('dblclick', e => {
      const el = e.target.closest('.hex [data-f]');
      if (!el || state.editing) return;
      const fd = renderBlock.desc.fields[+el.dataset.f];
      if (fd && fd.ptr !== undefined) goBlock(fd.ptr);
    });
    blockTab.addEventListener('click', e => {
      const el = e.target.closest('.hex .b');
      if (!el || !state.editing) return;
      state.sel = state.block * 512 + (+el.dataset.o); state.pending = null;
      renderBlock();
    });
    document.addEventListener('keydown', onKey);

    $('#editMode').onchange = e => {
      state.editing = e.target.checked;
      document.body.classList.toggle('editing', state.editing);
      state.sel = -1; state.pending = null;
      renderAll();
    };
    $('#undo').onclick = () => { state.session.revertAll(); afterEdit(); };
    $('#save').onclick = () => download(state.session.bytes, ADFEdit.copyName(state.name));
  }

  wire();

  // ?sample or ?open=<url>, plus &tab=block&block=880&file=docs/Story.txt&edit=1 (and &node=… for an
  // AmigaGuide page, &zoom=2 for pictures) — for demos and screenshots.
  // ?open only works where the browser allows the page to fetch that URL (for local files, Edge/Chrome
  // started with --allow-file-access-from-files).
  const q = new URLSearchParams(location.search);
  const applyParams = () => {
    if (q.get('edit')) { $('#editMode').checked = true; $('#editMode').onchange({ target: $('#editMode') }); }
    if (q.get('file')) { const parts = q.get('file').split('/'); parts.forEach((_, i) => state.open.add(parts.slice(0, i).join('/'))); selectEntry(q.get('file')); }
    if (q.get('node')) { state.guideNode = q.get('node'); renderPreview(); }
    if (q.get('zoom')) { state.zoom = q.get('zoom'); renderPreview(); }
    if (q.get('block')) goBlock(+q.get('block'));
    if (q.get('tab')) setTab(q.get('tab'));
  };
  if (q.has('sample')) { load(BuildADF.sampleDisk(), 'Sample Disk.adf'); applyParams(); }
  else if (q.get('open')) {
    const url = q.get('open');
    fetch(url).then(r => r.blob())
      .then(b => openFile(b, decodeURIComponent(url.split('/').pop())))
      .then(() => { if (state.an) applyParams(); })
      .catch(e => toast('Could not open ' + url + ': ' + e.message));
  }
})();
