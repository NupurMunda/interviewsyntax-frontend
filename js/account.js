// Sign-in, the account menu and the progress selectors. Everything here is optional: the page is already drawn by its own
// script, and if sign-in is switched off (or /me does not answer) nothing is added to it at all.
import { $, el } from './common.js?v=15';
import { createSync, keys } from './sync.js?v=15';

const ME_TIMEOUT_MS = 3000;
const STATUS_LABEL = { done: 'Done', revisit: 'Revisit' };
const TYPE_FOR_CATEGORY = { ai: 'ai', hld: 'system_design' };

let auth = { state: 'unknown', user: null }; // unknown | off | out | in
const authWaiters = [];
const selectors = new Map(); // key -> Set of { anchor, node, title, kind }
const pendingPlacements = [];
let styleReady = null;
let channel = null;
try {
  if ('BroadcastChannel' in globalThis) channel = new BroadcastChannel('isx-sync');
} catch {
  channel = null;
}

export const authState = () => auth;
export const typeForCategory = (category) => TYPE_FOR_CATEGORY[category] ?? null;
// Resolves once /me has answered (or failed): state 'off', 'out' or 'in'. Never rejects.
export const whenAuth = () => (auth.state === 'unknown' ? new Promise((resolve) => authWaiters.push(resolve)) : Promise.resolve(auth));

function storage() {
  try { return globalThis.localStorage; } catch { return null; }
}

// ---- talking to the private routes --------------------------------------------------------------------------------
export async function privateFetch(path, init = {}) {
  return fetch(path, { ...init, headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } });
}

// ---- small UI pieces -----------------------------------------------------------------------------------------------
function loadStyles() {
  styleReady ??= new Promise((resolve) => {
    const link = el('link');
    link.rel = 'stylesheet';
    link.href = '/css/account.css?v=15';
    link.addEventListener('load', resolve);
    link.addEventListener('error', resolve);
    document.head.append(link);
  });
  return styleReady;
}

let toastHost;
export function toast(message) {
  if (!toastHost) {
    toastHost = el('div', 'toasts');
    toastHost.setAttribute('role', 'status');
    document.body.append(toastHost);
  }
  const note = el('p', 'toast', message);
  toastHost.append(note);
  setTimeout(() => note.remove(), 7000);
}

export function initials(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0][0] ?? '') + (parts.length > 1 ? parts.at(-1)[0] : '')).toUpperCase();
}

function currentPath() {
  return location.pathname + location.search;
}

// Google's own button artwork (img/google-signin-*.svg, unmodified from Google's Sign in with Google branding assets):
// the light one on the light theme, the dark one on the dark theme. Size and artwork are fixed, as the guidelines require.
export function googleButton(href, id) {
  const link = el('a', 'gbtn');
  link.href = href;
  if (id) link.id = id;
  for (const theme of ['light', 'dark']) {
    const image = el('img', `g-${theme}`);
    image.src = `/img/google-signin-${theme}.svg?v=15`;
    image.alt = 'Sign in with Google';
    image.width = 180;
    image.height = 40;
    link.append(image);
  }
  return link;
}

export function signInUrl(next = currentPath()) {
  return `/auth/google?next=${encodeURIComponent(next)}`;
}

// ---- sign-in dialog ------------------------------------------------------------------------------------------------
let dialog;
export async function openSignIn(opener) {
  await loadStyles();
  if (!dialog) {
    dialog = el('dialog', 'dlg');
    dialog.setAttribute('aria-labelledby', 'signin-title');
    const title = el('h2', null, 'Sign in to track your progress');
    title.id = 'signin-title';
    const text = el('p', 'muted', 'Mark questions as done or to revisit, follow companies and see your preparation in one place. Browsing never needs an account.');
    const go = googleButton('/auth/google', 'signin-go');
    const fine = el('p', 'muted small');
    fine.append('We keep your Google account id, and your name and email only while you are signed in. ');
    const privacy = el('a', null, 'Privacy');
    privacy.href = '/privacy';
    fine.append(privacy, '.');
    const cancel = el('button', 'btn', 'Not now');
    cancel.type = 'button';
    cancel.addEventListener('click', () => dialog.close());
    const row = el('div', 'dlg-actions');
    row.append(go, cancel);
    dialog.append(title, text, row, fine);
    dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); }); // click on the backdrop
    document.body.append(dialog);
  }
  $('signin-go').href = signInUrl();
  dialog.returnTarget = opener;
  dialog.addEventListener('close', () => dialog.returnTarget?.focus?.(), { once: true });
  dialog.showModal();
  $('signin-go').focus();
}

// ---- header: Sign in button or account menu -----------------------------------------------------------------------
let headerControl = null;

