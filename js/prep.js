import { $, api, el, errorMessage, formatDay, initTheme, isRecent, link, markNav, plural, showLoading, showStatus, track } from './common.js?v=15';
import { attachCompany, attachProgress } from './account.js?v=15';

const PAGE_SIZE = 50;
const SECTIONS = {
  ai: {
    title: 'AI engineering interview prep',
    blurb: 'Questions asked in AI engineering interviews. Only questions with a published answer are listed here, each with a full written answer and its sources. More are added regularly.',
  },
  'system-design': {
    title: 'System design interview prep',
    blurb: 'System design questions with the solutions we collected for each: articles, videos, papers and discussions.',
  },
};
const kind = location.pathname.split('/')[2] ?? '';
const root = $('prep');
const state = { topic: '', company: '', page: 0, loaded: 0 };

function selectField(label, allLabel, choices, onChange) {
  const wrapper = el('label', 'field', label);
  const select = el('select', 'select');
  const all = el('option', null, allLabel);
  all.value = '';
  select.append(all);
  for (const choice of choices) {
    const option = el('option', null, choice.text);
    option.value = choice.value;
    select.append(option);
  }
  select.addEventListener('change', () => onChange(select.value));
  wrapper.append(select);
  return wrapper;
}

const topicChoices = (topics) => topics.map((t) => ({
  value: t.name,
  text: `${t.name} (${t.answered ? `${t.answered} of ${t.total} published` : 'none published yet'})`,
}));
const companyChoices = (companies) => companies.map((c) => ({ value: c.slug, text: `${c.name} (${c.total})` }));

function titleRow(item, titleNode) {
  const row = el('div', 'qhead');
  row.append(titleNode);
  if (item.written && isRecent(item.written)) row.append(el('span', 'badge', 'New'));
  return row;
}

function linkedQuestion(item) {
  const li = el('li');
  attachProgress(li, { type: 'system_design', id: item.id, title: item.title }, (node) => li.append(node));
  li.append(titleRow(item, el('span', 'qtitle', item.title)));
  if (item.summary) li.append(el('p', 'muted qsum', item.summary));
  if (item.concepts.length) {
    const chips = el('div', 'chips');
    for (const c of item.concepts) chips.append(el('span', 'chip', c));
    li.append(chips);
  }
  if (!item.links.length) {
    li.append(el('span', 'muted', 'No solution links collected yet.'));
    return li;
  }
  const links = el('ul', 'links');
  for (const l of item.links) {
    const row = el('li');
    row.append(link(l.url, l.label));
    links.append(row);
  }
  li.append(links);
  return li;
}

function questionItem(item) {
  if (kind === 'system-design') return linkedQuestion(item);
  const li = el('li');
  const anchor = el('a', 'qlink', item.title);
  anchor.href = `/q/${item.id}`;
  li.append(titleRow(item, anchor));
  const meta = el('div', 'chips');
  for (const t of item.topics) meta.append(el('span', 'chip', t));
  if (item.written) meta.append(el('span', 'muted small', `Added ${formatDay(item.written)}`));
  if (meta.children.length) li.append(meta);
  attachProgress(li, { type: 'ai', id: item.id, title: item.title }, (node) => li.append(node));
  return li;
}

async function load() {
  const section = SECTIONS[kind];
  if (!section) {
    showStatus(root, 'Not found.');
    return;
  }
  document.title = `${section.title} · InterviewSyntax`;
  showLoading(root, 'Loading…');
  let first;
  try {
    first = await api(`prep/${kind}`, { limit: PAGE_SIZE });
  } catch (error) {
    showStatus(root, errorMessage(error), load);
    return;
  }
  const progress = el('p', 'muted mono');
  const list = el('ul', kind === 'system-design' ? 'qs numbered' : 'qs');
  const status = el('div');
  const more = el('button', 'btn', 'Load more');
  more.type = 'button';
  more.hidden = true;

  const showProgress = (meta) => {
    if (kind === 'system-design') progress.textContent = plural(meta.questions, 'question');
    else if (state.topic || state.company) progress.textContent = `${meta.total} published ${meta.total === 1 ? 'answer' : 'answers'} for this selection`;
    else progress.textContent = `${meta.total} of ${plural(meta.questions, 'question')} have published answers.`;
  };
  const render = (result, reset) => {
    if (reset) {
      list.replaceChildren();
      state.loaded = 0;
    }
    for (const item of result.data) list.append(questionItem(item));
    state.loaded += result.data.length;
    showProgress(result.meta);
    more.hidden = state.loaded >= result.meta.total;
    status.replaceChildren();
    if (!state.loaded) showStatus(status, 'No published answers for this selection yet. More are being added.');
  };
  const fetchPage = async (reset) => {
    more.disabled = true;
    try {
      const page = reset ? 1 : state.page + 1;
      const result = await api(`prep/${kind}`, { topic: state.topic, company: state.company, page, limit: PAGE_SIZE });
      state.page = page;
      render(result, reset);
    } catch (error) {
      showStatus(status, errorMessage(error), () => fetchPage(reset));
    } finally {
      more.disabled = false;
    }
  };
  more.addEventListener('click', () => fetchPage(false));
  const parts = [el('h1', null, section.title), el('p', 'muted lead', section.blurb)];
  const controls = el('div', 'controls');
  if (first.meta.topics.length) {
    controls.append(selectField('Topic', 'All topics', topicChoices(first.meta.topics), (topic) => { state.topic = topic; fetchPage(true); }));
  }
  if (first.meta.companies?.length) {
    controls.append(selectField('Company', 'All companies', companyChoices(first.meta.companies), (company) => { state.company = company; fetchPage(true); }));
  }
  parts.push(controls);
  const card = el('section', 'card');
  card.append(progress, list, status, more);
  root.replaceChildren(...parts, card);
  Object.assign(state, { topic: '', company: '', page: 1 });
  render(first, true);
}

initTheme();
markNav(`/prep/${kind}`);
track({ kind: 'view', page: 'prep' });
load();
