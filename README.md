# Punctum

Punctum is the invoice-automation platform's engine, rebuilt as a maintainable TypeScript
service.
This first slice is **Sc2.5 — the POS tag generator**: it turns a catalog item and its
variations into the space-joined tag string Square uses for search/filtering
(e.g. `BVLA 20g SMR RG WG YG`).

It is a faithful port of Make scenario **5330172** ("PRODUCTION - V2 - 2.5 Tag and Search
Suffix Generator"). The goal of this pilot is to prove that a code-based engine is easier
to change and safer to trust than the Make blueprint — see `docs/DECISIONS.md`.

## Layout

```
src/lib/tagger.ts          Pure tag generator (port of Make module 3). Tag ORDER is the contract.
src/jobs/tags.generate.ts  Filter / group / write-back semantics (Make modules 1,2,4,5), I/O abstracted.
src/cli/parity-report.ts   Rebuilds groups from the production backup and checks the port vs. live tags.
tests/tagger.unit.test.ts  Behavior locks: threading, GD dedupe, princess/prong, gauges, quirks.
tests/tagger.golden.test.ts Regression suite over 194 real catalog groups.
tests/golden/groups.json   The frozen golden corpus (committed).
```

## Commands

```bash
npm install        # once
npm run typecheck  # tsc --noEmit (strict)
npm test           # node --test (unit + golden)
npm run tags:parity # regenerate the golden suite + parity report (needs the derived source)
```

Requires Node >= 22 (uses the built-in test runner and `tsx` for TS execution).

## How the tagger works

`generateTags(rows)` takes all mapping-sheet rows that share one Square catalog ID (in
sheet order) and returns a `TagResult`. Vendor tags come first, then item-name extraction
in a fixed order (gauges -> types -> settings -> connection -> gems -> materials), then a
per-variation pass (gems, materials, settings), then threading inference and generic-gold
dedupe. Every dictionary and matching quirk is copied verbatim from the live code because
the golden corpus was written by it — see `docs/DECISIONS.md` before changing anything.

## Regenerating the golden corpus

`groups.json` is committed and frozen. To rebuild it, produce the derived
`tests/golden/_source-rows.json` from the client's production mapping backup (the 6.10
"through Sc3" xlsx, columns A/D/G/H/J/K) and run `npm run tags:parity`. The xlsx and the
`_*.json` derivatives are intentionally **not** committed (see `.gitignore`).

## Status

Phase 0 pilot: local build + tests + CI config. Deploy (GitHub + Railway) is the next
session — see `../Handoff Docs/` and the signup checklist.

## Running as a service

A dependency-free HTTP wrapper (`src/server.ts`, Node stdlib) exposes the tagger:

```bash
npm start   # listens on $PORT (default 3000)
# GET /health
# GET /tags?vendor=BVLA&item=20g%20Seam%20Ring&variation=RG14K&variation=WG14K&variation=YG14K
#   -> { "tags": "BVLA 20g SMR RG WG YG", ... }
```

## Deploy (Railway)

`npm start` binds to `process.env.PORT`, so Railway's Node (Nixpacks) build needs no extra
config: New Project → Deploy from GitHub repo → `punctum` → Generate Domain. `tsx` is a
runtime dependency, so the TypeScript entry runs in production with no build step.
