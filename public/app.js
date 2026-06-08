'use strict';

const state = {
  mode: 'all',        // 'all' | 'untagged'
  query: '',
  limit: 200,
  offset: 0,
  end: false,
  loading: false,
  photos: [],
  tags: [],
  selectMode: false,
  selected: new Set(),
  detailIndex: -1,
  detailTags: [],
};

const $ = (id) => document.getElementById(id);
const grid = () => $('grid');
const setStatus = (m) => { $('status').textContent = m || ''; };

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (r.status === 401) { window.location = '/login'; return { ok: false, status: 401, data: null }; }
  let data = null;
  try { data = await r.json(); } catch { /* non-JSON */ }
  return { ok: r.ok, status: r.status, data };
}

// ---- tags ----
async function loadTags() {
  const { data } = await getJSON('/api/tags');
  state.tags = (data?.tags || []).map((t) => t.name);
  const dl = $('tagList');
  dl.innerHTML = '';
  for (const name of state.tags) {
    const o = document.createElement('option');
    o.value = name;
    dl.appendChild(o);
  }
}

// ---- listing / search ----
function photosUrl() {
  const p = new URLSearchParams({ limit: String(state.limit), offset: String(state.offset) });
  if (state.mode === 'untagged') p.set('untagged', '1');
  else if (state.query) p.set('q', state.query);
  return '/api/photos?' + p.toString();
}

async function loadPhotos(reset) {
  if (state.loading) return;
  if (reset) { state.offset = 0; state.end = false; state.photos = []; grid().innerHTML = ''; }
  if (state.end) return;

  state.loading = true;
  setStatus(state.photos.length ? '' : 'Loading\u2026');

  const { ok, status, data } = await getJSON(photosUrl());
  state.loading = false;

  if (status === 400) { setStatus('Invalid query: ' + (data?.message || 'check your syntax')); return; }
  if (!ok) { setStatus('Error loading photos.'); return; }

  const batch = data.photos || [];
  state.photos.push(...batch);
  const frag = document.createDocumentFragment();
  for (const p of batch) frag.appendChild(makeTile(p));
  grid().appendChild(frag);

  state.offset += batch.length;
  if (batch.length < state.limit) state.end = true;

  setStatus(state.photos.length ? '' : (state.mode === 'untagged' ? 'No untagged photos.' : 'No matches.'));
  $('loadMore').hidden = state.end;
}

function makeTile(p) {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'tile' + (state.selected.has(p.id) ? ' selected' : '');
  tile.dataset.id = String(p.id);

  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = p.original_filename || '';
  img.addEventListener('load', () => img.classList.add('loaded'));
  img.src = '/api/thumb/' + p.hash;
  tile.appendChild(img);

  const check = document.createElement('span');
  check.className = 'check';
  tile.appendChild(check);

  tile.addEventListener('click', () => {
    if (state.selectMode) toggleSelect(p.id);
    else openDetail(state.photos.findIndex((x) => x.id === p.id));
  });
  return tile;
}

// ---- selection / bulk tagging ----
function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  const tile = grid().querySelector(`.tile[data-id="${id}"]`);
  if (tile) tile.classList.toggle('selected', state.selected.has(id));
  updateSelbar();
}

function updateSelbar() {
  const n = state.selected.size;
  $('selbar').hidden = !(state.selectMode && n > 0);
  $('selCount').textContent = n + ' selected';
}

function clearSelection() {
  state.selected.clear();
  grid().querySelectorAll('.tile.selected').forEach((t) => t.classList.remove('selected'));
  updateSelbar();
}

const parseTags = (s) => s.split(',').map((t) => t.trim()).filter(Boolean);

async function bulkTag(remove) {
  const tags = parseTags($('selTags').value);
  if (!tags.length || !state.selected.size) return;
  await getJSON(remove ? '/api/tags/remove' : '/api/tags/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ photo_ids: [...state.selected], tags }),
  });
  $('selTags').value = '';
  await loadTags();
  if (state.mode === 'untagged') { clearSelection(); loadPhotos(true); } // membership may change
}

// ---- detail / lightbox ----
function openDetail(index) {
  if (index < 0 || index >= state.photos.length) return;
  state.detailIndex = index;
  $('lightbox').hidden = false;          // show first, then load into the visible container
  document.body.classList.add('modal-open');
  renderDetail();
}

function closeDetail() {
  $('lightbox').hidden = true;
  document.body.classList.remove('modal-open');
  $('lbImg').removeAttribute('src');
}

function step(delta) {
  const i = state.detailIndex + delta;
  if (i >= 0 && i < state.photos.length) { state.detailIndex = i; renderDetail(); }
}

async function renderDetail() {
  const p = state.photos[state.detailIndex];
  const img = $('lbImg');
  const offline = $('lbOffline');
  offline.hidden = true;

  img.onerror = () => {                       // 503 / unreachable -> fall back to thumbnail
    img.onerror = null;
    img.src = '/api/thumb/' + p.hash;
    offline.hidden = false;
  };
  img.src = '/api/original/' + p.id;

  const date = p.taken_at ? new Date(p.taken_at).toLocaleString() : '';
  const dims = p.width && p.height ? `${p.width}\u00d7${p.height}` : '';
  $('lbMeta').textContent = [p.original_filename, date, dims].filter(Boolean).join('  \u00b7  ');

  const { data } = await getJSON('/api/photos/' + p.id);
  renderDetailTags(p.id, data?.photo?.tags || []);
}

function renderDetailTags(id, tags) {
  state.detailTags = tags;
  const box = $('lbTags');
  box.innerHTML = '';
  for (const name of tags) {
    const chip = document.createElement('span');
    chip.className = 'tagchip';
    const label = document.createElement('span');
    label.textContent = name;
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'x'; x.textContent = '\u2715';
    x.addEventListener('click', () => detailRemoveTag(id, name));
    chip.append(label, x);
    box.appendChild(chip);
  }
  renderSuggest();
}

