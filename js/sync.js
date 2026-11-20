// Keeps a signed-in person's progress and tracked companies in step with the server. No DOM here, so it is tested in Node.
//
// The server is the authority and no clock on this device is ever used. Every write says which revision it was based on
// (baseRev). If the server has moved on, it answers 409 with its current state; we adopt that state and tell the person
// once. We never retry a conflicting write, so a stale device cannot overwrite newer progress.
//
// Browser storage is only a speed-up: a copy of the last known state (so the page can show it at once) and writes that
// have not reached the server yet. It is keyed by the account's public reference, so another account never sees it, and
// it is erased at sign-out and account deletion.

const PREFIX = 'isx-u:';
const RETRY_MS = [2000, 5000, 15000, 30000, 60000];
const SETTLE_MS = 2500;

const progressKey = (type, id) => `p:${type}:${id}`;
const companyKey = (slug) => `c:${slug}`;

export const keys = { progress: progressKey, company: companyKey };

function parseKey(key) {
  const [kind, a, b] = key.split(':');
  return kind === 'p' ? { kind, type: a, id: Number(b) } : { kind, slug: a };
}

const DEFAULTS = { p: 'none', c: false };

export function createSync({
  fetchImpl = (...args) => fetch(...args),
  storage = null,
  channel = null,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  newOpId = () => crypto.randomUUID().replaceAll('-', ''),
  onChange = () => {},
  onNotice = () => {},
  onAuthLost = () => {},
} = {}) {
  let ref = null;
  let items = new Map();   // key -> { value, rev }  (what the server last told us)
  let entries = new Map(); // key -> { value, baseRev, opId, inflight, desired, attempts }
  let ready = false;
  let loaded = false;      // the server's state has been fetched at least once for this account
  let authLost = false;
  let timer = null;
  let notifiedOffline = false;
  let touched = new Set(); // keys written while a refresh was in flight: that refresh's snapshot may predate them

  const persist = () => {
    if (!storage || !ref) return;
    try {
      storage.setItem(PREFIX + ref, JSON.stringify({
        v: 1,
        items: [...items].map(([key, i]) => [key, i.value, i.rev]),
        queue: [...entries].map(([key, e]) => [key, e.value, e.baseRev, e.opId]),
      }));
    } catch {
      // storage full or blocked: everything still works for this visit
    }
  };

  const readCache = (forRef) => {
    try {
      const saved = JSON.parse(storage?.getItem(PREFIX + forRef) ?? 'null');
      if (saved?.v !== 1 || !Array.isArray(saved.items) || !Array.isArray(saved.queue)) return null;
      return saved;
    } catch {
      return null;
    }
  };

  const post = (message) => { try { channel?.postMessage({ ref, ...message }); } catch { /* channel closed */ } };
  const emit = (key) => onChange(key);

  function reset() {
    items = new Map();
    entries = new Map();
    ready = false;
    loaded = false;
    touched = new Set();
    authLost = false;
    notifiedOffline = false;
    if (timer) clearTimer(timer);
    timer = null;
  }

  function clearAll(broadcast = true) {
    reset();
    ref = null;
    if (storage) {
      try {
        for (const stored of Object.keys(storage)) if (stored.startsWith(PREFIX)) storage.removeItem(stored);
      } catch {
        // nothing to clear
      }
    }
    if (broadcast) post({ type: 'cleared' });
    emit(null);
  }

  const requestFor = (key, entry) => {
    const k = parseKey(key);
    if (k.kind === 'p') return { url: '/me/progress', body: { type: k.type, id: k.id, status: entry.value, baseRev: entry.baseRev, opId: entry.opId } };
    return { url: `/me/companies/${encodeURIComponent(k.slug)}`, body: { tracked: entry.value, baseRev: entry.baseRev, opId: entry.opId } };
  };

  const valueFrom = (key, data) => (key.startsWith('p:') ? (data.status ?? 'none') : Boolean(data.tracked));

  function scheduleRetry(seconds) {
    if (timer) return;
    const attempts = Math.max(0, ...[...entries.values()].map((e) => e.attempts ?? 0));
    const wait = seconds ? seconds * 1000 : RETRY_MS[Math.min(attempts, RETRY_MS.length - 1)];
    timer = setTimer(() => { timer = null; if (!loaded) refresh(); else flush(); }, wait);
  }

  async function send(key, entry) {
    entry.inflight = true;
    const { url, body } = requestFor(key, entry);
    let response;
    try {
      response = await fetchImpl(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
    } catch {
      entry.inflight = false;
      entry.attempts = (entry.attempts ?? 0) + 1;
      if (!notifiedOffline) { notifiedOffline = true; onNotice({ kind: 'offline' }); }
      scheduleRetry();
      return;
    }
    if (entries.get(key) !== entry) return; // cleared or replaced while we waited (sign-out, another account)
    const reply = await response.json().catch(() => null);
    entry.inflight = false;
    let backOff = false;

    if (response.ok && reply?.data) {
      notifiedOffline = false;
      const rev = Number(reply.data.rev);
      items.set(key, { value: valueFrom(key, reply.data), rev });
      touched.add(key);
      const next = entry.desired;
      if (next !== undefined && next !== items.get(key).value) {
        entries.set(key, { value: next, baseRev: rev, opId: newOpId(), inflight: false, attempts: 0 });
      } else {
        entries.delete(key);
      }
      post({ type: 'item', key, value: items.get(key).value, rev });
    } else if (response.status === 409 && reply?.current) {
      // Someone (usually another device) changed this first. Adopt their state; never resend ours.
      const current = { value: valueFrom(key, reply.current), rev: Number(reply.current.rev) };
      const mine = entry.desired !== undefined ? entry.desired : entry.value;
      items.set(key, current);
      touched.add(key);
      entries.delete(key);
      post({ type: 'item', key, value: current.value, rev: current.rev });
      if (current.value !== mine) onNotice({ kind: 'conflict', key, value: current.value });
    } else if (response.status === 401) {
      authLost = true;
      onAuthLost();
    } else if (response.status === 429 || response.status >= 500) {
      backOff = true;
      entry.attempts = (entry.attempts ?? 0) + 1;
      scheduleRetry(response.status === 429 ? Number(response.headers.get('Retry-After')) || 60 : 0);
    } else {
      // The server refused this change outright (unknown question, bad request, wrong origin): drop it and show the truth.
      entries.delete(key);
      onNotice({ kind: 'rejected', key });
    }
    persist();
    emit(key);
    if (!authLost && !backOff) flush();
  }

  function flush() {
    if (authLost || !ref) return;
    for (const [key, entry] of entries) if (!entry.inflight) send(key, entry);
  }

  async function getJson(url) {
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (response.status === 401) { const e = new Error('401'); e.status = 401; throw e; }
    if (!response.ok) { const e = new Error(String(response.status)); e.status = response.status; throw e; }
    return (await response.json()).data.items;
  }

  // Fetches the server's state. Failures keep whatever is shown and are retried; a 401 means the session is gone.
  async function refresh() {
    const forRef = ref;
    touched = new Set();
    try {
      const [progress, companies] = await Promise.all([getJson('/me/progress'), getJson('/me/companies')]);
      if (ref !== forRef) return;
      const fresh = new Map();
      for (const p of progress) fresh.set(progressKey(p.type, p.id), { value: p.status, rev: p.rev });
      for (const c of companies) fresh.set(companyKey(c.slug), { value: Boolean(c.tracked), rev: c.rev });
      // A write that finished while we were fetching is newer than this snapshot: keep what we know for those keys.
      for (const key of touched) { const mine = items.get(key); if (mine) fresh.set(key, mine); }
      items = fresh;
      ready = true;
      loaded = true;
      authLost = false;
      persist();
      emit(null);
      flush();
    } catch (error) {
      if (ref !== forRef) return;
      if (error.status === 401) { authLost = true; onAuthLost(); }
      else scheduleRetry();
    }
  }

  return {
    // Called once /me says who is signed in. Shows the saved copy at once, then replaces it with the server's.
    async start(publicRef) {
      if (ref !== publicRef) {
        reset();
        ref = publicRef;
        const saved = readCache(publicRef);
        if (saved) {
          for (const [key, value, rev] of saved.items) items.set(key, { value, rev });
          for (const [key, value, baseRev, opId] of saved.queue) entries.set(key, { value, baseRev, opId, inflight: false, attempts: 0 });
          ready = true;
          emit(null);
        }
      }
      await refresh();
    },

    isReady: () => ready && !authLost,
    get(key) {
      const e = entries.get(key);
      const i = items.get(key);
      const kind = key[0];
      return { value: e ? (e.desired !== undefined ? e.desired : e.value) : (i ? i.value : DEFAULTS[kind]), pending: Boolean(e) };
    },

    // The person picked a value. Returns false if we cannot accept it yet (state not loaded).
    set(key, value) {
      if (!ready || authLost || !ref) return false;
      const entry = entries.get(key);
      const item = items.get(key);
      if (entry) {
        if (entry.inflight) entry.desired = value;
        else if (item ? item.value === value : value === DEFAULTS[key[0]]) entries.delete(key);
        else { entry.value = value; entry.opId = newOpId(); }
      } else {
        if ((item ? item.value : DEFAULTS[key[0]]) === value) return true;
        entries.set(key, { value, baseRev: item ? item.rev : 0, opId: newOpId(), inflight: false, attempts: 0 });
      }
      persist();
      emit(key);
      flush();
      return true;
    },

    flush,
    // Resolves when nothing is waiting to be sent, or after a short limit (used before signing out).
    async settle(limit = SETTLE_MS) {
      const until = Date.now() + limit;
      while (entries.size && !authLost && Date.now() < until) await new Promise((r) => setTimer(r, 50));
    },
    pendingCount: () => entries.size,
    clearAll,

    // Another tab of the same account changed something: take it if it is newer than what we know.
    receive(message) {
      if (!message || message.ref !== ref) {
        if (message?.type === 'cleared') clearAll(false);
        return;
      }
      if (message.type === 'cleared') { clearAll(false); return; }
      if (message.type !== 'item') return;
      const known = items.get(message.key);
      if (entries.has(message.key) || (known && known.rev >= message.rev)) return;
      items.set(message.key, { value: message.value, rev: message.rev });
      persist();
      emit(message.key);
    },
    ref: () => ref,
  };
}
