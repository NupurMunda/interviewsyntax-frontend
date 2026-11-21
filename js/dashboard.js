import { $, el, initTheme, link, showLoading, showStatus } from './common.js?v=15';
import { announce, authState, googleButton, loadStyles, privateFetch, signInUrl, sync, whenAuth } from './account.js?v=15';

const root = $('dashboard');
const TOTALS = [
  ['company_dsa', 'Company coding problems'],
  ['ai', 'AI questions'],
  ['system_design', 'System design questions'],
];
// The four summary boxes are the switch: each shows its own list below. Companies is the default.
const HEADINGS = {
  companies: 'Companies you follow',
  company_dsa: 'Coding problems you marked',
  ai: 'AI questions you marked',
  system_design: 'System design questions you marked',
};
const EMPTY = {
  company_dsa: 'You have not marked any coding problems yet. Mark one Done or Revisit on a company page and it appears here.',
  ai: 'You have not marked any AI questions yet. Mark one Done or Revisit on the AI prep page and it appears here.',
  system_design: 'You have not marked any system design questions yet. Mark one Done or Revisit on the system design page and it appears here.',
};
const PHRASE = 'delete my account';

function companiesTotal(count) {
  const card = el('button', 'total');
  card.type = 'button';
  card.append(el('span', 'muted small', 'Companies you follow'));
  card.append(el('strong', null, String(count)));
  card.append(el('span', 'muted small', count === 1 ? 'tracked company' : 'tracked companies'));
  return card;
}

function totalCard([key, label], t) {
  const card = el('button', 'total');
  card.type = 'button';
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

// ---- the person's marked questions of one kind (Done and Revisit), 25 a page, newest first ---------------------------------
function markRow(item) {
  const li = el('li');
  const head = el('div', 'qhead');
  let title;
  if (item.page) { title = el('a', 'qlink', item.title); title.href = item.page; }
  else if (item.url) title = link(item.url, item.title, 'qlink');
  else title = el('span', 'qlink', item.title);
  head.append(title, el('span', item.status === 'done' ? 'badge' : 'chip', item.status === 'done' ? 'Done' : 'Revisit'));
  li.append(head);
  return li;
}

function marksPanel(host, type) {
  const filter = el('select', 'select');
  for (const [value, text] of [['all', 'Done and Revisit'], ['done', 'Done'], ['revisit', 'Revisit']]) {
    const option = el('option', null, text);
    option.value = value;
    filter.append(option);
  }
  const field = el('label', 'field', 'Show');
  field.append(filter);
  const controls = el('div', 'controls');
  controls.append(field);
  const list = el('ul', 'qs');
  const status = el('div');
  const more = el('button', 'btn', 'Load more');
  more.type = 'button';
  more.hidden = true;
  host.replaceChildren(controls, list, status, more);
  let page = 0;
  let run = 0;

  async function next() {
    const mine = run;
    more.disabled = true;
    if (page === 0) showLoading(status, 'Loading…'); else showStatus(status, 'Loading…');
    try {
      const response = await privateFetch(`/me/marks?type=${type}&status=${filter.value}&page=${page + 1}`);
      if (mine !== run) return;
      if (response.status === 401) { showStatus(status, 'Your session has ended. Sign in again to see your questions.'); more.hidden = true; return; }
      if (!response.ok) throw new Error(String(response.status));
      const { items, hasMore } = (await response.json()).data;
      if (mine !== run) return;
      page += 1;
      status.replaceChildren();
      for (const item of items) list.append(markRow(item));
      if (!list.children.length) showStatus(status, filter.value === 'all' ? EMPTY[type] : 'Nothing here with that status yet.');
      more.hidden = !hasMore;
    } catch {
      if (mine !== run) return;
      showStatus(status, 'This list is temporarily unavailable. Your progress is safe.', next);
      more.hidden = true;
    } finally {
      if (mine === run) more.disabled = false;
    }
  }

  function restart() { run += 1; page = 0; list.replaceChildren(); more.hidden = true; next(); }
  filter.addEventListener('change', restart);
  more.addEventListener('click', next);
  restart();
}

// The lower part of the page: the list for whichever summary box is selected (pressed).
function viewCard(data, cards) {
  const card = el('section', 'card');
  const heading = el('h2');
  const panel = el('div', 'wrap');
  card.append(heading, panel);
  let current = null;
  const show = (key) => {
    if (key === current) return;
    current = key;
    history.replaceState(null, '', '#' + key);
    for (const [name, button] of cards) {
      const on = name === key;
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', String(on));
    }
    heading.textContent = HEADINGS[key];
    if (key === 'companies') panel.replaceChildren(companiesCard(data.companies, data.partial === true, data.breakdownMarks));
    else marksPanel(panel, key);
  };
  for (const [key, button] of cards) button.addEventListener('click', () => show(key));
  const wanted = location.hash.slice(1);
  show(cards.has(wanted) ? wanted : 'companies');
  return card;
}

// partial: the account has more marks than the breakdown covers, so the table counts the most recent ones (the totals above count every mark).
function companiesCard(companies, partial, breakdownMarks) {
  const card = el('div');
  if (partial) card.append(el('p', 'muted', `Company counts below use your ${Number(breakdownMarks) || 500} most recent marks. The totals above count all of them.`));
  if (!companies.length) {
    card.append(el('p', 'muted', 'You are not tracking any companies yet. Open a company and choose “Track company” to follow it here.'));
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
  showLoading(holder, 'Loading…');
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
  const cards = new Map([['companies', companiesTotal(data.companies.length)]]);
  for (const entry of TOTALS) cards.set(entry[0], totalCard(entry, data.totals[entry[0]]));
  totals.append(...cards.values());
  holder.replaceChildren(totals, viewCard(data, cards), deletionCard(authState().user));
}

initTheme();
render();
