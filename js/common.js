export const $ = (id) => document.getElementById(id);
export const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Answers mark key terms as **bold** and *italic*. Built with createElement and text nodes only, so nothing is parsed as HTML.
export function richText(parent, text) {
  for (const part of text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/)) {
    if (!part) continue;
    if (part.startsWith('**')) parent.append(el('strong', null, part.slice(2, -2)));
    else if (part.startsWith('*')) parent.append(el('em', null, part.slice(1, -1)));
    else parent.append(part);
  }
  return parent;
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export class ApiError extends Error {
  constructor(status, code, retryAfter) {
    super(code);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const SAVED_PREFIX = 'interviewsyntax:';
const MAX_SAVED_CHARS = 300_000;
const MAX_SAVED_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function readSaved(key) {
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    return saved && Date.now() - saved.savedAt < MAX_SAVED_AGE_MS ? saved.body : null;
  } catch {
    return null;
  }
}

function writeSaved(key, body) {
  const text = JSON.stringify({ savedAt: Date.now(), body });
  if (text.length > MAX_SAVED_CHARS) return;
  try {
    localStorage.setItem(key, text);
  } catch {
    // storage full: drop everything we saved earlier and try once more
    try {
      for (const stored of Object.keys(localStorage)) if (stored.startsWith(SAVED_PREFIX)) localStorage.removeItem(stored);
      localStorage.setItem(key, text);
    } catch {
      // storage unavailable: nothing is saved
    }
  }
}

function showSavedNotice() {
  if ($('saved-notice')) return;
  const note = el('p', 'note', 'Showing saved data. The service is busy or temporarily unavailable, so this may be out of date.');
  note.id = 'saved-notice';
  note.setAttribute('role', 'status');
  document.querySelector('.page > main')?.before(note);
}

// Tells the backend what a visitor did (page viewed, category opened, request failed) so we can see usage.
// Anonymous: no cookies, nothing stored in the browser, and the backend keeps only a daily-changing hash.
export function track(fields) {
  if (globalThis.navigator?.doNotTrack === '1') return;
  fetch(`/api/v1/ping?${new URLSearchParams(fields)}`, { keepalive: true }).catch(() => {});
}

export async function api(path, params = {}) {
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  const url = `/api/v1/${path}${query ? `?${query}` : ''}`;
  const key = SAVED_PREFIX + url;
  // When the service is down or busy, fall back to the last good copy of this exact request.
  const failWith = (error) => {
    track({ kind: 'error', status: error.status });
    const saved = error.status === 0 || error.status === 429 || error.status >= 500 ? readSaved(key) : null;
    if (!saved) throw error;
    showSavedNotice();
    return saved;
  };
  let response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch {
    return failWith(new ApiError(0, 'network'));
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) return failWith(new ApiError(response.status, body?.error?.code ?? 'error', Number(response.headers.get('Retry-After')) || 60));
  writeSaved(key, body);
  return body;
}

export function errorMessage(error) {
  if (error instanceof ApiError) {
    if (error.status === 429) return `Too many requests, try again in ${plural(error.retryAfter, 'second')}.`;
    if (error.status === 404) return 'Not found.';
    if (error.status === 0 || error.status >= 500) return 'The data service is temporarily unavailable. Please try again in a few minutes.';
  }
  return 'Something went wrong. Please try again.';
}

export function showStatus(container, text, onRetry) {
  const note = el('p', 'note', text);
  note.setAttribute('role', 'status');
  container.replaceChildren(note);
  if (onRetry) {
    const retry = el('button', 'btn', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', onRetry);
    container.append(retry);
  }
}

export function safeUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('https://')) return null;
  try {
    return new URL(value).href;
  } catch {
    return null;
  }
}

const RECENT_DAYS = 14;

// "written" is a YYYY-MM-DD date. Answers published in the last two weeks are flagged as new.
export function isRecent(written, now = Date.now()) {
  const time = Date.parse(`${written}T00:00:00`);
  return Number.isFinite(time) && now - time >= 0 && now - time <= RECENT_DAYS * 86_400_000;
}

export function formatDay(written) {
  const date = new Date(`${written}T00:00:00`);
  return Number.isNaN(date.getTime()) ? written : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// Marks the nav link for the section being viewed.
export function markNav(href) {
  for (const a of document.querySelectorAll('.nav a')) {
    if (a.getAttribute('href') === href) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

export function link(url, text, className) {
  const href = safeUrl(url);
  if (!href) return el('span', className, text);
  const anchor = el('a', className, text);
  anchor.href = href;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  return anchor;
}

export function initTheme() {
  const button = $('theme');
  const dark = () => (document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
  const label = () => { button.textContent = dark() ? 'Light mode' : 'Dark mode'; };
  button.addEventListener('click', () => {
    const next = dark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('theme', next);
    } catch {
      // storage blocked: the choice lasts for this page only
    }
    label();
  });
  label();
}