function renderHeader() {
  headerControl?.panel?.remove();
  headerControl?.remove();
  headerControl = null;
  const theme = $('theme');
  theme?.parentElement?.classList.remove('has-acct');
  if (!theme || auth.state === 'off' || auth.state === 'unknown') return;
  if (auth.state === 'out') {
    const button = el('button', 'btn small', 'Sign in');
    button.type = 'button';
    button.id = 'signin-open';
    button.addEventListener('click', () => openSignIn(button));
    headerControl = button;
  } else {
    headerControl = accountMenu(auth.user);
  }
  theme.before(headerControl);
  theme.parentElement.classList.add('has-acct');
}

function accountMenu(user) {
  const wrap = el('div', 'acct');
  const button = el('button', 'acct-btn');
  button.type = 'button';
  button.id = 'acct-open';
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', 'acct-panel');
  button.setAttribute('aria-label', `Account menu for ${user.name || 'your account'}`);
  const avatar = el('span', 'avatar', initials(user.name));
  avatar.setAttribute('aria-hidden', 'true');
  button.append(avatar);

  const panel = el('nav', 'acct-panel');
  panel.setAttribute('aria-label', 'Account');
  panel.id = 'acct-panel';
  panel.hidden = true;
  panel.append(el('p', 'acct-who', `Signed in as ${user.name || 'you'}`));
  if (user.email) panel.append(el('p', 'muted small acct-email', user.email));
  if (user.ref) panel.append(el('p', 'muted small', `Support reference: ${user.ref}`));
  const menu = el('div', 'acct-links');
  const dash = el('a', null, 'My dashboard');
  dash.href = '/dashboard';
  const privacy = el('a', null, 'Privacy');
  privacy.href = '/privacy';
  const out = el('button', 'acct-out', 'Sign out');
  out.type = 'button';
  out.id = 'signout';
  out.addEventListener('click', () => signOut(out));
  menu.append(dash, privacy, out);
  panel.append(menu);

  const close = (focusButton) => {
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (focusButton) button.focus();
  };
  button.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    if (open) place();
    button.setAttribute('aria-expanded', String(open));
    if (open) panel.querySelector('a')?.focus();
  });
  const inside = (node) => wrap.contains(node) || panel.contains(node);
  const place = () => {
    // Right edge under the button, but always fully on screen with a 16px margin (the theme button sits to its right).
    const box = button.getBoundingClientRect();
    const width = panel.getBoundingClientRect().width;
    const left = Math.min(Math.max(16, box.right - width), document.documentElement.clientWidth - width - 16);
    panel.style.top = `${Math.round(box.bottom + 8)}px`;
    panel.style.left = `${Math.round(left)}px`;
  };
  const onKey = (event) => { if (event.key === 'Escape' && !panel.hidden) { event.stopPropagation(); close(true); } };
  wrap.addEventListener('keydown', onKey);
  panel.addEventListener('keydown', onKey);
  document.addEventListener('click', (event) => { if (!panel.hidden && !inside(event.target)) close(false); });
  const away = (event) => { if (!panel.hidden && event.relatedTarget && !inside(event.relatedTarget)) close(false); };
  wrap.addEventListener('focusout', away);
  panel.addEventListener('focusout', away);
  addEventListener('resize', () => { if (!panel.hidden) place(); });
  wrap.append(button);
  // The header clips anything hanging below it, so the panel lives on the page itself, placed under the button.
  document.body.append(panel);
  wrap.panel = panel;
  wrap.place = place;
  loadStyles();
  return wrap;
}

// ---- sync wiring ---------------------------------------------------------------------------------------------------
const sync = createSync({
  storage: storage(),
  channel,
  onChange: (key) => refreshSelectors(key),
  onNotice: (notice) => {
    if (notice.kind === 'offline') toast('You are offline or the service is busy. Your changes are saved here and will be sent when it is back.');
    else if (notice.kind === 'conflict') toast(`Changed on another device, so we kept the newer version: ${describe(notice.key, notice.value)}.`);
    else if (notice.kind === 'rejected') toast('That change could not be saved.');
  },
  onAuthLost: () => {
    toast('Your session has ended. Sign in again to keep saving your progress.');
    setAuth({ state: 'out', user: null }, { keepCache: true });
  },
});

function describe(key, value) {
  const names = [...(selectors.get(key) ?? [])];
  const title = names[0]?.title ?? 'a question';
  if (key.startsWith('c:')) return `${title} is now ${value ? 'tracked' : 'not tracked'}`;
  return `${title} is now ${STATUS_LABEL[value]?.toLowerCase() ?? 'not started'}`;
}

channel?.addEventListener('message', (event) => {
  if (event.data?.type === 'signout') setAuth({ state: 'out', user: null }, { keepCache: false, fromOtherTab: true });
  else sync.receive(event.data);
});

function announce(message) {
  try { channel?.postMessage(message); } catch { /* closed */ }
}

async function signOut(button) {
  button.disabled = true;
  await sync.settle();
  try {
    await privateFetch('/auth/logout', { method: 'POST' });
  } catch {
    // Even if the request fails, forget the account on this device. The session simply expires on the server.
  }
  announce({ type: 'signout' });
  setAuth({ state: 'out', user: null }, { keepCache: false });
}

