import { $, api, el, errorMessage, initTheme, link, markNav, richText, showStatus, track } from './common.js?v=14';

const id = location.pathname.split('/')[2] ?? '';
const root = $('question');
const SECTION_FOR = { ai: ['/prep/ai', 'AI prep'], hld: ['/prep/system-design', 'System design prep'] };

function bulletList(items) {
  const ul = el('ul', 'steps');
  for (const item of items) ul.append(richText(el('li'), item));
  return ul;
}

function sectionCard(section) {
  const card = el('section', 'card prose');
  card.append(el('h2', null, section.heading));
  for (const paragraph of section.paragraphs) card.append(richText(el('p'), paragraph));
  if (section.points.length) card.append(bulletList(section.points));
  return card;
}

function listCard(heading, items) {
  const card = el('section', 'card prose');
  card.append(el('h2', null, heading), bulletList(items));
  return card;
}

function sourcesCard(answer) {
  const card = el('section', 'card prose');
  card.append(el('h2', null, 'Sources'));
  const chips = el('div', 'chips');
  for (const source of answer.sources) chips.append(link(source.url, source.title, 'chip'));
  card.append(chips);
  card.append(el('p', 'note', `Written on ${answer.written} in our own words from the sources above. Check them before relying on a specific figure.`));
  return card;
}

// Approved solution links for the question (your own list), shown whether or not it has a written answer.
function solutionsCard(solutions) {
  const card = el('section', 'card');
  card.append(el('h2', null, 'More solutions'));
  const chips = el('div', 'chips');
  for (const s of solutions) chips.append(link(s.url, s.title, 'chip'));
  card.append(chips);
  return card;
}

function render(data) {
  document.title = `${data.title} · InterviewSyntax`;
  const [href, label] = SECTION_FOR[data.category] ?? ['/', 'All companies'];
  markNav(href);
  const back = el('a', 'back', `← ${label}`);
  back.href = href;
  const parts = [back, el('h1', null, data.title)];
  if (data.topics.length) {
    const chips = el('div', 'chips');
    for (const t of data.topics) chips.append(el('span', 'chip', t));
    parts.push(chips);
  }
  if (!data.answer) {
    const note = el('div', 'card');
    note.append(el('p', 'muted', 'No written answer for this question yet.'));
    if (data.url) {
      const row = el('div', 'chips');
      row.append(link(data.url, 'Original question', 'chip'));
      note.append(row);
    }
    if (data.solutions.length) parts.push(note, solutionsCard(data.solutions));
    else parts.push(note);
    root.replaceChildren(...parts);
    return;
  }
  const { answer } = data;
  const short = el('section', 'card prose');
  short.append(el('h2', null, 'Short answer'), richText(el('p', 'lead-answer'), answer.short));
  parts.push(short, ...answer.sections.map(sectionCard));
  if (answer.mistakes.length) parts.push(listCard('Common mistakes', answer.mistakes));
  if (answer.follow_ups.length) parts.push(listCard('Likely follow-up questions', answer.follow_ups));
  parts.push(sourcesCard(answer));
  if (data.solutions.length) parts.push(solutionsCard(data.solutions));
  if (data.companies.length) {
    const asked = el('section', 'card');
    asked.append(el('h2', null, 'Reported at'));
    const chips = el('div', 'chips');
    for (const c of data.companies) {
      const anchor = el('a', 'chip', c.name);
      anchor.href = `/c/${encodeURIComponent(c.slug)}`;
      chips.append(anchor);
    }
    asked.append(chips);
    parts.push(asked);
  }
  root.replaceChildren(...parts);
}

async function load() {
  showStatus(root, 'Loading…');
  try {
    const { data } = await api(`resources/${id}`);
    track({ kind: 'view', page: 'question', category: data.category });
    render(data);
  } catch (error) {
    const message = el('div');
    showStatus(message, errorMessage(error), error.status === 404 ? undefined : load);
    root.replaceChildren(message);
  }
}

initTheme();
if (/^[0-9]+$/.test(id)) {
  load();
} else {
  showStatus(root, 'Not found.');
}
