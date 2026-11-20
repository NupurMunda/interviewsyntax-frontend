import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSync, keys } from '../js/sync.js';

// A stand-in for the Worker that follows the same rule as the real one (docs/PROGRESS-SYNC.md in the backend):
// a write applies only if baseRev equals the stored revision; a missing row is revision 0; a retry with the same opId
// is a success; anything else is a 409 with the current state; a non-zero baseRev never creates a row.
function fakeServer() {
  const rows = new Map(); // key -> { value, rev, lastOp }
  const server = {
    rows, calls: [], down: false, status: null, lostReplies: 0, signedIn: true, delay: null,
    fetch: async (url, init = {}) => {
      server.calls.push({ url, init });
      if (server.delay) await server.delay;
      if (server.down) throw new TypeError('offline');
      if (server.status) return new Response('{}', { status: server.status, headers: { 'Retry-After': '1' } });
      if (!server.signedIn) return Response.json({ error: { code: 'unauthenticated' } }, { status: 401 });
      const method = init.method ?? 'GET';
      if (method === 'GET') {
        const kind = url.endsWith('progress') ? 'p' : 'c';
        const items = [...rows].filter(([k]) => k[0] === kind).map(([k, r]) => {
          const [, a, b] = k.split(':');
          return kind === 'p' ? { type: a, id: Number(b), status: r.value, rev: r.rev } : { slug: a, tracked: r.value, rev: r.rev };
        });
        return Response.json({ data: { items } });
      }
      const body = JSON.parse(init.body);
      const key = url === '/me/progress' ? keys.progress(body.type, body.id) : keys.company(decodeURIComponent(url.split('/').pop()));
      const value = 'status' in body ? body.status : body.tracked;
      const row = rows.get(key);
      const shape = (r) => ('status' in body ? { status: r?.value ?? null, rev: r?.rev ?? 0 } : { tracked: r?.value ?? false, rev: r?.rev ?? 0 });
      let reply;
      if (row && row.rev === body.baseRev) {
        rows.set(key, { value, rev: row.rev + 1, lastOp: body.opId });
        reply = Response.json({ data: { ...shape(rows.get(key)) } });
      } else if (!row && body.baseRev === 0) {
        rows.set(key, { value, rev: 1, lastOp: body.opId });
        reply = Response.json({ data: { ...shape(rows.get(key)) } });
      } else if (row?.lastOp === body.opId) {
        reply = Response.json({ data: { ...shape(row), duplicate: true } });
      } else {
        reply = Response.json({ error: { code: 'conflict' }, current: shape(row) }, { status: 409 });
      }
      if (server.lostReplies > 0) { server.lostReplies -= 1; throw new TypeError('reply lost'); }
      return reply;
    },
  };
  return server;
}

const memory = () => {
  const data = new Map();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k), data, get length() { return data.size; }, ...{ [Symbol.iterator]: undefined } };
};
// Object.keys(storage) must list stored keys, as with localStorage.
const storageFor = () => {
  const store = {};
  return new Proxy(store, {
    get: (t, p) => (p === 'getItem' ? (k) => t[k] ?? null : p === 'setItem' ? (k, v) => { t[k] = String(v); } : p === 'removeItem' ? (k) => { delete t[k]; } : t[p]),
  });
};

const tick = () => new Promise((r) => setImmediate(r));
async function until(check, what = 'condition') {
  for (let i = 0; i < 200; i += 1) { if (check()) return; await new Promise((r) => setTimeout(r, 5)); }
  assert.fail(`timed out waiting for ${what}`);
}

function device(server, extra = {}) {
  const notices = [];
  const changes = [];
  const timers = [];
  const sync = createSync({
    fetchImpl: server.fetch, storage: storageFor(), newOpId: (() => { let n = 0; return () => `op-${extra.name ?? 'd'}-${++n}-xxxxxxxx`; })(),
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimer: (t) => { t.cancelled = true; },
    onNotice: (n) => notices.push(n), onChange: (k) => changes.push(k), onAuthLost: () => notices.push({ kind: 'authLost' }),
    ...extra,
  });
  return { sync, notices, changes, timers, runTimers: async () => { for (const t of timers.splice(0)) if (!t.cancelled) t.fn(); await tick(); } };
}

const K = keys.progress('ai', 7);

