# Decisions & port record — Sc2.5 tag generator

## Why this exists

The invoice-automation platform is moving from Make blueprints to a custom TypeScript
service (Railway + pg-boss on Supabase Postgres, Nango for Square OAuth; fallback
Pipedream Connect). Rationale and the platform stack live in `../Handoff Docs/Plans/`.
Sc2.5 is the pilot: the smallest self-contained job, ported as production code with tests
and CI, so the maintenance experience can be judged against Make on a real change.

## Provenance

`src/lib/tagger.ts` is a line-by-line port of **Make scenario 5330172**, module 3
(`ExecuteCode`, `codeStringJavascript`). `src/jobs/tags.generate.ts` reproduces the
surrounding data flow (modules 1, 2, 4, 5).

## Fidelity rules (do not "improve" these)

The output is a **space-joined string and tag order is part of the contract** — the golden
corpus was written by the live code, so any reordering is a regression. To preserve it:

- **Dictionaries are verbatim**, including deliberate collisions and known misspellings:
  - `princess` and `prong` both map to `PRG`.
  - `cab`/`cabochon` -> `CAB`; `open back` -> `BZL`.
  - Misspellings kept as-is because vendor data contains them: `labadorite`, `rhodalite`,
    `artic blue`, `junippur`.
- **Extraction order on the item name is fixed:** gauges -> types -> settings ->
  connection -> gems -> materials. Then a per-variation pass runs gems -> materials ->
  settings. Vendor tags are emitted first, before any item-name extraction.
- **Matching semantics per dictionary are preserved:**
  - Types: `indexOf` with a matched-substring skip (longer key wins).
  - Settings: word-boundary regex, keys sorted longest-first.
  - Materials / gems: `indexOf`; `GEM_WORDS` is an ordered array (longest/most-specific
    first) and **every** hit is added.
- **Intentional quirks preserved:** e.g. `sapphire blue` yields **both** `SBL` and `SPH`
  (the substring `sapphire` also matches). This is tested, not fixed.
- **Gauge normalization:** `\b(\d{1,2})g\b` plus `NN ga` / `NNga` -> `NNg`.
- **Threading inference:** for barbell families (`BBL`/`CBB`/`CIR`) with no explicit
  `TL`/`TD`: 12g or 14g -> `TD`; 16g -> `TL` if NeoMetal else `TD`.
- **Generic-gold dedupe:** drop `GD` when `YG`, `RG`, or `WG` is present.

### The one intentional divergence

The live code accepts a `text` blob and has to defend against Make emitting a literal
`\n` separator. The port takes **structured group input** instead
(`TagInputRow[]`), so that quirk is dropped. The job wrapper builds groups directly; the
tagger never parses a delimited string.

## Golden corpus & parity

Method: from the client's frozen production mapping backup (the 6.10 "through Sc3" xlsx;
columns A=Vendor, D=Catalog ID, G=Item, H=Variation, J=Status, K=POS Tags), rebuild each
catalog group (all rows sharing D, in sheet order) and compare the port's output to the
stored K. Reproduce with `npm run tags:parity`.

Results (2026-07-11):

| bucket | count |
| --- | --- |
| total catalog groups | 214 |
| ambiguous — >1 distinct stored tag string (excluded) | 17 |
| single-tag groups | 197 |
| **exact port matches (the golden suite)** | **194 (98.5%)** |
| set-difference mismatches | 3 |
| order-only mismatches (would be a port bug) | **0** |

**Zero order-only mismatches** is the key signal: wherever the port and live code see the
same set of rows, they produce the same tags in the same order.

### Why the excluded groups are legitimately excluded

The mapping sheet is a living document. Tags were written when rows were `PENDING`; group
membership has since changed, and the known Sc3 tag-overwrite bug
(memory: `project_tag_overwrite_bug`) degraded some stored tags. None of the exclusions
indicate a porting error.

**17 ambiguous** (one catalog ID carries two or more distinct stored tag strings):

- _Vendor conflict_ — same Square catalog ID tagged under two vendors (4):
  `XV3QNE7Z4M6ZVVP5DQCFCIEA`, `X2BAFYIKDW6BKANOCBX2UQNH`, `4Y4OHOJGKNGNIBKJEIPQA3ZJ`,
  `KX6KS2ZXT2RG2PW35RWW765X`.
- _Enrichment / gem drift_ — same vendor + type, gem/setting set grew or was degraded (11):
  `CZORMPNKVHLHH224HVPFEVGQ`, `VND637FJFE2WNABISOOU6YFX`, `Z3Q652VP3JXKRDMCNN4OA4DF`,
  `4TMCEWF2N6A4YYETKZMKDYTL`, `I7DODP2U6S2ACKS5GXTVTBQL`, `MQROHFL3RQMKSA3QFITK3P27`,
  `S4EAC6JTQ5WE2CM32ATSBWOZ`, `44KPH3AUGQD65PWIGGPHEYYJ`, `INI6K75JF3UJ2SYFCDO7SCQ3`,
  `KBLTTFCWEYB6MFT7V52ZXEVF`, `DEUVUCMNYSE3ZM3LTZKISH7K`.
- _Karat color drift_ (2): `KGSJ5XMLDCXEMSCXU635ZGTD`, `VE3NTHA3A5SMAPIQA5CKZ7VF`.

**3 membership-drift mismatches** (single stored tag string, but current group membership
differs from tag-time — token diff only, never order):

- `TJCFKTVZKN2ZSMXV7WQOUDPZ` "18G Threadless Flower" — stored has `MNT`; the mint-green
  variation is no longer in the group (membership shrank).
- `3PI5Y7AWWLP5ECZ4TRRZDEDO` "18G Prong Set Seam Ring" — port adds `WHT WG`; a white-gold
  variation exists now that wasn't tagged originally (membership grew).
- `3TFGEUGUNMPX4I5IH63HUWBJ` "18G 2.5MM Threadless Prong-Set" — port adds
  `PNK SBL SPH TEL WHT MNT`; group grew substantially since tag-time (consistent with the
  Sc3 overwrite bug leaving a degraded subset).

Full triage detail is written to `tests/golden/_parity-report.json` (not committed).

## Committed vs. derived

Committed: `groups.json` (the frozen golden suite). Not committed: the source xlsx and the
derived `tests/golden/_*.json` (regenerate via `npm run tags:parity`).
