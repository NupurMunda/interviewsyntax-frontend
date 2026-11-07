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
2. Copy `.env.example` to `.env` and set `API_BASE_URL=http://127.0.0.1:8787` (the proxy honours `API_BASE_URL` only for a backend on this machine). Leave `API_KEY` empty for a local backend with no key.
3. `npx netlify-cli dev`, then open http://localhost:8888.

Bump `?v=N` in every HTML file and in the `common.js` imports whenever a script or the stylesheet changes (see Security notes).

Tests: `npm test` (Node's built-in test runner, no dependencies).

## Deploy to Netlify

1. Push this repo to GitHub.
2. In Netlify: **Add new site** → **Import an existing project** → **GitHub**, and pick the repo.
3. Build command: leave empty. Publish directory: `.`. Functions directory: `netlify/functions` (already set in `netlify.toml`).
4. Under **Site configuration → Environment variables** set `API_KEY`. The backend's address is a constant at the top of `netlify/functions/api.mjs` (it is not a secret), so switching servers is a reviewed code change, not a dashboard setting.
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