describe('basic writes', () => {
  it('cannot accept a change before the saved state has loaded, and shows nothing as "not started" until then', async () => {
    const d = device(fakeServer());
    assert.equal(d.sync.isReady(), false);
    assert.equal(d.sync.set(K, 'done'), false);
  });

  it('a first write is sent with baseRev 0, an update with the revision it was given', async () => {
    const s = fakeServer();
    const d = device(s);
    await d.sync.start('ref1');
    d.sync.set(K, 'done');
    await until(() => !d.sync.pendingCount());
    assert.deepEqual(JSON.parse(s.calls.at(-1).init.body).baseRev, 0);
    d.sync.set(K, 'revisit');
    await until(() => !d.sync.pendingCount());
    assert.equal(JSON.parse(s.calls.at(-1).init.body).baseRev, 1);
    assert.equal(s.rows.get(K).value, 'revisit');
    assert.equal(s.rows.get(K).rev, 2);
    assert.deepEqual(d.sync.get(K), { value: 'revisit', pending: false });
  });

  it('sends exactly the documented fields, no clock and no revision of its own', async () => {
    const s = fakeServer();
    const d = device(s);
    await d.sync.start('ref1');
    d.sync.set(K, 'done');
    d.sync.set(keys.company('acme'), true);
    await until(() => !d.sync.pendingCount());
    const bodies = s.calls.filter((c) => c.init.method === 'PUT').map((c) => Object.keys(JSON.parse(c.init.body)).sort());
    assert.deepEqual(bodies.sort(), [['baseRev', 'id', 'opId', 'status', 'type'], ['baseRev', 'opId', 'tracked']].sort());
    assert.ok(s.calls.filter((c) => c.init.method === 'PUT').every((c) => c.init.headers['Content-Type'] === 'application/json'));
  });

  it('resetting to "none" is a write like any other, and setting the current value again sends nothing', async () => {
    const s = fakeServer();
    const d = device(s);
    await d.sync.start('ref1');
    d.sync.set(K, 'done');
    await until(() => !d.sync.pendingCount());
    const before = s.calls.length;
    d.sync.set(K, 'done');
    assert.equal(s.calls.length, before);
    d.sync.set(K, 'none');
    await until(() => !d.sync.pendingCount());
    assert.equal(s.rows.get(K).value, 'none');
    assert.equal(s.rows.get(K).rev, 2);
  });

  it('a quick change while a write is in flight is sent after it, based on the new revision', async () => {
    const s = fakeServer();
    let release;
    const d = device(s);
    await d.sync.start('ref1');
    s.delay = new Promise((r) => { release = r; });
    d.sync.set(K, 'done');
    await tick();
    d.sync.set(K, 'revisit');
    assert.deepEqual(d.sync.get(K), { value: 'revisit', pending: true });
    s.delay = null;
    release();
    await until(() => !d.sync.pendingCount());
    assert.equal(s.rows.get(K).value, 'revisit');
    assert.equal(s.rows.get(K).rev, 2);
    assert.deepEqual(d.notices, []);
  });
});

