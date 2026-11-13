# GrowthOS MCP server

Gives a coding agent (Claude Code) working in a site's **website repo** access to what GrowthOS knows about that site, so the agent can make the fixes in the repo itself. GrowthOS supplies the *what* and *why*; the agent edits, type-checks, commits and opens the merge request with your own git login.

It talks only to the GrowthOS HTTP API using the dev key. It never touches the database or any repo.

## Tools

| Tool | What it does |
|---|---|
| `list_sites` | Sites in GrowthOS (the first is the default) |
| `seo_overview` | Latest audit: score, issue counts per check |
| `list_findings` | SEO issues by priority, with evidence and suggested fix (filter by `check_id`, `severity`, `url`) |
| `get_page` | What the crawler saw on one page, plus that page's issues |
| `draft_fix` | AI-written replacement copy for a finding (one AI call; cached) |
| `list_suggestions` / `update_suggestion` | Growth suggestions; mark accepted / done / dismissed |
| `search_knowledge` | Search the internal growth repo (brand, compliance, demand map) |
| `search_console` | Search Console snapshot: near-page-1 queries, top pages, trend |
| `check_copy` | Check copy against banned words / claims before committing |
| `start_audit` | Re-crawl the live site after a fix is deployed |

## Setup

1. Build it: `pnpm --filter @growthos/mcp build`
2. Have the GrowthOS API running (default `http://localhost:4000`).
3. Register it with Claude Code **from inside the website repo**, with `local` scope so nothing is written into that repo:

   ```sh
   cd <website repo>
   claude mcp add growthos --scope local -- node <growthOs>/services/mcp/dist/main.js
   ```

   Use `--scope user` instead to make it available in every folder. Avoid `--scope project`: it writes a `.mcp.json` into the client's repo.

## Configuration

Read from the environment first, then from the GrowthOS root `.env` (found from the server's own location, not the current folder):

| Variable | Default | |
|---|---|---|
| `GROWTHOS_API_URL` | `http://localhost:$API_PORT` (4000) | API base URL |
| `GROWTHOS_DEV_KEY` | `DEV_KEY` from `.env` | API key |
| `GROWTHOS_SITE` | first site | Default site (id, name or domain) when a tool call names none |

## Confidentiality

Knowledge-base passages and Search Console figures are internal. The server's instructions tell the agent to use them for decisions but never to paste them into code, comments, commits or merge-request descriptions the client could see.
