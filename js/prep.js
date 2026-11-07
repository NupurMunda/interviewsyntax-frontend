import { $, api, el, errorMessage, formatDay, initTheme, isRecent, link, markNav, plural, showStatus, track } from './common.js?v=14';

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
const state = { topic: '', page: 0, loaded: 0 };

function topicField(topics, onChange) {
  const wrapper = el('label', 'field', 'Topic');
  const select = el('select', 'select');
  const all = el('option', null, 'All topics');
  all.value = '';
  select.append(all);
  for (const t of topics) {
    const coverage = t.answered ? `${t.answered} of ${t.total} published` : 'none published yet';
    const option = el('option', null, `${t.name} (${coverage})`);
    option.value = t.name;
    select.append(option);
  }
  select.addEventListener('change', () => onChange(select.value));
  wrapper.append(select);
  return wrapper;
}

function titleRow(item, titleNode) {
  const row = el('div', 'qhead');
  row.append(titleNode);
  if (item.written && isRecent(item.written)) row.append(el('span', 'badge', 'New'));
  return row;
}

function linkedQuestion(item) {
  const li = el('li');
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
  return li;
}

async function load() {
  const section = SECTIONS[kind];
  if (!section) {
    showStatus(root, 'Not found.');
    return;
  }
  document.title = `${section.title} · InterviewSyntax`;
  showStatus(root, 'Loading…');
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
    else if (state.topic) progress.textContent = `${meta.total} published ${meta.total === 1 ? 'answer' : 'answers'} in this topic`;
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
    if (!state.loaded) showStatus(status, 'No published answers for this topic yet. More are being added.');
  };
  const fetchPage = async (reset) => {
    more.disabled = true;
    try {
      const page = reset ? 1 : state.page + 1;
      const result = await api(`prep/${kind}`, { topic: state.topic, page, limit: PAGE_SIZE });
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
    controls.append(topicField(first.meta.topics, (topic) => { state.topic = topic; fetchPage(true); }));
  }
  parts.push(controls);
  const card = el('section', 'card');
  card.append(progress, list, status, more);
  root.replaceChildren(...parts, card);
  Object.assign(state, { topic: '', page: 1 });
  render(first, true);
}

initTheme();
markNav(`/prep/${kind}`);
track({ kind: 'view', page: 'prep' });
load();