describe('two devices', () => {
  it('a second device sees the first one\'s progress after it loads', async () => {
    const s = fakeServer();
    const a = device(s, { name: 'a' });
    const b = device(s, { name: 'b' });
    await a.sync.start('ref1');
    a.sync.set(K, 'done');
    a.sync.set(keys.company('acme'), true);
    await until(() => !a.sync.pendingCount());
    await b.sync.start('ref1');
    assert.deepEqual(b.sync.get(K), { value: 'done', pending: false });
    assert.equal(b.sync.get(keys.company('acme')).value, true);
  });

  it('a stale device cannot overwrite newer progress: it gets the newer state and a notice, and nothing is resent', async () => {
    const s = fakeServer();
    const a = device(s, { name: 'a' });
    const b = device(s, { name: 'b' });
    await a.sync.start('ref1');
    await b.sync.start('ref1'); // b has seen revision 0
    a.sync.set(K, 'done');
    await until(() => !a.sync.pendingCount());
    b.sync.set(K, 'revisit'); // b still believes revision 0
    await until(() => !b.sync.pendingCount());
    assert.equal(s.rows.get(K).value, 'done', 'the newer value is untouched');
    assert.equal(s.rows.get(K).rev, 1);
    assert.deepEqual(b.sync.get(K), { value: 'done', pending: false });
    assert.deepEqual(b.notices.filter((n) => n.kind === 'conflict').map((n) => [n.key, n.value]), [[K, 'done']]);
    assert.equal(s.calls.filter((c) => c.init.method === 'PUT').length, 2, 'the rejected write is not retried');
  });

  it('is silent when the other device chose the same value', async () => {
    const s = fakeServer();
    const a = device(s, { name: 'a' });
    const b = device(s, { name: 'b' });
    await a.sync.start('ref1');
    await b.sync.start('ref1');
    a.sync.set(K, 'done');
    await until(() => !a.sync.pendingCount());
    b.sync.set(K, 'done');
    await until(() => !b.sync.pendingCount());
    assert.deepEqual(b.notices, []);
    assert.equal(s.rows.get(K).rev, 1);
  });

  it('a device that was offline with a queued change gets a conflict, not an overwrite, when it reconnects', async () => {
    const s = fakeServer();
    const a = device(s, { name: 'a' });
    const b = device(s, { name: 'b' });
    await a.sync.start('ref1');
    await b.sync.start('ref1');
    s.down = true;
    b.sync.set(K, 'revisit');
    await until(() => b.notices.some((n) => n.kind === 'offline'));
    s.down = false;
    a.sync.set(K, 'done');
    await until(() => !a.sync.pendingCount());
    await b.runTimers();
    await until(() => !b.sync.pendingCount());
    assert.equal(s.rows.get(K).value, 'done');
    assert.equal(b.sync.get(K).value, 'done');
    assert.ok(b.notices.some((n) => n.kind === 'conflict'));
  });

  it('a stale non-zero revision cannot recreate a pruned row: the server says conflict and the device adopts "not started"', async () => {
    const s = fakeServer();
    const d = device(s);
    await d.sync.start('ref1');
    d.sync.set(K, 'done');
    await until(() => !d.sync.pendingCount());
    s.rows.delete(K); // the row was pruned on the server
    d.sync.set(K, 'revisit');
    await until(() => !d.sync.pendingCount());
    assert.equal(s.rows.has(K), false, 'nothing was recreated');
    assert.equal(d.sync.get(K).value, 'none');
    assert.ok(d.notices.some((n) => n.kind === 'conflict'));
    d.sync.set(K, 'revisit'); // the next click starts again from revision 0
    await until(() => !d.sync.pendingCount());
    assert.equal(s.rows.get(K).value, 'revisit');
  });

  it('company tracking follows the same rules', async () => {
    const s = fakeServer();
    const a = device(s, { name: 'a' });
    const b = device(s, { name: 'b' });
    const C = keys.company('acme');
    await a.sync.start('ref1');
    await b.sync.start('ref1');
    a.sync.set(C, true);
    await until(() => !a.sync.pendingCount());
    a.sync.set(C, false);
    await until(() => !a.sync.pendingCount());
    b.sync.set(C, true); // b never saw either change
    await until(() => !b.sync.pendingCount());
    assert.equal(s.rows.get(C).value, false);
    assert.equal(s.rows.get(C).rev, 2);
    assert.equal(b.sync.get(C).value, false);
    assert.ok(b.notices.some((n) => n.kind === 'conflict'));
  });
});

