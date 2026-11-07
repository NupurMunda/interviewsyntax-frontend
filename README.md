# InterviewSyntax

Interview intelligence, made simple.

This is the `interviewsyntax-frontend` repo.

How the whole system works (data flow, caching, error handling, load control, monitoring): see [ARCHITECTURE.md](ARCHITECTURE.md).

Plain HTML, CSS and JavaScript front end for [interviewsyntax-backend](https://github.com/NupurMunda/interviewsyntax-backend). No framework, no build step, no runtime dependencies. Deploys to Netlify.

| Page | Route | Data |
|---|---|---|
| Home: company web, search, list | `/` | `/api/v1/graph?limit=60`, `/api/v1/companies` |
| Company | `/c/<slug>` | `/api/v1/companies/<slug>` and its `dsa`, `hld`, `ai`, `behavioral` lists |
| AI prep | `/prep/ai` | `/api/v1/prep/ai`: only questions with a published answer, newest first |
| System design prep | `/prep/system-design` | `/api/v1/prep/system-design`: every question with a description, key concepts and solution links |
| Question and written answer | `/q/<id>` | `/api/v1/resources/<id>` |
| Sources and licenses | `/sources` | `/api/v1/sources` |

The browser only calls same-origin `/api/*`. `netlify/functions/api.mjs` forwards allow-listed GET requests to the backend and adds the API key, so the key never reaches the browser.

## Design

- **Header:** a sticky, full-width bar in a slightly different tone from the page, with the InterviewSyntax logo (the light logo in light mode, the dark one in dark mode, switched by CSS from the theme) and a nav: **All companies**, **AI prep**, **System design prep**. The nav link for the section you are in is highlighted with `aria-current="page"`. Company pages keep "← All companies" and question pages "← AI prep" or "← System design prep", so you go back to where you came from.
- **Browser tab icon:** `img/app-icon.png`, also used as the Apple touch icon.
- **AI prep** is honest about coverage: it says "13 of 598 questions have published answers." and lists only those. Topics show how many are published ("13 of 50 published", or "none published yet"). Answers from the last 14 days carry a **New** tag and every answer shows when it was added.
- **A written answer** (`/q/<id>`) has the structure used in interviews: short answer, sections, common mistakes, likely follow-ups, and the sources. Key terms are marked with bold and italic. The text is written in our own words from the cited sources, so check a specific figure before relying on it.
- **System design prep** is a numbered list. Each question has a one-line description, tags for its key concepts and the solution links we collected (articles, videos, papers, discussions). Questions with no links yet say so.
- **Company pages** point to our content: an AI question with a written answer opens its answer page, and system design questions show our description and links. The original source link remains only as a small "Original question" chip for AI questions with no answer yet.
- **Rich text** in answers is `**bold**` and `*italic*` markers turned into `strong` and `em` elements by `richText()` in `js/common.js`, using `createElement` and text nodes only. Nothing from the API is parsed as HTML.

## Run locally

1. Start the backend (in `interviewsyntax-backend`): `npm start` (http://127.0.0.1:8787).
2. Copy `.env.example` to `.env` and set `API_BASE_URL=http://127.0.0.1:8787`. Leave `API_KEY` empty for a local backend with no key.
3. `npx netlify-cli dev`, then open http://localhost:8888.

Bump `?v=N` in every HTML file and in the `common.js` imports whenever a script or the stylesheet changes (see Security notes).

Tests: `npm test` (Node's built-in test runner, no dependencies).

## Deploy to Netlify

1. Push this repo to GitHub.
2. In Netlify: **Add new site** → **Import an existing project** → **GitHub**, and pick the repo.
3. Build command: leave empty. Publish directory: `.`. Functions directory: `netlify/functions` (already set in `netlify.toml`).
4. Under **Site configuration → Environment variables** set `API_BASE_URL` (the backend's worker URL, no trailing path) and `API_KEY`.
5. Deploy. Then set the backend's `ALLOWED_ORIGIN` to the Netlify URL only if the browser ever calls the backend directly; the proxy does not need it.

## Security notes

- CSP, `X-Content-Type-Options`, `Referrer-Policy` and `Permissions-Policy` are set in `netlify.toml` for every path. There is no inline script, style or `style=""` in the markup.
- API data is rendered with `textContent` and `createElement` only. Links are created only for `https://` URLs, with `rel="noopener noreferrer"`.
- The proxy allows only GET, only the paths in `ALLOWED_PATH`, and only the query params `q`, `page`, `limit`, `time_window`, `difficulty`, `topic`. Prep lists (`prep/ai`, `prep/system-design`) are allowed too. It never returns upstream headers except `Retry-After`.
- JS and CSS are revalidated on every load (`max-age=0, must-revalidate`, so unchanged files cost a 304) and are linked as `?v=N`. File names have no content hash, so a long cache could leave a browser with a new `home.js` and an old `common.js`. Bump `N` in the HTML and in the `common.js` imports when a script changes.
- `.env` files are git-ignored; commit only `.env.example`.

## Traffic

- **Netlify dashboard → Logs → Functions → `api`**: one JSON line per call that reaches the proxy: `{"event":"api","path":"/api/v1/companies/google","status":200,"ms":41}`. CDN cache hits never reach the function, so these are cache misses, which is what loads the backend. Paths and statuses only; no IPs, keys or query values are logged.
- **Netlify dashboard → Site overview / Analytics**: page views and bandwidth (server-side analytics is a paid Netlify add-on).
- **Usage events**: the pages send three anonymous events to `/api/v1/ping`: a page view, a category opened on a company page, and a failed request (with its status code). Nothing is stored in the browser, no cookies are set, and nothing goes to a third party (the CSP still allows only `'self'`). The proxy forwards the visitor address to the backend only so it can be reduced to a daily-changing hash. Browsers that send Do Not Track send no events. Pings are never cached.

## Backlog

Ideas that are not built yet, in the order we would likely do them.

1. **User login and progress tracking.** Let people sign in, add the companies they are preparing for, mark which questions they have solved, and see their progress. This was considered and put off because it is a different kind of site: accounts and sign-in, a place to store each person's data in D1, write endpoints, protection of personal data, account deletion and abuse limits. Today the site is read-only and the API key never reaches the browser, and login would change that. A smaller first step would be a "mark as solved" and "my target companies" list kept in the visitor's own browser, which needs no accounts but does not sync across devices.
2. **Bookmarks.** Save a question to come back to. A first version was built and then removed so that it can be designed together with login. Saved questions should follow the account, not stay in one browser.
3. **Automate data gathering.** Today the company interview profiles (80 of 460 companies, all low confidence), the AI answers and the system design links are gathered by hand and written into files in `kb/data/curated`. Automate the repeatable parts: a script that finds the next companies without a profile, drafts the entries with their source links for review, validates them, and loads only the changed tables to D1. Keep a human review step, store only metadata and links, and never invent data.
4. **More written answers.** About 585 of 598 AI questions have no published answer yet. Continue topic by topic, starting with LLM internals (about 37 left).
5. **Written answers for system design.** The list currently has descriptions, concepts and links only. Full answers can be added from the collected solutions.
6. **Switch on the traffic dashboard.** The code is deployed and data is being collected, but the live page at the backend's `/admin` stays off until two Worker secrets hold real values: `ADMIN_PASSWORD` and `CF_ANALYTICS_TOKEN` (a Cloudflare token with only Account · Account Analytics · Read). Setting them through `wrangler secret put` in a non-interactive shell appeared to save empty values, so set them in the Cloudflare dashboard (Worker → Settings → Variables and Secrets → Secret), redeploy, and check that `/admin` answers 401 and then loads with the password. See the backend README, "Traffic dashboard".

### Interview-experience collection and AI labelling (planned)

Goal: grow the library beyond the three repositories we started from by collecting interview experiences and questions from the places candidates actually post them, group and label them with AI, and publish only what is allowed and reviewed. Work in this order; each step has its own check before the next starts.

7. **Collection foundation (do first).** A `staging` area in the KB, separate from the published tables: one row per candidate item with source, URL, title, company mentioned, date posted, fetched date and a content hash. Nothing in staging is shown on the site. Add a review queue (accept, reject, merge) and a loader that moves only accepted rows into published tables and exports only the changed tables to D1. A takedown command removes everything from one source or URL. Rules for every source: store **metadata and links, not copied post text**; respect each site's terms and robots.txt, checked and written down before its adapter is built; no usernames or other personal data; every row keeps its source URL so a reader can go to the original.
8. **Source adapters, one at a time, each behind a terms check.**
   1. *Reddit* (first, it has an official API). Use the official OAuth API within its rate limits and terms, read from a short list of subreddits (for example r/leetcode, r/cscareerquestions, r/developersIndia, r/ExperiencedDevs). Keep post title, link, date, score and the company it names; skip comments and usernames.
   2. *LeetCode Discuss* (interview experience posts). LeetCode has no public API, so first confirm what its terms allow. Start with links the owner collects by hand (the same way the system design links were gathered) and only automate the listing of titles and links if the terms permit it.
   3. *GeeksforGeeks interview experiences.* Same approach: check terms and robots.txt, then collect title, company, role, year and link only.
   4. *Glassdoor.* Its terms forbid automated collection, so there is no scraper. Accept only links or short summaries that a person adds by hand, written in their own words, through the review queue.
9. **Extract structure from each item (AI, with review).** For each staged item an LLM reads only the title and any text we are allowed to process and returns a fixed JSON shape: company, role, level, year, rounds (for example coding, system design, AI, behavioral), topics mentioned and a one-line neutral summary. Use a small, cheap model for bulk work. Validate the JSON against a schema, store the model name, prompt version and date with every result, and never let it add facts that are not in the input. Items it is unsure about go to the review queue, not to the site.
10. **Cluster and label (AI).** Embed each question or summary, group near-duplicates across companies and years, and give each group one canonical wording plus a count of how many items and companies mention it. Assign each group to one of the existing topics (the 13 AI topics and the coding and system design categories) from a **fixed list**, so labels stay consistent, and keep a confidence score. Low confidence or a brand-new theme goes to review. Measure quality on a hand-labelled sample of about 100 items (agreement rate) before trusting the labels, and re-check after any prompt or model change.
11. **Use the results on the site.** Show "asked at N companies" and "seen in N reports" on questions, a most-asked list per company, and a freshness date. Link out to the original posts instead of copying them. Feed the counts into which answers to write next (the most-asked questions first).
12. **Run it on a schedule with monitoring.** A weekly job per adapter that fetches new items into staging only, a report of how many were new, accepted and rejected, and an alert when an adapter returns nothing or a lot more than usual (usually a site change). Budget the AI cost per run and stop at the limit.

Open decisions: which model to use for bulk labelling and what monthly budget; whether the review queue is a local script or a small private page; whether to keep embeddings in the KB or a separate file.
