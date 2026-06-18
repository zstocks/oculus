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
  present: false,         // presentation (fullscreen, chrome hidden) is active
  idleTimer: null,        // hides the control bar / cursor after inactivity
  slideshow: {
    active: false,        // auto-advancing is running
    playing: false,       // not paused
    shuffle: false,
    repeat: false,
    intervalMs: 5000,     // 10000 slow / 5000 medium / 3000 fast
    order: [],            // photo indices in play order (shuffled when shuffle is on)
    pos: 0,               // current position within `order`
    timer: null,          // pending auto-advance
  },
};

const IDLE_MS = 2800;     // how long before controls + cursor fade in presentation mode

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
  exitPresentation();        // also stops any running slideshow
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

  img.onerror = () => {                       // preview route unreachable -> fall back to thumbnail
    img.onerror = null;
    img.src = '/api/thumb/' + p.hash;
    offline.hidden = false;
  };
  // The lightbox shows the local ~2048px preview (instant); full resolution is an
  // explicit Download. The preview route already degrades to the thumbnail server-side
  // if the box is down, so onerror is only a last resort.
  img.src = '/api/preview/' + p.hash;

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

// Native browser download of the full-resolution original. The server sets
// Content-Disposition: attachment, so this streams to the device's downloads without
// navigating away. The original is read straight from the Storage Box mount.
function downloadDetail() {
  const p = state.photos[state.detailIndex];
  if (!p) return;
  const a = document.createElement('a');
  a.href = '/api/download/' + p.id;
  a.download = p.original_filename || '';   // hint; server's filename takes precedence
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---- presentation mode ----
// Enters the chrome-free fullscreen view for whatever photo is currently open.
// Requesting fullscreen must happen inside the originating user gesture, so any
// async work (loading the rest of a slideshow set) is deferred until after this.
function enterPresentation() {
  if (state.present || state.detailIndex < 0) return;
  state.present = true;
  const lb = $('lightbox');
  lb.classList.add('presenting');
  if (lb.requestFullscreen) lb.requestFullscreen().catch(() => {}); // CSS still covers the viewport if denied
  bumpControls();
  updateControls();
}

function exitPresentation() {
  if (!state.present) return;
  state.present = false;
  stopSlideshow();
  const lb = $('lightbox');
  lb.classList.remove('presenting', 'idle');
  clearTimeout(state.idleTimer);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// Reveal the controls + cursor, then arm the timer that hides them again.
function bumpControls() {
  if (!state.present) return;
  $('lightbox').classList.remove('idle');
  clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    if (state.present) $('lightbox').classList.add('idle');
  }, IDLE_MS);
}

// ---- slideshow ----
// Walk every page of the current query so shuffle/repeat span the whole filtered
// set, not just the first loaded page. ~400 images max, so this is cheap.
async function loadAllPhotos() {
  while (!state.end) {
    const before = state.photos.length;
    await loadPhotos(false);
    if (state.photos.length === before) break; // guard against a stuck page
  }
}