describe('failures and retries', () => {
  it('a lost reply is retried with the same opId and applies once', async () => {
    const s = fakeServer();
    const d = device(s);
    await d.sync.start('ref1');
    s.lostReplies = 1;
    d.sync.set(K, 'done');
    await until(() => d.notices.some((n) => n.kind === 'offline'));
    await d.runTimers();
    await until(() => !d.sync.pendingCount());
    const puts = s.calls.filter((c) => c.init.method === 'PUT').map((c) => JSON.parse(c.init.body));
    assert.equal(puts.length, 2);
    assert.equal(puts[0].opId, puts[1].opId);
    assert.equal(s.rows.get(K).rev, 1, 'applied once');
    assert.equal(d.sync.get(K).value, 'done');
    assert.deepEqual(d.notices.filter((n) => n.kind === 'conflict'), []);
  });

  it('offline: the change shows at once, waits, and is sent when the network returns, with one notice', async () => {
    const s = fakeServer();
    const d = device(s);
    await d.sync.start('ref1');
    s.down = true;
    d.sync.set(K, 'done');
    d.sync.set(keys.progress('ai', 8), 'revisit');
    await until(() => d.notices.length >= 1);
    assert.deepEqual(d.sync.get(K), { value: 'done', pending: true });
    assert.equal(d.sync.pendingCount(), 2);
    s.down = false;
    d.sync.flush();
    await until(() => !d.sync.pendingCount());
    assert.equal(s.rows.size, 2);
    assert.equal(d.notices.filter((n) => n.kind === 'offline').length, 1);
  });

  it('a busy (429) or failing (503) service keeps the change queued and retries later', async () => {
    for (const status of [429, 503]) {
      const s = fakeServer();
      const d = device(s);
      await d.sync.start('ref1');
      s.status = status;
      d.sync.set(K, 'done');
      await until(() => d.timers.length > 0);
      assert.equal(d.sync.pendingCount(), 1);
      s.status = null;
      await d.runTimers();
      await until(() => !d.sync.pendingCount());
      assert.equal(s.rows.get(K).value, 'done');
    }
  });

  it('an expired session (401) stops sending, keeps the change for the same account, and reports it once', async () => {
    const s = fakeServer();
    const d = device(s);
    await d.sync.start('ref1');
    s.signedIn = false;
    d.sync.set(K, 'done');
    await until(() => d.notices.some((n) => n.kind === 'authLost'));
    const sent = s.calls.length;
    d.sync.set(keys.progress('ai', 9), 'done'); // refused: not usable while signed out
    assert.equal(d.sync.isReady(), false);
    d.sync.flush();
    await tick();
    assert.equal(s.calls.length, sent);
    assert.equal(d.notices.filter((n) => n.kind === 'authLost').length, 1);
  });

  it('a request the server refuses outright (400, 403, 404) is dropped with a notice, not retried forever', async () => {
    for (const status of [400, 403, 404]) {
      const s = fakeServer();
      const d = device(s);
      await d.sync.start('ref1');
      s.status = status;
      d.sync.set(K, 'done');
      await until(() => d.notices.some((n) => n.kind === 'rejected'));
      assert.equal(d.sync.pendingCount(), 0);
      assert.equal(d.sync.get(K).value, 'none');
      assert.equal(d.timers.length, 0);
    }
  });

  it('a failed first load leaves the page usable, and the retry fetches the state again until it succeeds', async () => {
    const s = fakeServer();
    s.rows.set(K, { value: 'done', rev: 1, lastOp: 'seed-op-xxxx' });
    s.down = true;
    const d = device(s);
    await d.sync.start('ref1');
    assert.equal(d.sync.isReady(), false);
    assert.equal(d.timers.length, 1);
    await d.runTimers(); // still down: fails again and schedules another retry
    assert.equal(d.sync.isReady(), false);
    assert.equal(d.timers.length, 1);
    s.down = false;
    await d.runTimers();
    await until(() => d.sync.isReady(), 'the retry to load the state');
    assert.equal(d.sync.get(K).value, 'done');
  });

  it('a slow refresh never overwrites a change that finished while it was in flight', async () => {
    const s = fakeServer();
    const storage = storageFor();
    const first = device(s, { storage });
    await first.sync.start('ref1');
    first.sync.set(K, 'done'); // saved copy now says done at revision 1
    await until(() => !first.sync.pendingCount());
    // New page load: the saved copy shows at once, the refresh is slow and will carry the server state as of now (done, rev 1).
    let release;
    const gate = new Promise((r) => { release = r; });
    const slow = { ...s, fetch: async (url, init) => { const reply = await s.fetch(url, init); if ((init?.method ?? 'GET') === 'GET') await gate; return reply; } }; // the GET is answered now but delivered late
    const later = device(slow, { storage });
    const started = later.sync.start('ref1');
    await tick();
    later.sync.set(K, 'revisit'); // PUT is not gated: applies at revision 2 while the refresh is still waiting
    await until(() => s.rows.get(K).rev === 2, 'the write to apply');
    await tick();
    release();
    await started;
    assert.equal(later.sync.get(K).value, 'revisit', 'the newer local value survives the older snapshot');
    later.sync.set(K, 'done');
    await until(() => !later.sync.pendingCount());
    assert.equal(s.rows.get(K).rev, 3, 'the next change is based on revision 2, so it applies without a conflict');
    assert.deepEqual(later.notices.filter((n) => n.kind === 'conflict'), []);
  });
});