// Tappable suggestions: tags not yet on this photo, filtered by what's typed.
// Acting on pointerdown + preventDefault keeps the input focused, so the
// mobile keyboard stays open and the tag registers in one tap.
function renderSuggest() {
  const box = $('lbSuggest');
  if (!box) return;
  box.innerHTML = '';
  const p = state.photos[state.detailIndex];
  if (!p) return;
  const typed = $('lbAddTag').value.trim().toLowerCase();
  const applied = new Set((state.detailTags || []).map((t) => t.toLowerCase()));
  const matches = state.tags
    .filter((name) => !applied.has(name.toLowerCase()))
    .filter((name) => !typed || name.toLowerCase().includes(typed))
    .slice(0, 12);
  for (const name of matches) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'suggest';
    b.textContent = name;
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); addSingleTag(p.id, name); });
    box.appendChild(b);
  }
}

async function addSingleTag(id, name) {
  await getJSON('/api/tags/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ photo_ids: [id], tags: [name] }),
  });
  $('lbAddTag').value = '';
  await loadTags();
  await refreshDetailTags(id);
}

async function refreshDetailTags(id) {
  const { data } = await getJSON('/api/photos/' + id);
  renderDetailTags(id, data?.photo?.tags || []);
}

async function detailAddTags(id) {
  const tags = parseTags($('lbAddTag').value);
  if (!tags.length) return;
  await getJSON('/api/tags/apply', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ photo_ids: [id], tags }),
  });
  $('lbAddTag').value = '';
  await loadTags();
  await refreshDetailTags(id);
}

async function detailRemoveTag(id, name) {
  await getJSON('/api/tags/remove', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ photo_ids: [id], tags: [name] }),
  });
  await loadTags();
  await refreshDetailTags(id);
}

async function renameDetail() {
  const p = state.photos[state.detailIndex];
  if (!p) return;
  const next = prompt('Rename image', p.original_filename || '');
  if (next === null) return;                 // cancelled
  const name = next.trim();
  if (!name || name === p.original_filename) return;

  const { ok, data } = await getJSON('/api/photos/' + p.id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ original_filename: name }),
  });
  if (!ok) { setStatus('Rename failed.'); return; }

  p.original_filename = data?.original_filename || name;
  renderDetail();                            // refresh the meta line
  const tileImg = grid().querySelector(`.tile[data-id="${p.id}"] img`);
  if (tileImg) tileImg.alt = p.original_filename;
}

// ---- view switching ----
function setMode(mode) {
  state.mode = mode;
  $('viewAll').classList.toggle('active', mode === 'all');
  $('viewUntagged').classList.toggle('active', mode === 'untagged');
  loadPhotos(true);
}

function setSelectMode(on) {
  state.selectMode = on;
  $('selectToggle').classList.toggle('active', on);
  document.body.classList.toggle('selecting', on);
  if (!on) clearSelection(); else updateSelbar();
}

// ---- upload ----
async function uploadFiles(files) {
  const list = [...files];
  if (!list.length) return;
  let ok = 0, dup = 0, fail = 0;
  for (let i = 0; i < list.length; i++) {
    setStatus(`Uploading ${i + 1} of ${list.length}\u2026`);
    try {
      const r = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'X-Filename': encodeURIComponent(list[i].name) },
        body: list[i],
      });
      if (r.status === 201) ok++;
      else if (r.status === 200) { dup++; ok++; }
      else fail++;
    } catch { fail++; }
  }
  setStatus(`Uploaded ${ok}` + (dup ? ` (${dup} already in library)` : '') + (fail ? `, ${fail} failed` : '') + '.');
  await loadTags();
  state.query = '';
  document.getElementById('searchInput').value = '';
  setMode('all'); // uploads sort to the top of the timeline
}

// ---- init ----
function init() {
  $('searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    state.query = $('searchInput').value.trim();
    setMode('all');
  });
  $('viewAll').addEventListener('click', () => { $('searchInput').value = ''; state.query = ''; setMode('all'); });
  $('viewUntagged').addEventListener('click', () => setMode('untagged'));
  $('selectToggle').addEventListener('click', () => setSelectMode(!state.selectMode));
  $('loadMore').addEventListener('click', () => loadPhotos(false));
  $('uploadBtn').addEventListener('click', () => $('fileInput').click());
  $('logoutBtn').addEventListener('click', async () => {
    await fetch('/logout', { method: 'POST' });
    window.location = '/login';
  });
  $('fileInput').addEventListener('change', (e) => { uploadFiles(e.target.files); e.target.value = ''; });

  $('selApply').addEventListener('click', () => bulkTag(false));
  $('selRemove').addEventListener('click', () => bulkTag(true));
  $('selClear').addEventListener('click', clearSelection);
  $('selTags').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); bulkTag(false); } });

  $('lbClose').addEventListener('click', closeDetail);
  $('lbRename').addEventListener('click', renameDetail);
  $('lbPrev').addEventListener('click', () => step(-1));
  $('lbNext').addEventListener('click', () => step(1));
  $('lightbox').addEventListener('click', (e) => { if (e.target === $('lightbox') || e.target.classList.contains('lb-stage')) closeDetail(); });
  $('lbAddTag').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); detailAddTags(state.photos[state.detailIndex].id); }
  });
  $('lbAddTag').addEventListener('input', renderSuggest);
  document.addEventListener('keydown', (e) => {
    if ($('lightbox').hidden) return;
    if (e.key === 'Escape') closeDetail();
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  });

  loadTags();
  loadPhotos(true);
}

document.addEventListener('DOMContentLoaded', init);