function setAuth(next, { keepCache = false, fromOtherTab = false } = {}) {
  const was = auth;
  auth = next;
  if (next.state === 'out' && !keepCache) sync.clearAll();
  if (next.state === 'in' && next.user.ref !== was.user?.ref) sync.start(next.user.ref);
  renderHeader();
  refreshSelectors(null);
  for (const resolve of authWaiters.splice(0)) resolve(auth);
  if (fromOtherTab) toast('You signed out in another tab.');
}

// ---- selectors -----------------------------------------------------------------------------------------------------
function makeSelector(record) {
  const { key, title, kind } = record;
  const group = el('div', kind === 'company' ? 'prog prog-company' : 'prog');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', kind === 'company' ? `Tracking for ${title}` : `Progress for ${title}`);
  const buttons = kind === 'company' ? [['track', 'Track company']] : Object.entries(STATUS_LABEL);
  for (const [value, label] of buttons) {
    const button = el('button', 'prog-btn', label);
    button.type = 'button';
    button.dataset.value = value;
    button.addEventListener('click', () => choose(record, value, button));
    group.append(button);
  }
  record.node = group;
  paint(record);
  return group;
}

function paint(record) {
  const { node, key, kind } = record;
  if (!node) return;
  const signedIn = auth.state === 'in';
  const loading = signedIn && !sync.isReady();
  node.setAttribute('aria-busy', String(loading));
  const state = signedIn && !loading ? sync.get(key) : { value: kind === 'company' ? false : 'none', pending: false };
  for (const button of node.querySelectorAll('button')) {
    const on = kind === 'company' ? state.value === true : state.value === button.dataset.value;
    button.setAttribute('aria-pressed', String(on));
    button.disabled = loading;
  }
  node.classList.toggle('pending', state.pending);
}

function choose(record, value, button) {
  if (auth.state !== 'in') { openSignIn(button); return; }
  const current = sync.get(record.key).value;
  const next = record.kind === 'company' ? !current : (current === value ? 'none' : value);
  if (!sync.set(record.key, next)) { toast('Your progress is still loading. Try again in a moment.'); return; }
  announceChange(record, next);
}

function announceChange(record, next) {
  const live = liveRegion();
  live.textContent = record.kind === 'company'
    ? `${record.title} ${next ? 'tracked' : 'no longer tracked'}`
    : `${record.title}: ${next === 'none' ? 'cleared' : STATUS_LABEL[next]}`;
}

let live;
function liveRegion() {
  if (!live) {
    live = el('p', 'sr-only');
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    document.body.append(live);
  }
  return live;
}

function refreshSelectors(key) {
  const sets = key ? [selectors.get(key)] : [...selectors.values()];
  for (const set of sets) for (const record of set ?? []) { if (record.anchor.isConnected) paint(record); else set.delete(record); }
}

async function placeSelectors() {
  if (auth.state === 'off' || auth.state === 'unknown') return;
  await loadStyles();
  for (const record of pendingPlacements.splice(0)) {
    if (!record.anchor.isConnected) continue;
    record.place(makeSelector(record));
  }
}

function register(anchor, key, title, kind, place) {
  const record = { anchor, key, title, kind, place, node: null };
  if (!selectors.has(key)) selectors.set(key, new Set());
  selectors.get(key).add(record);
  pendingPlacements.push(record);
  if (auth.state === 'out' || auth.state === 'in') placeSelectors();
}

// Pages call these as they draw rows. Nothing is added to the page unless sign-in is on; then place(node) puts the control in.
export function attachProgress(anchor, { type, id, title }, place) {
  if (type) register(anchor, keys.progress(type, id), title, 'progress', place);
}
export function attachCompany(anchor, { slug, name }, place) {
  register(anchor, keys.company(slug), name, 'company', place);
}

const afterAuthPlace = () => { renderHeader(); placeSelectors(); };

// ---- start: /me in the background; the page never waits for it ----------------------------------------------------
async function start() {
  const params = new URLSearchParams(location.search);
  if (params.has('auth_error')) {
    toast('Sign-in did not complete. Please try again.');
    params.delete('auth_error');
    history.replaceState(null, '', location.pathname + (params.size ? `?${params}` : '') + location.hash);
  }
  let me = null;
  try {
    const response = await privateFetch('/me', { signal: AbortSignal.timeout(ME_TIMEOUT_MS) });
    // A 401 is a normal answer here (expired session): the body still says signedIn:false.
    if (response.ok || response.status === 401) me = await response.json();
  } catch {
    me = null;
  }
  if (me?.signedIn === true && typeof me.ref === 'string') setAuth({ state: 'in', user: { name: me.name ?? '', email: me.email ?? '', ref: me.ref, canDelete: me.canDelete === true } });
  else if (me?.signedIn === false) setAuth({ state: 'out', user: null }, { keepCache: true });
  else setAuth({ state: 'off', user: null }, { keepCache: true });
  afterAuthPlace();
  addEventListener('online', () => sync.flush());
}

export { sync, announce, loadStyles, toast as showToast };
start();