describe('browser storage is only an optimisation, and is private to the account', () => {
  it('shows the saved copy immediately, then replaces it with the server\'s', async () => {
    const s = fakeServer();
    const storage = storageFor();
    const a = device(s, { storage });
    await a.sync.start('ref1');
    a.sync.set(K, 'done');
    await until(() => !a.sync.pendingCount());

    s.rows.set(K, { value: 'revisit', rev: 2, lastOp: 'other-op-xx' }); // changed elsewhere meanwhile
    const slow = new Promise(() => {});
    const later = device({ ...s, fetch: () => slow }, { storage });
    later.sync.start('ref1');
    await tick();
    assert.equal(later.sync.isReady(), true, 'ready from the saved copy before the network answers');
    assert.equal(later.sync.get(K).value, 'done');

    const fresh = device(s, { storage });
    await fresh.sync.start('ref1');
    assert.equal(fresh.sync.get(K).value, 'revisit');
  });

  it('survives a reload with a queued change and sends it with the same opId', async () => {
    const s = fakeServer();
    const storage = storageFor();
    const first = device(s, { storage });
    await first.sync.start('ref1');
    s.down = true;
    first.sync.set(K, 'done');
    await until(() => first.notices.length > 0);
    const opId = JSON.parse(s.calls.at(-1).init.body).opId;
    s.down = false;
    const reloaded = device(s, { storage });
    await reloaded.sync.start('ref1');
    await until(() => !reloaded.sync.pendingCount());
    assert.equal(s.rows.get(K).value, 'done');
    assert.equal(s.rows.get(K).lastOp, opId);
  });

  it('another account never sees the first account\'s saved copy or queued changes', async () => {
    const s = fakeServer();
    const storage = storageFor();
    const d = device(s, { storage });
    await d.sync.start('refA');
    s.down = true;
    d.sync.set(K, 'done');
    await until(() => d.notices.length > 0);
    s.down = false;
    s.rows.clear();
    await d.sync.start('refB'); // someone else signs in on the same browser
    assert.equal(d.sync.get(K).value, 'none');
    assert.equal(d.sync.pendingCount(), 0);
    await tick();
    assert.equal(s.rows.size, 0, 'account A\'s queued change was not sent as account B');
  });

  it('signing out or deleting the account erases every saved copy', async () => {
    const s = fakeServer();
    const storage = storageFor();
    storage.setItem('theme', 'dark');
    const d = device(s, { storage });
    await d.sync.start('refA');
    d.sync.set(K, 'done');
    await until(() => !d.sync.pendingCount());
    assert.ok(Object.keys(storage).some((k) => k.startsWith('isx-u:')));
    d.sync.clearAll();
    assert.deepEqual(Object.keys(storage), ['theme']);
    assert.equal(d.sync.isReady(), false);
    assert.equal(d.sync.get(K).value, 'none');
  });

  it('ignores a corrupt or unknown saved copy', async () => {
    const s = fakeServer();
    for (const junk of ['not json', '{"v":2}', '{"v":1,"items":5}', 'null']) {
      const storage = storageFor();
      storage.setItem('isx-u:ref1', junk);
      const d = device(s, { storage });
      await d.sync.start('ref1');
      assert.equal(d.sync.isReady(), true);
    }
  });

  it('works with no storage at all', async () => {
    const s = fakeServer();
    const d = device(s, { storage: null });
    await d.sync.start('ref1');
    d.sync.set(K, 'done');
    await until(() => !d.sync.pendingCount());
    assert.equal(s.rows.get(K).value, 'done');
  });
});

describe('several tabs', () => {
  it('a newer change from another tab is taken; an older one or one for another account is ignored', async () => {
    const s = fakeServer();
    const d = device(s);
    await d.sync.start('ref1');
    d.sync.receive({ ref: 'ref1', type: 'item', key: K, value: 'done', rev: 3 });
    assert.equal(d.sync.get(K).value, 'done');
    d.sync.receive({ ref: 'ref1', type: 'item', key: K, value: 'revisit', rev: 2 });
    assert.equal(d.sync.get(K).value, 'done');
    d.sync.receive({ ref: 'other', type: 'item', key: K, value: 'revisit', rev: 9 });
    assert.equal(d.sync.get(K).value, 'done');
  });

  it('sign-out in one tab clears the others without looping', async () => {
    const s = fakeServer();
    const sent = [];
    const d = device(s, { channel: { postMessage: (m) => sent.push(m) } });
    await d.sync.start('ref1');
    d.sync.receive({ ref: null, type: 'cleared' });
    assert.equal(d.sync.isReady(), false);
    assert.deepEqual(sent.filter((m) => m.type === 'cleared'), [], 'a received clear is not broadcast again');
    await d.sync.start('ref1');
    d.sync.clearAll();
    assert.equal(sent.filter((m) => m.type === 'cleared').length, 1);
  });

  it('broadcasts each applied change', async () => {
    const s = fakeServer();
    const sent = [];
    const d = device(s, { channel: { postMessage: (m) => sent.push(m) } });
    await d.sync.start('ref1');
    d.sync.set(K, 'done');
    await until(() => !d.sync.pendingCount());
    assert.deepEqual(sent.map((m) => [m.type, m.key, m.value, m.rev, m.ref]), [['item', K, 'done', 1, 'ref1']]);
  });
});
