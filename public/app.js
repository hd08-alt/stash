// Stash: client app. No build step; everything here runs as-is in the browser.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAY = 864e5;

/* ------------------------------------------------------------------ storage */

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
  },
};

const settings = Object.assign(
  { theme: 'system', size: 0, font: 'serif', paper: 'auto', rate: 1, voice: '' },
  store.get('stash.settings', {}),
);
const saveSettings = () => store.set('stash.settings', settings);

// The library is everything that's yours: saved items and what you've read.
// Each saved item carries updatedAt so two devices can be merged item by item.
let library = Object.assign({ items: {}, read: {} }, store.get('stash.library', {}));
function persistLibrary() {
  store.set('stash.library', library);
  sync.schedule();
}

/* --------------------------------------------------------------------- state */

let index = { articles: [], categories: [], feeds: [], generatedAt: null };
let byId = new Map();
const view = { tab: 'today', category: 'All', query: '', listFilter: 'unread' };

const savedItems = () => Object.values(library.items).filter((i) => !i.removed);
const isSaved = (id) => !!library.items[id] && !library.items[id].removed;
const isRead = (id) => !!library.read[id] || library.items[id]?.status === 'archived';

/* -------------------------------------------------------------------- format */

const fmtDay = (iso) => {
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - new Date(d).setHours(0, 0, 0, 0)) / DAY);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: diff < 7 ? 'long' : undefined, day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
};
const fmtShortDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const fmtTime = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fmtMinutes = (m) => (m >= 90 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);

function hashId(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return 'x' + (h >>> 0).toString(16);
}

/* --------------------------------------------------------------------- toast */

let toastTimer;
function toast(message, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(message)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = action.label;
    b.onclick = () => { action.run(); el.hidden = true; };
    el.append(b);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 6000 : 3000);
}

/* ------------------------------------------------------------- library ops */

const ARTICLE_URL = (id) => `data/articles/${id}.json`;

async function keepOffline(id) {
  // Saved articles are copied into Cache Storage so they outlive the 45-day
  // window on the server and can be read without a connection.
  try { const c = await caches.open('stash-saved'); await c.add(ARTICLE_URL(id)); } catch { /* offline or unsupported */ }
}
async function dropOffline(id) {
  try { const c = await caches.open('stash-saved'); await c.delete(ARTICLE_URL(id)); } catch {}
}

function saveArticle(a) {
  const now = Date.now();
  library.items[a.id] = {
    id: a.id, title: a.title, link: a.link, feed: a.feed, author: a.author || '', category: a.category || 'Saved links',
    excerpt: a.excerpt || '', image: a.image || null, minutes: a.minutes || null, published: a.published || null,
    fullText: a.fullText ?? false, external: !!a.external,
    savedAt: now, updatedAt: now, status: 'unread', progress: 0,
  };
  persistLibrary();
  if (!a.external) keepOffline(a.id);
}

function unsave(id) {
  const prev = library.items[id];
  if (!prev) return;
  library.items[id] = { id, removed: true, updatedAt: Date.now() };
  persistLibrary();
  dropOffline(id);
  render();
  toast('Removed from your list', {
    label: 'Undo',
    run: () => { library.items[id] = { ...prev, updatedAt: Date.now() }; persistLibrary(); if (!prev.external) keepOffline(id); render(); },
  });
}

function toggleSave(id) {
  if (isSaved(id)) return unsave(id);
  const a = byId.get(id);
  if (!a) return;
  saveArticle(a);
  toast('Saved to your reading list');
  render();
}

function setStatus(id, status) {
  const item = library.items[id];
  if (!item || item.removed) return;
  item.status = status;
  item.updatedAt = Date.now();
  persistLibrary();
}

function markRead(id) {
  if (library.read[id]) return;
  library.read[id] = Date.now();
  persistLibrary();
}

/* -------------------------------------------------------------------- render */

const ICON_SAVE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h12v17l-6-4-6 4z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';

