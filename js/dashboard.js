import { $, el, initTheme, showStatus } from './common.js?v=15';
import { announce, authState, googleButton, loadStyles, privateFetch, signInUrl, sync, whenAuth } from './account.js?v=15';

const root = $('dashboard');
const TOTALS = [
  ['company_dsa', 'Company coding problems'],
  ['ai', 'AI questions'],
  ['system_design', 'System design questions'],
];
const PHRASE = 'delete my account';

function totalCard([key, label], t) {
  const card = el('div', 'total');
  card.append(el('span', 'muted small', label));
  const big = el('strong', null, `${t.done}`);
  big.append(el('span', 'muted small', ` of ${t.total} done`));
  const meter = el('progress', 'meter');
  meter.max = Math.max(t.total, 1);
  meter.value = t.done;
  meter.setAttribute('aria-label', `${label}: ${t.done} of ${t.total} done`);
  card.append(big, meter, el('span', 'muted small', `${t.revisit} to revisit`));
  return card;
}

// partial: the account has more marks than the breakdown covers, so the table counts the most recent ones (the totals above count every mark).
function companiesCard(companies, partial, breakdownMarks) {
  const card = el('section', 'card');
  card.append(el('h2', null, 'Companies you follow'));
  if (partial) card.append(el('p', 'muted', `Company counts below use your ${Number(breakdownMarks) || 500} most recent marks. The totals above count all of them.`));
  if (!companies.length) {
    card.append(el('p', 'muted', 'No companies yet. Open a company and choose “Track company”, or mark a question and its companies appear here.'));
    return card;
  }
  const wrap = el('div', 'table-wrap');
  const table = el('table');
  const head = el('tr');
  for (const name of ['Company', 'Coding', 'System design', 'AI']) head.append(el('th', null, name));
  const body = el('tbody');
  table.append(el('thead'), body);
  table.tHead.append(head);
  for (const c of companies) {
    const tr = el('tr');
    const name = el('td');
    const a = el('a', null, c.name);
    a.href = `/c/${encodeURIComponent(c.slug)}`;
    name.append(a);
    if (c.tracked) name.append(' ', el('span', 'badge', 'Tracked'));
    tr.append(name);
    for (const part of [c.dsa, c.hld, c.ai]) tr.append(el('td', 'mono', `${part.done} / ${part.total}`));
    body.append(tr);
  }
  wrap.append(table);
  card.append(wrap);
  return card;
}

// ---- account deletion (shown only when the server says it is available) --------------------------------------------
function deletionCard(user) {
  const card = el('section', 'card');
  card.append(el('h2', null, 'Delete your account'));
  if (!user.canDelete) {
    card.append(el('p', 'muted', `Self-service deletion is not available yet. To delete your account, ask the site owner and quote your support reference: ${user.ref}.`));
    const privacy = el('a', null, 'What deletion removes');
    privacy.href = '/privacy#p-delete';
    card.append(privacy);
    return card;
  }
  card.append(el('p', 'muted', 'This permanently removes your account, your marks and your tracked companies. It cannot be undone. For your safety we first ask Google to confirm it is you.'));
  const area = el('div', 'stack');
  card.append(area);
  const fresh = new URLSearchParams(location.search).get('reauth') === '1';
  if (fresh) confirmStep(area); else startStep(area);
  return card;
}

function startStep(area) {
  const go = el('button', 'btn danger', 'Delete my account…');
  go.type = 'button';
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const response = await privateFetch('/auth/reauth', { method: 'POST', body: JSON.stringify({ next: '/dashboard?reauth=1' }) });
      const body = await response.json().catch(() => null);
      if (response.ok && typeof body?.redirect === 'string' && body.redirect.startsWith('https://accounts.google.com/')) { location.assign(body.redirect); return; }
    } catch {
      // fall through to the message
    }
    go.disabled = false;
    message(area, 'We could not start the confirmation. Please try again.');
  });
  area.replaceChildren(go);
}

function message(area, text) {
  area.querySelector('.note')?.remove();
  const note = el('p', 'note', text);
  note.setAttribute('role', 'alert');
  area.append(note);
}

function confirmStep(area) {
  const label = el('label', 'field', `Type “${PHRASE}” to confirm`);
  const input = el('input', 'field-input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  label.append(input);
  const button = el('button', 'btn danger', 'Permanently delete my account');
  button.type = 'button';
  button.disabled = true;
  input.addEventListener('input', () => { button.disabled = input.value.trim().toLowerCase() !== PHRASE; });
  button.addEventListener('click', async () => {
    button.disabled = true;
    let response;
    try {
      response = await privateFetch('/me', { method: 'DELETE', body: JSON.stringify({ confirm: input.value.trim() }) });
    } catch {
      button.disabled = false;
      message(area, 'We could not reach the service. Nothing was deleted. Please try again.');
      return;
    }
    const body = await response.json().catch(() => null);
    if (response.ok || response.status === 202) {
      announce({ type: 'signout' });
      sync.clearAll();
      root.replaceChildren(el('h1', null, 'Your account has been deleted'));
      const text = response.status === 202
        ? 'Deletion is being completed and will finish shortly. You are signed out and nothing on this device is kept.'
        : 'Your account, marks and tracked companies are gone and this device has forgotten them. Deleted data can persist in backups until they expire, as described in the privacy page.';
      root.append(el('p', 'muted', text));
      const home = el('a', 'btn', 'Back to the site');
      home.href = '/';
      root.append(home);
      return;
    }
    button.disabled = false;
    const code = body?.error?.code;
    if (code === 'reauth_required') { startStep(area); history.replaceState(null, '', '/dashboard'); message(area, 'Please confirm with Google again, then repeat this step.'); }
    else if (code === 'unauthenticated' || response.status === 401) message(area, 'Your session has ended. Sign in again to continue.');
    else if (code === 'deletion_unavailable') message(area, 'Self-service deletion is not available. Ask the site owner to delete your account.');
    else message(area, 'Deletion could not finish. Nothing more was removed; please try again or contact the site owner.');
  });
  area.replaceChildren(label, button);
  input.focus();
}

// ---- page ----------------------------------------------------------------------------------------------------------
async function render() {
  const state = await whenAuth();
  await loadStyles();
  root.replaceChildren(el('h1', null, 'My preparation'));
  if (state.state === 'off') { showStatus(root, 'Not available.'); return; }
  if (state.state === 'out') {
    const card = el('div', 'card');
    card.append(el('p', 'muted', 'Sign in to see your progress and the companies you follow.'));
    const go = googleButton(signInUrl('/dashboard'));
    card.append(go);
    root.append(card);
    return;
  }
  const holder = el('div', 'wrap');
  root.append(holder);
  showStatus(holder, 'Loading…');
  let data;
  try {
    const response = await privateFetch('/me/dashboard');
    if (response.status === 401) { showStatus(holder, 'Your session has ended. Sign in again to see your progress.'); return; }
    if (!response.ok) throw new Error(String(response.status));
    data = (await response.json()).data;
  } catch {
    showStatus(holder, 'Your dashboard is temporarily unavailable. Your progress is safe. Please try again in a few minutes.', render);
    return;
  }
  const totals = el('section', 'totals');
  totals.setAttribute('aria-label', 'Totals');
  for (const entry of TOTALS) totals.append(totalCard(entry, data.totals[entry[0]]));
  holder.replaceChildren(totals, companiesCard(data.companies, data.partial === true, data.breakdownMarks), deletionCard(authState().user));
}

initTheme();
render();
