# How InterviewSyntax is built

This page explains the design of the whole system: where the data comes from, how a request travels, how we cache, how failures are handled, how we watch the site, and what keeps the load low. It spans three projects.

| Project | What it is | Where it runs |
|---|---|---|
| `kb` | Builds the knowledge base: a SQLite file made from curated files and linked sources. Not a git repo, never deployed | Your machine |
| [`interviewsyntax-backend`](https://github.com/NupurMunda/interviewsyntax-backend) | Read-only JSON API (Hono, TypeScript) over a D1 database | Cloudflare Worker + D1 |
| [`interviewsyntax-frontend`](https://github.com/NupurMunda/interviewsyntax-frontend) (this repo) | The website: plain HTML, CSS and JavaScript, plus one proxy function | Netlify |

## The big picture

```
 You (offline)                  Cloudflare                          Netlify                     Visitor
 ─────────────                  ──────────                          ───────                     ───────
 curated files ─► kb build ─►   D1 database  ◄─ Worker (API) ◄───── api function (proxy) ◄─────  browser
 (answers, links,  + validate    (read-only)     key check,          adds the API key,           static pages
  profiles)        + export ──►                  rate limit,         allow-list, CDN cache,      + same-origin
                   SQL file                      JSON logs           8 second timeout            /api/* calls
```

The site is **read-only**. Nothing a visitor does changes the data. All data changes happen offline in `kb`, are checked, and are then loaded to D1 by hand.

## How a page loads

1. The browser gets a static page from Netlify and runs its script.
2. The script calls only same-origin `/api/v1/...`. It never talks to Cloudflare directly and never sees the API key.
3. The Netlify function (`netlify/functions/api.mjs`) checks the request against an allow-list, forwards it to the Worker with the API key added, and caches good answers.
4. The Worker (`interviewsyntax-backend/src/app.ts`) checks the key, applies the rate limit, validates the query, reads D1 and returns `{data, meta}`.
5. The page builds its DOM with `createElement` and `textContent`, never `innerHTML`.

## Data: from files to the site

1. **Curated files** in `kb/data/curated`: company interview profiles, written AI answers (`answers/*.json`), and per-question system design links, descriptions and concepts (`hld_links.txt`). Everything is metadata and links; we store no copied content and never invent data.
2. **Build** (`npm run build` in `kb`) creates the SQLite database. **Validate** (`npm run validate`) recomputes the checks independently of the loaders: counts match the files, every link is `https`, answers have balanced markup, no row points at a missing question.
3. **Export** (`npm run export:d1` in the backend) writes `dist/d1-import.sql`. Hidden sources are skipped, full text is included only for sources that allow it, and `company_stats` is precomputed.
4. **Load** to D1 with `wrangler d1 execute`. We load only the tables that changed, because the free plan allows about 100,000 rows written a day.
5. Answers are matched to questions by **exact category and title**, not by id, so rebuilding the database does not detach them. Before a load we compare ids with the live database and stop if they differ.

## Caching (most visitors never reach the database)

| Layer | Rule | Why |
|---|---|---|
| Browser, API responses | `max-age=300` (5 minutes) | Repeated clicks cost nothing |
| Netlify CDN, API responses | `s-maxage=86400` (a day), `durable`, `stale-while-revalidate=604800` (a week) | The data changes rarely; one copy is shared by every visitor, and an expired copy is served while it refreshes |
| Worker responses | `Cache-Control: public, s-maxage=86400` on 200s | Marks them cacheable; errors and `/ping` are never cached |
| `/ping` (usage events) | `no-store` | Every visit must be counted |
| Browser, JS and CSS | `max-age=0, must-revalidate` and `?v=N` in the URL | Unchanged files cost a 304; bumping `N` forces new code, so a browser never mixes new and old scripts |
| Browser, last good copy | `localStorage`, up to 7 days, 300,000 characters per entry | If the service is down or busy, the page shows the last good copy with a notice |

The trade-off: a data change can take **up to a day** to appear, unless the cache is cleared. That is acceptable because the content is curated and changes rarely.

## Error handling

Every error is a small JSON object, `{error:{code, message}}`, with no internals leaked.

| Situation | Response | What the visitor sees |
|---|---|---|
| Bad query parameter or unknown parameter | `400` (parameters are validated strictly with zod) | A generic error |
| Missing or wrong API key | `401` | Never happens through the site; the proxy adds the key |
| Unknown route, company or question | `404` | "Not found." |
| Too many requests from one visitor | `429` with `Retry-After` | "Too many requests, try again in N seconds." |
| D1 fails or its daily limit is hit | `503` `temporarily_unavailable` with `Retry-After: 300`; `/health` and 404s keep working | "The data service is temporarily unavailable." plus the saved copy, if there is one |
| Unexpected bug | `500` `internal`, details only in the logs | A generic error and a "Try again" button |
| Worker unreachable or slower than 8 seconds | Proxy returns `502` with `Retry-After: 30` | Same as 503 |
| Anything other than GET, or a path not on the allow-list | Proxy `405` or `404`, the Worker is never called | Not found |

The pages use one shared path for this: on a network failure, `429` or a `5xx`, they fall back to the saved copy of that exact request and show "Showing saved data. The service is busy or temporarily unavailable, so this may be out of date." Without a saved copy they show the message and a **Try again** button.

## Keeping the load low

- **Cache first:** the CDN answers nearly every repeat view (see above).
- **Rate limit:** 60 requests a minute per visitor, using the Cloudflare rate-limit binding. The proxy forwards the visitor's address in `x-client-ip`, and the Worker trusts that header only when the API key matches, so one visitor cannot use up a limit shared by everyone behind Netlify. The binding counts per Cloudflare location, so treat it as a safety net rather than an exact global count.
- **Small answers:** lists are paged, with `limit` capped at 50.
- **No expensive queries:** company counts come from a precomputed `company_stats` table, so listing companies never counts rows. A test runs `EXPLAIN QUERY PLAN` on every query and fails if one scans a large table.
- **Small writes:** only changed tables are loaded to D1, in chunks of at most 100 rows.
- **Static pages:** the site itself is plain files on a CDN, so page views cost the backend nothing.
- **Hard limits:** GET only, an allow-list of paths and query parameters, an 8-second upstream timeout.

## Monitoring

There is no separate monitoring service. The logs are the monitoring, and they contain no IPs, keys, query text or other personal data.

| Where | What it shows |
|---|---|
| Cloudflare dashboard → Workers → `interviewsyntax-backend` → **Logs** (observability is on, 100% sampled) | One JSON line per request: `{"event":"request","route":"/v1/companies/:slug","status":200,"ms":12}`. Filter by `status` to get the success and failure rate and the kinds of failure (400, 429, 503, 500) |
| Same place, `event: "track"` | Usage: page views (`kind: view`, `page`), categories opened on company pages (`kind: query`, `company`, `category`), failed requests seen by the browser (`kind: error`, `status`), and a `visitor` hash for counting unique visitors |
| Netlify dashboard → Logs → Functions → `api` | One line per call that reaches the proxy: path, status, milliseconds. CDN hits never reach it, so these are the cache misses, which is the load the backend actually sees |
| Cloudflare dashboard → D1 | Rows read and written against the free-plan daily limits |

**Privacy by design:** the browser sends three kinds of anonymous event to `/api/v1/ping`. Nothing is stored in the browser, no cookies are set, nothing goes to a third party, and visitors who send Do Not Track send nothing. The `visitor` value is a SHA-256 hash of the address, the date and a secret, cut to 6 bytes, so it changes every day and cannot be turned back into an address.

**What is not set up yet:** there are no alerts. Nobody is paged when errors rise, so someone has to look at the dashboards. A daily check of the 5xx rate and D1 usage is the first thing to automate.

## Security in short

- The API key lives only in Netlify's environment and the Worker's secrets. It is never in the browser or in git, and `.env*` files are git-ignored.
- The proxy forwards only allow-listed GET paths and only these query parameters: `q`, `page`, `limit`, `time_window`, `difficulty`, `topic`, plus the usage fields for `/ping`. It returns no upstream headers except `Retry-After`.
- The Content-Security-Policy is `default-src 'self'; script-src 'self'; connect-src 'self'`, with no inline script or style. Data is rendered with `textContent`, and links are created only for `https://` URLs with `rel="noopener noreferrer"`.
- Sources marked hidden never reach D1 or any response, including counts.

## Where to look in the code

| Topic | File |
|---|---|
| Routes, rate limit, cache headers, error handler, usage events | `interviewsyntax-backend/src/app.ts` |
| All SQL, shared by the local and D1 stores | `interviewsyntax-backend/src/store/queries.ts` |
| D1 export | `interviewsyntax-backend/scripts/export-d1.mjs` |
| Failure, query-plan, logging and tracking tests | `interviewsyntax-backend/tests/resilience.test.ts` |
| Proxy, cache headers, allow-list | `netlify/functions/api.mjs` |
| API client, saved-copy fallback, error messages, safe rich text | `js/common.js` |
| Security headers and redirects | `netlify.toml` |