function itemHtml(a, { showDone = false } = {}) {
  const saved = isSaved(a.id);
  const href = a.external ? a.link : `#/read/${a.id}`;
  const target = a.external ? ' target="_blank" rel="noopener"' : '';
  const meta = [
    `<span class="cat">${esc(a.category)}</span>`,
    `<span>${esc(a.feed || new URL(a.link).hostname.replace(/^www\./, ''))}</span>`,
    a.minutes ? `<span>${a.minutes} min</span>` : '',
    a.published ? `<time datetime="${esc(a.published)}">${fmtShortDate(a.published)}</time>` : '',
    a.external ? '<span>Opens original ↗</span>' : '',
  ].join('');
  const done = showDone
    ? `<button class="save" type="button" data-done="${a.id}">${a.status === 'archived' ? 'Move back' : 'Finished'}</button>`
    : '';
  return `<li class="item${isRead(a.id) ? ' is-read' : ''}">
    <div class="item-main">
      <div class="meta">${meta}</div>
      <h2><a href="${esc(href)}"${target}>${esc(a.title)}</a></h2>
      ${a.excerpt ? `<p class="ex">${esc(a.excerpt)}</p>` : ''}
    </div>
    <div class="item-side">
      ${a.image ? `<img class="thumb" src="${esc(a.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
      <div class="item-actions">
        ${done}
        <button class="save" type="button" data-save="${a.id}" aria-pressed="${saved}">${ICON_SAVE}${saved ? 'Saved' : 'Save'}</button>
      </div>
    </div>
  </li>`;
}

function latestBatch() {
  if (!index.articles.length) return [];
  // "Today" = everything fetched by the most recent daily run (plus a little slack).
  const newest = Math.max(...index.articles.map((a) => Date.parse(a.fetched)));
  const fresh = index.articles.filter((a) => Date.parse(a.fetched) >= newest - 30 * 36e5);
  return fresh.length ? fresh : index.articles.slice(0, 20);
}

function pool() {
  if (view.tab === 'today') return latestBatch();
  if (view.tab === 'list') {
    return savedItems()
      .filter((i) => (view.listFilter === 'archived' ? i.status === 'archived' : i.status !== 'archived'))
      .sort((a, b) => b.savedAt - a.savedAt);
  }
  return index.articles;
}

function matches(a) {
  if (view.category !== 'All' && a.category !== view.category) return false;
  if (!view.query) return true;
  const hay = `${a.title} ${a.author} ${a.feed} ${a.excerpt} ${a.category}`.toLowerCase();
  return view.query.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

function renderIntro(items) {
  const intro = $('#intro');
  const mins = items.reduce((n, a) => n + (a.minutes || 0), 0);
  if (view.tab === 'today') {
    const pubs = new Set(items.map((a) => a.feed)).size;
    const when = index.generatedAt ? `Gathered ${fmtTime(index.generatedAt)}.` : '';
    intro.innerHTML = `<h1>Today’s stash</h1>
      <p><span class="tally">${plural(items.length, 'article')} · ${plural(pubs, 'publication')} · ${fmtMinutes(mins)} of reading</span></p>
      <p>${when} Sorted by subject so you can start with what you’re in the mood for.</p>`;
  } else if (view.tab === 'browse') {
    intro.innerHTML = `<h1>Everything</h1>
      <p><span class="tally">${plural(items.length, 'article')} · ${fmtMinutes(mins)}</span></p>
      <p>The last few weeks of your feeds, newest first.</p>`;
  } else {
    const unread = savedItems().filter((i) => i.status !== 'archived');
    const umins = unread.reduce((n, a) => n + (a.minutes || 0), 0);
    intro.innerHTML = `<h1>Reading list</h1>
      <p><span class="tally">${plural(unread.length, 'article')} to read · ${fmtMinutes(umins)}</span></p>
      <p>Saved articles are kept on this device so you can read them offline.</p>`;
  }
}

function renderChips(items) {
  const counts = new Map();
  for (const a of items) counts.set(a.category, (counts.get(a.category) || 0) + 1);
  const order = [...index.categories, ...[...counts.keys()].filter((c) => !index.categories.includes(c))];
  const cats = order.filter((c) => counts.has(c));
  if (view.category !== 'All' && !counts.has(view.category)) view.category = 'All';
  $('#chips').innerHTML = ['All', ...cats]
    .map((c) => `<button class="chip" type="button" data-cat="${esc(c)}" aria-pressed="${view.category === c}">${esc(c)}<span class="n">${c === 'All' ? items.length : counts.get(c)}</span></button>`)
    .join('');
}

function render() {
  if (view.tab === 'read') return;
  const base = pool();
  renderIntro(base);
  renderChips(base);
  const items = base.filter(matches);

  let html = '';
  if (view.tab === 'today' && view.category === 'All') {
    // Group today's batch by subject, biggest groups first.
    const groups = new Map();
    for (const a of items) groups.set(a.category, [...(groups.get(a.category) || []), a]);
    [...groups].sort((a, b) => b[1].length - a[1].length).forEach(([cat, list]) => {
      html += `<li class="day" role="presentation">${esc(cat)}</li>` + list.map((a) => itemHtml(a)).join('');
    });
  } else if (view.tab === 'browse') {
    let lastDay = '';
    for (const a of items) {
      const day = fmtDay(a.published);
      if (day !== lastDay) { html += `<li class="day" role="presentation">${esc(day)}</li>`; lastDay = day; }
      html += itemHtml(a);
    }
  } else {
    html = items.map((a) => itemHtml(a, { showDone: view.tab === 'list' })).join('');
  }
  $('#articles').innerHTML = html;
  $('#articles').classList.toggle('grouped', view.tab === 'today' && view.category === 'All');

  const empty = $('#empty');
  empty.hidden = items.length > 0;
  if (!items.length) {
    empty.textContent = view.query || view.category !== 'All'
      ? 'Nothing matches that filter.'
      : view.tab === 'list'
        ? (view.listFilter === 'archived' ? 'Articles you finish will be kept here.' : 'Your list is empty. Tap Save on any article to keep it here.')
        : 'No articles yet. They arrive after the first daily update runs.';
  }

  const count = savedItems().filter((i) => i.status !== 'archived').length;
  $('#list-count').textContent = count || '';
  $('#list-filter').hidden = view.tab !== 'list';
  $('#add-link').hidden = view.tab !== 'list';
  $$('#list-filter button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.filter === view.listFilter));
  $('#foot').textContent = index.generatedAt ? `Feeds last checked ${new Date(index.generatedAt).toLocaleString()}` : '';
}

/* -------------------------------------------------------------------- reader */

const reader = { id: null, item: null };

function applyReaderSettings() {
  const r = $('#reader');
  r.dataset.font = settings.font;
  if (settings.paper === 'auto') delete r.dataset.paper; else r.dataset.paper = settings.paper;
  r.style.setProperty('--read-size', `${1.2 * (1 + settings.size * 0.08)}rem`);
  $$('#font-choice button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.font === settings.font));
  $$('#paper-choice button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.paper === settings.paper));
}

async function loadArticleBody(id) {
  const url = ARTICLE_URL(id);
  try {
    const res = await fetch(url);
    if (res.ok) return await res.json();
  } catch { /* fall through to the offline copy */ }
  try {
    const hit = await caches.match(url);
    if (hit) return await hit.json();
  } catch {}
  return null;
}

async function openReader(id) {
  const item = byId.get(id) || library.items[id];
  if (!item || item.removed) { location.hash = '#/'; return; }
  if (speaker.articleId && speaker.articleId !== id) speaker.stop();

  reader.id = id; reader.item = item;
  document.body.classList.add('reading');
  $('#reader').hidden = false;
  $('#type-panel').hidden = true;
  applyReaderSettings();

  $('#reader-eyebrow').textContent = [item.category, item.feed].filter(Boolean).join(' · ');
  $('#reader-title').textContent = item.title;
  $('#reader-byline').textContent = [item.author, item.published && fmtDay(item.published), item.minutes && `${item.minutes} min read`].filter(Boolean).join(' · ');
  $('#reader-original').href = item.link;
  updateReaderButtons();
  document.title = `${item.title} · Stash`;
  window.scrollTo(0, 0);

  if (speaker.articleId === id) return; // keep the highlighted text that's being read aloud
  const content = $('#reader-content');
  content.innerHTML = '<p class="teaser-note">Loading…</p>';
  const body = await loadArticleBody(id);
  if (reader.id !== id) return;
  if (!body) {
    content.innerHTML = `<p>This article isn’t available any more. <a href="${esc(item.link)}" target="_blank" rel="noopener">Read it on ${esc(item.feed || 'the original site')}</a>.</p>`;
    return;
  }
  content.innerHTML = body.html; // sanitised when the feed was fetched
  if (item.fullText === false) {
    content.insertAdjacentHTML('beforeend', `<p class="teaser-note">${esc(item.feed)} only publishes a summary in its feed. Read the full piece on the original site.</p>`);
  }
  if (isSaved(id)) keepOffline(id);

  const saved = library.items[id];
  if (saved?.progress > 0.05 && saved.progress < 0.95) {
    requestAnimationFrame(() => window.scrollTo(0, saved.progress * (document.documentElement.scrollHeight - innerHeight)));
  }
}

function closeReader() {
  document.body.classList.remove('reading');
  $('#reader').hidden = true;
  reader.id = null;
  document.title = 'Stash';
}

function updateReaderButtons() {
  const id = reader.id;
  const saved = isSaved(id);
  const save = $('#reader-save');
  save.setAttribute('aria-pressed', saved);
  save.textContent = saved ? 'Saved' : 'Save';
  const done = $('#reader-done');
  done.hidden = !saved;
  done.textContent = library.items[id]?.status === 'archived' ? 'Move back to list' : 'Mark finished';
}

let progressTimer;
function onScroll() {
  if (!reader.id) return;
  const max = document.documentElement.scrollHeight - innerHeight;
  const p = max > 0 ? Math.min(1, scrollY / max) : 1;
  $('#progress-bar').style.width = `${p * 100}%`;
  if (p > 0.92) markRead(reader.id);
  clearTimeout(progressTimer);
  progressTimer = setTimeout(() => {
    const item = library.items[reader.id];
    if (item && !item.removed && Math.abs((item.progress || 0) - p) > 0.02) {
      item.progress = p; item.updatedAt = Date.now(); persistLibrary();
    }
  }, 600);
}

/* ---------------------------------------------------------------- read aloud */

const synth = window.speechSynthesis;

const speaker = {
  articleId: null,
  blocks: [],
  i: 0,
  paused: false,
  gen: 0,
  current: null, // keep a reference: Chrome drops onend for garbage-collected utterances

  start() {
    if (!synth) return;
    const content = $('#reader-content');
    const sel = 'p, h1, h2, h3, h4, h5, li, blockquote, figcaption, dd, dt, pre';
    const blocks = $$(sel, content).filter((el) => !el.parentElement.closest(sel) && el.textContent.trim() && !el.classList.contains('teaser-note'));
    this.blocks = [$('#reader-title'), ...blocks];
    this.articleId = reader.id;
    this.i = 0;
    $('#player-title').textContent = reader.item.title;
    $('#player').hidden = false;
    this.mediaSession();
    this.play(0);
  },

  play(i) {
    this.i = Math.max(0, Math.min(i, this.blocks.length - 1));
    this.paused = false;
    $('#player').classList.remove('paused');
    $('#p-play').setAttribute('aria-label', 'Pause');
    this.speakBlock();
  },

  speakBlock() {
    const gen = ++this.gen;
    synth.cancel();
    $$('.speaking').forEach((el) => el.classList.remove('speaking'));
    const el = this.blocks[this.i];
    if (!el) return this.finish();
    el.classList.add('speaking');
    if (reader.id === this.articleId) el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    $('#player-pos').textContent = `Paragraph ${this.i + 1} of ${this.blocks.length}`;

    const chunks = splitForSpeech(el.textContent);
    const voice = synth.getVoices().find((v) => v.voiceURI === settings.voice);
    const next = (k) => {
      if (gen !== this.gen) return;
      if (k >= chunks.length) { this.i += 1; return this.speakBlock(); }
      const u = new SpeechSynthesisUtterance(chunks[k]);
      if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = document.documentElement.lang || 'en';
      u.rate = settings.rate;
      u.onend = () => next(k + 1);
      u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled') next(k + 1); };
      this.current = u;
      synth.speak(u);
    };
    // A short delay after cancel() avoids a Chrome bug where the next utterance is swallowed.
    setTimeout(() => next(0), 60);
  },

  toggle() {
    if (this.paused) return this.play(this.i);
    // pause()/resume() are unreliable on Android and Linux, so we stop and later restart the paragraph.
    this.gen++;
    synth.cancel();
    this.paused = true;
    $('#player').classList.add('paused');
    $('#p-play').setAttribute('aria-label', 'Play');
  },

  finish() {
    if (this.articleId) markRead(this.articleId);
    this.stop();
    toast('Finished reading aloud');
  },

  stop() {
    this.gen++;
    synth?.cancel();
    $$('.speaking').forEach((el) => el.classList.remove('speaking'));
    this.articleId = null;
    this.blocks = [];
    $('#player').hidden = true;
  },

  mediaSession() {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: reader.item.title, artist: reader.item.author || reader.item.feed, album: 'Stash' });
    const set = (a, fn) => { try { navigator.mediaSession.setActionHandler(a, fn); } catch {} };
    set('play', () => this.paused && this.toggle());
    set('pause', () => !this.paused && this.toggle());
    set('previoustrack', () => this.play(this.i - 1));
    set('nexttrack', () => this.play(this.i + 1));
    set('stop', () => this.stop());
  },
};

/** Split text into sentence-sized pieces (< ~220 chars); long utterances get cut off in some browsers. */
function splitForSpeech(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  const sentences = clean.match(/[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)\s*/g) || [clean];
  const out = [];
  let buf = '';
  for (let s of sentences) {
    while (s.length > 220) {
      const cut = Math.max(s.lastIndexOf(', ', 200), s.lastIndexOf('; ', 200), s.lastIndexOf(' ', 200));
      const at = cut > 40 ? cut + 1 : 200;
      if (buf) { out.push(buf); buf = ''; }
      out.push(s.slice(0, at));
      s = s.slice(at);
    }
    if ((buf + s).length > 220) { out.push(buf); buf = s; } else buf += s;
  }
  if (buf.trim()) out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

function fillVoices() {
  if (!synth) return;
  const voices = synth.getVoices();
  if (!voices.length) return;
  const lang = (navigator.language || 'en').slice(0, 2);
  const sorted = [...voices].sort((a, b) =>
    (b.lang.startsWith(lang) - a.lang.startsWith(lang)) || (b.localService - a.localService) || a.name.localeCompare(b.name));
  $('#p-voice').innerHTML = '<option value="">Default voice</option>' +
    sorted.map((v) => `<option value="${esc(v.voiceURI)}"${v.voiceURI === settings.voice ? ' selected' : ''}>${esc(v.name)} (${esc(v.lang)})</option>`).join('');
}

/* ---------------------------------------------------------------------- sync */

const GIST_FILE = 'stash-library.json';

function mergeLibraries(a, b) {
  const items = { ...a.items };
  for (const [id, item] of Object.entries(b.items || {})) {
    if (!items[id] || (item.updatedAt || 0) > (items[id].updatedAt || 0)) items[id] = item;
  }
  const read = { ...a.read };
  for (const [id, t] of Object.entries(b.read || {})) read[id] = Math.max(read[id] || 0, t);
  // Forget tombstones and read marks older than a year.
  const cutoff = Date.now() - 365 * DAY;
  for (const [id, item] of Object.entries(items)) if (item.removed && item.updatedAt < cutoff) delete items[id];
  for (const [id, t] of Object.entries(read)) if (t < cutoff) delete read[id];
  return { items, read };
}

const sync = {
  timer: null,
  busy: false,
  get cfg() { return store.get('stash.gist', null); },
  set cfg(v) { store.set('stash.gist', v); },

  schedule() {
    if (!this.cfg?.token) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), 2500);
  },

  async api(path, opts = {}) {
    const res = await fetch(`https://api.github.com${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${this.cfg.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    });
    if (res.status === 401) throw new Error('GitHub didn’t accept that token. Check it has the gist permission and hasn’t expired.');
    if (!res.ok) throw new Error(`GitHub answered ${res.status}. Try again in a minute.`);
    return res.json();
  },

  async findGist() {
    for (let page = 1; page <= 5; page++) {
      const list = await this.api(`/gists?per_page=100&page=${page}`);
      const hit = list.find((g) => g.files?.[GIST_FILE]);
      if (hit) return hit.id;
      if (list.length < 100) break;
    }
    const created = await this.api('/gists', {
      method: 'POST',
      body: JSON.stringify({ description: 'Stash reading list', public: false, files: { [GIST_FILE]: { content: JSON.stringify(library) } } }),
    });
    return created.id;
  },

  async run({ loud = false } = {}) {
    const cfg = this.cfg;
    if (!cfg?.token || this.busy) return;
    this.busy = true;
    const status = $('#sync-status');
    status.textContent = 'Syncing…';
    try {
      if (!cfg.id) { cfg.id = await this.findGist(); this.cfg = cfg; }
      const gist = await this.api(`/gists/${cfg.id}`);
      const file = gist.files?.[GIST_FILE];
      let remote = { items: {}, read: {} };
      if (file) {
        const raw = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
        try { remote = JSON.parse(raw); } catch {}
      }
      const merged = mergeLibraries(library, remote);
      const changedLocal = JSON.stringify(merged) !== JSON.stringify({ items: library.items, read: library.read });
      library = merged;
      store.set('stash.library', library);
      if (JSON.stringify(merged) !== JSON.stringify({ items: remote.items || {}, read: remote.read || {} })) {
        await this.api(`/gists/${cfg.id}`, { method: 'PATCH', body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(merged) } } }) });
      }
      cfg.last = Date.now(); this.cfg = cfg;
      status.textContent = `Synced ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
      if (changedLocal) { render(); savedItems().forEach((i) => !i.external && keepOffline(i.id)); }
      if (loud) toast('Reading list synced');
    } catch (err) {
      status.textContent = err.message;
      if (loud) toast(err.message);
    } finally {
      this.busy = false;
    }
  },
};

/* ---------------------------------------------------------------- settings */

function applyTheme() {
  if (settings.theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
  $$('#theme-choice button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.themeValue === settings.theme));
}

function openSettings() {
  applyTheme();
  const cfg = sync.cfg;
  $('#gist-token').value = cfg?.token || '';
  $('#sync-status').textContent = cfg?.last ? `Last synced ${new Date(cfg.last).toLocaleString()}.` : cfg?.token ? '' : 'Sync is off.';
  $('#feed-status').innerHTML = index.feeds.map((f) => `<li>
      <span>${f.site ? `<a href="${esc(f.site)}" target="_blank" rel="noopener">${esc(f.name)}</a>` : esc(f.name)}</span>
      <span class="st${f.ok ? '' : ' bad'}" title="${esc(f.error || '')}">${f.ok ? `${f.added} new today` : 'Couldn’t reach this feed'}</span>
    </li>`).join('') || '<li><span class="hint">Feeds will appear after the first update.</span></li>';
  $('#settings-dialog').showModal();
}

function downloadBackup() {
  const blob = new Blob([JSON.stringify({ app: 'stash', exportedAt: new Date().toISOString(), ...library }, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `stash-backup-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function restoreBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data.items) throw new Error();
    library = mergeLibraries(library, data);
    persistLibrary();
    render();
    toast(`Restored ${plural(Object.values(data.items).filter((i) => !i.removed).length, 'saved article')}`);
  } catch {
    toast('That file isn’t a Stash backup.');
  }
}