function shuffleInPlace(a) {                       // Fisher-Yates
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

function buildOrder() {
  const order = Array.from({ length: state.photos.length }, (_, i) => i);
  if (state.slideshow.shuffle) shuffleInPlace(order);
  state.slideshow.order = order;
}

function showSlide() {
  const ss = state.slideshow;
  state.detailIndex = ss.order[ss.pos];
  if ($('lightbox').hidden) {
    $('lightbox').hidden = false;
    document.body.classList.add('modal-open');
  }
  renderDetail();
  preloadNext();
}

// Decode the next slide's preview ahead of time so transitions don't flash.
function preloadNext() {
  const ss = state.slideshow;
  if (!ss.active) return;
  let next = ss.pos + 1;
  if (next >= ss.order.length) next = ss.repeat ? 0 : -1;
  if (next < 0) return;
  const p = state.photos[ss.order[next]];
  if (p) { const im = new Image(); im.src = '/api/preview/' + p.hash; }
}

function scheduleSlide() {
  const ss = state.slideshow;
  clearTimeout(ss.timer);
  if (ss.active && ss.playing) ss.timer = setTimeout(() => slideshowStep(1), ss.intervalMs);
}

function slideshowStep(delta) {
  const ss = state.slideshow;
  if (!ss.active || !ss.order.length) return;
  let pos = ss.pos + delta;
  if (pos >= ss.order.length) {
    if (!ss.repeat) { setPlaying(false); return; }   // reached the end, not repeating -> just stop advancing
    pos = 0;
    if (ss.shuffle) buildOrder();                    // fresh shuffle each lap
  } else if (pos < 0) {
    pos = ss.repeat ? ss.order.length - 1 : 0;
  }
  ss.pos = pos;
  showSlide();
  scheduleSlide();
}

// Begin auto-advancing. `fromCurrent` continues from the open image (used by the
// in-presentation Play button); otherwise it starts at the top of the set.
// The synchronous prefix (everything before the await) opens the first slide, so a
// caller can request fullscreen right after — still inside the originating gesture.
async function beginSlideshow(fromCurrent) {
  if (!state.photos.length) { setStatus('Nothing to play — no photos in this view.'); return; }
  const ss = state.slideshow;
  ss.active = true;
  ss.playing = true;
  buildOrder();
  ss.pos = fromCurrent ? Math.max(0, ss.order.indexOf(state.detailIndex)) : 0;
  showSlide();
  scheduleSlide();
  updateControls();

  // Pull in the rest of the filtered set in the background, then widen the order
  // to include it without disturbing the slide currently on screen.
  if (!state.end) {
    const current = state.detailIndex;
    await loadAllPhotos();
    buildOrder();
    ss.pos = Math.max(0, ss.order.indexOf(current));
  }
}

// Topbar entry point: play the whole current view from the start, in fullscreen.
function startSlideshow() {
  if (!state.photos.length) { setStatus('Nothing to play — no photos in this view.'); return; }
  beginSlideshow(false);   // synchronous prefix opens the first slide before this returns
  enterPresentation();     // request fullscreen while still inside the click gesture
}

// Play button inside presentation: start the show if idle, else pause/resume.
function playPause() {
  if (state.slideshow.active) setPlaying(!state.slideshow.playing);
  else beginSlideshow(true);
}

function stopSlideshow() {
  const ss = state.slideshow;
  clearTimeout(ss.timer);
  ss.active = false;
  ss.playing = false;
  updateControls();
}

function setPlaying(on) {
  state.slideshow.playing = on;
  if (on) scheduleSlide(); else clearTimeout(state.slideshow.timer);
  updateControls();
}

function setSpeed(ms) {
  state.slideshow.intervalMs = ms;
  if (state.slideshow.playing) scheduleSlide();   // restart the countdown at the new rate
  updateControls();
}

function toggleShuffle() {
  const ss = state.slideshow;
  ss.shuffle = !ss.shuffle;
  const current = state.detailIndex;
  buildOrder();
  ss.pos = Math.max(0, ss.order.indexOf(current));  // keep the current image in place
  scheduleSlide();
  updateControls();
}

function toggleRepeat() {
  state.slideshow.repeat = !state.slideshow.repeat;
  updateControls();
}

// Reflect slideshow state on the overlay control bar.
function updateControls() {
  const ss = state.slideshow;
  $('ssPlay').innerHTML = ss.playing ? '&#10074;&#10074;' : '&#9654;';
  $('ssShuffle').classList.toggle('on', ss.shuffle);
  $('ssRepeat').classList.toggle('on', ss.repeat);
  for (const b of document.querySelectorAll('.ss-speed .ss-btn')) {
    b.classList.toggle('on', Number(b.dataset.ms) === ss.intervalMs);
  }
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
  $('lbDownload').addEventListener('click', downloadDetail);
  $('lbPresent').addEventListener('click', enterPresentation);
  $('lbPrev').addEventListener('click', () => step(-1));
  $('lbNext').addEventListener('click', () => step(1));

  // slideshow + presentation controls
  $('slideshowBtn').addEventListener('click', startSlideshow);
  $('ssPlay').addEventListener('click', playPause);
  $('ssPrev').addEventListener('click', () => (state.slideshow.active ? slideshowStep(-1) : step(-1)));
  $('ssNext').addEventListener('click', () => (state.slideshow.active ? slideshowStep(1) : step(1)));
  $('ssShuffle').addEventListener('click', toggleShuffle);
  $('ssRepeat').addEventListener('click', toggleRepeat);
  $('ssExit').addEventListener('click', exitPresentation);
  for (const b of document.querySelectorAll('.ss-speed .ss-btn')) {
    b.addEventListener('click', () => setSpeed(Number(b.dataset.ms)));
  }
  $('lightbox').addEventListener('pointermove', bumpControls);
  $('lightbox').addEventListener('touchstart', bumpControls, { passive: true });
  // Browser/ESC-driven fullscreen exit -> leave presentation cleanly (no double exitFullscreen).
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && state.present) exitPresentation();
  });
  $('lightbox').addEventListener('click', (e) => {
    if (state.present) return;   // in presentation, the background is the show — only the controls act
    if (e.target === $('lightbox') || e.target.classList.contains('lb-stage')) closeDetail();
  });
  $('lbAddTag').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); detailAddTags(state.photos[state.detailIndex].id); }
  });
  $('lbAddTag').addEventListener('input', renderSuggest);
  document.addEventListener('keydown', (e) => {
    if ($('lightbox').hidden) return;
    const nav = (delta) => { if (state.slideshow.active) slideshowStep(delta); else step(delta); };
    if (e.key === 'Escape') { if (state.present) exitPresentation(); else closeDetail(); }
    else if (e.key === 'ArrowLeft') nav(-1);
    else if (e.key === 'ArrowRight') nav(1);
    else if (e.key === ' ' && state.present) { e.preventDefault(); playPause(); }
    else if (e.key === 'f' || e.key === 'F') { if (state.present) exitPresentation(); else enterPresentation(); }
  });

  loadTags();
  loadPhotos(true);
}

document.addEventListener('DOMContentLoaded', init);