/* ------------------------------------------------------------------ routing */

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [tab, arg] = hash.split('/');
  if (tab === 'read' && arg) {
    view.tab = 'read';
    openReader(arg);
    return;
  }
  closeReader();
  view.tab = tab === 'browse' ? 'browse' : tab === 'list' ? 'list' : 'today';
  $$('.tabs a').forEach((a) => (a.dataset.tab === view.tab ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  $('#reader-back').href = `#/${view.tab === 'today' ? '' : view.tab}`;
  render();
  const y = scrollMemory[view.tab] || 0;
  requestAnimationFrame(() => window.scrollTo(0, y));
}
const scrollMemory = {};

/* ------------------------------------------------------------------- events */

function bind() {
  addEventListener('hashchange', () => {
    if (view.tab !== 'read') scrollMemory[view.tab] = scrollY;
    route();
  });
  addEventListener('scroll', onScroll, { passive: true });

  document.addEventListener('click', (e) => {
    const save = e.target.closest('[data-save]');
    if (save) return toggleSave(save.dataset.save);
    const done = e.target.closest('[data-done]');
    if (done) {
      const id = done.dataset.done;
      const archived = library.items[id]?.status === 'archived';
      setStatus(id, archived ? 'unread' : 'archived');
      if (!archived) markRead(id);
      render();
      toast(archived ? 'Moved back to your list' : 'Marked as finished');
      return;
    }
    const chip = e.target.closest('[data-cat]');
    if (chip) { view.category = chip.dataset.cat; render(); }
  });

  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { view.query = e.target.value.trim(); render(); }, 120);
  });
  $$('#list-filter button').forEach((b) => b.addEventListener('click', () => { view.listFilter = b.dataset.filter; render(); }));

  // Reader
  $('#reader-save').addEventListener('click', () => {
    if (isSaved(reader.id)) unsave(reader.id);
    else { saveArticle(reader.item); toast('Saved to your reading list'); }
    updateReaderButtons();
  });
  $('#reader-done').addEventListener('click', () => {
    const archived = library.items[reader.id]?.status === 'archived';
    setStatus(reader.id, archived ? 'unread' : 'archived');
    if (!archived) markRead(reader.id);
    updateReaderButtons();
    toast(archived ? 'Moved back to your list' : 'Marked as finished');
  });
  $('#reader-type').addEventListener('click', (e) => {
    const panel = $('#type-panel');
    panel.hidden = !panel.hidden;
    e.currentTarget.setAttribute('aria-expanded', !panel.hidden);
  });
  $$('[data-size]').forEach((b) => b.addEventListener('click', () => {
    settings.size = Math.max(-3, Math.min(6, settings.size + Number(b.dataset.size))); saveSettings(); applyReaderSettings();
  }));
  $$('[data-font]').forEach((b) => b.addEventListener('click', () => { settings.font = b.dataset.font; saveSettings(); applyReaderSettings(); }));
  $$('[data-paper]').forEach((b) => b.addEventListener('click', () => { settings.paper = b.dataset.paper; saveSettings(); applyReaderSettings(); }));
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && view.tab === 'read' && !$('#type-panel').hidden) $('#type-panel').hidden = true;
  });

  // Read aloud
  if (!synth) $('#listen').hidden = true;
  $('#listen').addEventListener('click', () => {
    if (speaker.articleId === reader.id) speaker.toggle(); else speaker.start();
  });
  $('#p-play').addEventListener('click', () => speaker.toggle());
  $('#p-prev').addEventListener('click', () => speaker.play(speaker.i - 1));
  $('#p-next').addEventListener('click', () => speaker.play(speaker.i + 1));
  $('#p-stop').addEventListener('click', () => speaker.stop());
  $('#p-rate').value = String(settings.rate);
  $('#p-rate').addEventListener('change', (e) => {
    settings.rate = Number(e.target.value); saveSettings();
    if (!speaker.paused && speaker.articleId) speaker.play(speaker.i);
  });
  $('#p-voice').addEventListener('change', (e) => {
    settings.voice = e.target.value; saveSettings();
    if (!speaker.paused && speaker.articleId) speaker.play(speaker.i);
  });
  $('#player-title').addEventListener('click', () => { if (speaker.articleId) location.hash = `#/read/${speaker.articleId}`; });
  if (synth) { fillVoices(); synth.addEventListener?.('voiceschanged', fillVoices); }

  // Save a link
  $('#add-link').addEventListener('click', () => { $('#link-form').reset(); $('#link-dialog').showModal(); });
  $('#link-dialog').addEventListener('close', () => {
    if ($('#link-dialog').returnValue !== 'save') return;
    const url = $('#link-url').value.trim();
    let parsed;
    try { parsed = new URL(url); } catch { return toast('That doesn’t look like a web address.'); }
    const known = index.articles.find((a) => a.link === parsed.href || a.link === url);
    if (known) saveArticle(known);
    else {
      saveArticle({
        id: hashId(parsed.href), title: $('#link-title').value.trim() || parsed.hostname.replace(/^www\./, '') + parsed.pathname.replace(/\/$/, ''),
        link: parsed.href, feed: parsed.hostname.replace(/^www\./, ''), category: 'Saved links', external: true,
      });
    }
    render();
    toast('Saved to your reading list');
  });

  // Settings
  $('#open-settings').addEventListener('click', openSettings);
  $$('#theme-choice button').forEach((b) => b.addEventListener('click', () => { settings.theme = b.dataset.themeValue; saveSettings(); applyTheme(); }));
  $('#sync-now').addEventListener('click', () => {
    const token = $('#gist-token').value.trim();
    if (!token) { $('#sync-status').textContent = 'Paste a token first.'; return; }
    const cfg = sync.cfg || {};
    if (cfg.token !== token) sync.cfg = { token };
    sync.run({ loud: true });
  });
  $('#sync-forget').addEventListener('click', () => {
    sync.cfg = null; $('#gist-token').value = ''; $('#sync-status').textContent = 'Sync is off. Your list stays on this device.';
  });
  $('#export').addEventListener('click', downloadBackup);
  $('#import').addEventListener('change', (e) => { if (e.target.files[0]) restoreBackup(e.target.files[0]); e.target.value = ''; });

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync.schedule(); });
}

/* --------------------------------------------------------------------- boot */

async function loadIndex() {
  try {
    const res = await fetch('data/index.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    index = await res.json();
  } catch {
    toast('Couldn’t load new articles. Showing your saved list.');
  }
  byId = new Map(index.articles.map((a) => [a.id, a]));
}

(async function boot() {
  applyTheme();
  bind();
  await loadIndex();
  route();
  sync.schedule();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
