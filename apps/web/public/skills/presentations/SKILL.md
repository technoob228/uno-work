---
name: presentations
description: Use by default whenever the user asks for any presentation, deck, slides, pitch deck, investor or sales deck, board or strategy deck, executive summary slide, consulting/McKinsey/MBB-style slide, or wants data/analysis turned into slides or made "boardroom-ready". Produces single slides or multi-slide decks as a standalone HTML file (or .pptx on request) to management-consulting standards: action titles, Pyramid Principle, real charts, sourced numbers. Adapted by Uno from trev0rr/executive-slide-skill (Apache-2.0).
---

# Presentations (consulting-grade slides)

> Adapted by Uno from [trev0rr/executive-slide-skill](https://github.com/trev0rr/executive-slide-skill), Apache-2.0 (see LICENSE). Changes: default output is a standalone HTML file instead of a React artifact; copy follows the `sales-copy` skill; a critic pass via `deck-critic`.

Build slides to the standard of a top-tier consulting firm: flat, dense-but-clear analytical pages with action titles, labeled charts, and real sources — pages that stand alone without narration. Not SaaS dashboards, not startup pitches, not decorated bullet lists.

## Required reading

**Before building any slide or deck, read every file in this skill's `reference/` directory:**

1. `reference/storylining.md` — Pyramid Principle, MECE trees, deck types, headline-flow test
2. `reference/layout.md` — canvas, grid, title block, footer, the 9 layout patterns
3. `reference/charts.md` — chart selection, labeling rules, Chart.js implementation
4. `reference/typography.md` — the type scale and palette roles
5. `reference/language.md` — action titles, copy rules, the humanizer pass

Do not build from memory of these files' names. Read them, then build.

The reference files were written for a React + Tailwind renderer. Take their rules, sizes, and Chart.js configs; ignore React wrappers (`useRef`/`useEffect`), JSX, and Tailwind class names — in HTML output use plain CSS and a plain `new Chart(canvas, config)` call.

## Hard rules

Violating any of these is a failed slide, regardless of how it looks:

1. **Every chart is a real chart object** — Chart.js in HTML output, native PowerPoint charts (python-pptx chart API) in .pptx. No CSS bars, no hand-drawn SVG charts, no screenshots, no placeholders.
2. **Every analytical claim is attributed** — a source line per layout.md §4; when matching a house template that has no source convention, provenance is stated in the content instead. No fabricated stamps.
3. **No text below 15px / 11pt anywhere** — including chart ticks and labels — and only integer sizes from a defined scale (typography.md's, or one derived the same way from a house template).
4. **Every body-slide title carries the slide's message**: by default a complete sentence stating the so-what, ≤2 lines; a user-specified house voice may shorten the form, never the claim. Never a topic label.
5. **Pyramid + MECE structure**: conclusion first; titles alone must tell the story (headline-flow test).
6. **Flat consulting style**: white background, primary-color title + 2px rule, aligned columns, ≥20% whitespace. No cards, shadows, gradients, or rounded containers (unless a house template says otherwise — see Overrides).
7. **Every color maps to a palette role** (primary / secondary / highlight / greyscale). No decorative color, no rainbow charts.
8. **Never invent numbers.** A figure the user didn't provide and the source material doesn't contain renders as a visible `[ CONFIRM · … ]` placeholder — never a plausible-looking value.

## Overrides (user context beats skill defaults)

- **Output format.** The standalone HTML file is the default, not a cage. If the user specifies another format (`.pptx`, a React artifact, PDF), build it with the right tool (e.g. python-pptx for `.pptx`) and keep the entire workflow, hard rules, and self-check. For `.pptx`: 16:9 = 13.333×7.5 in, pt sizes map 1:1 from the type scale's pt column, letter-spacing via the run's `spc` XML attribute.
- **House style.** When the user supplies an existing deck or brand system to match, its design language — background, typography, kicker/label conventions, headline style, footer, emphasis devices — overrides layout.md and typography.md defaults. Extract exact tokens from the best source available (an HTML/CSS version beats eyeballing a PDF; check the filesystem for one). Structural discipline still applies in full: storyline, slide plans, the type floor, palette-role mapping of the brand's colors, the humanizer pass, visible placeholders, and the self-check.
- **Voice.** A user-specified voice (short declaratives, no Oxford commas, named-team informality) overrides the default title/copy register. Apply the humanizer pass in that voice; the banned-word list still applies.

## Workflow

### Step 0 — Intake (conditional; before anything else)

Check whether the conversation/uploads already establish: **(a)** brand kit or brand colors, **(b)** audience and objective (persuasive vs. informative), **(c)** deck type (summary / deep dive / backup), **(d)** delivery context (presented live vs. standalone read).

- If **any** are missing, ask for **all missing items in one batched message**, stating the default for each so the user can reply "use defaults": defaults are maroon fallback palette; senior-executive audience, persuasive; summary deck; standalone read.
- If all four are known, skip intake entirely and say nothing about it.
- If you cannot ask (delegated or non-interactive run), use the defaults and list them in one line at the top of your reply.
- **Brand first:** before falling back to the default palette, look for the project's own colors (DESIGN.md, CSS variables, an existing deck or site in the project) and use them.
- **Never ask questions after the build starts.**

### Step 1 — Storyline

Work out (and show briefly): the governing question, the governing thought (one-sentence answer), the 2–4 MECE branches, and the **ordered action-title list** for every slide. Run the headline-flow test: the titles alone, read in order, must tell the complete story. Fix the storyline before designing anything. Decks with 4+ content slides get a title slide and an executive-summary slide prepended (storylining.md §8).

### Step 2 — Slide plans (think before output)

For **each** slide, before writing any markup, write a 4-line plan in your visible response:

- **Message:** the action title (final wording)
- **Evidence:** which facts/data prove it, and their source
- **Layout:** the named pattern from layout.md §5, and why
- **Chart:** the chart type from charts.md §2 (with the comparison it shows), or "no chart" with the reason

Check each plan against the Hard rules before rendering. If a plan fails (e.g., no source exists for a claim), fix the plan, not the rendered slide.

Write the deck in the user's language. All copy (titles, bullets, callouts) also follows the `sales-copy` skill if it is installed: facts instead of evaluations, no filler words, reader-first.

### Step 3 — Render

Build the artifact per Output format below, following layout.md / charts.md / typography.md exactly.

### Step 4 — Humanizer pass

Re-read every piece of copy on every slide against language.md §3: banned words, banned patterns, the four rewrite tests. Rewrite in place. This pass is mandatory even when the copy "seems fine."

### Step 5 — Self-check

Run the checklist at the bottom of this file against **every slide**. Fix all failures before delivering. Then confirm in one line that the deck passed (e.g., "Self-check: 5/5 slides pass").

## Output format

One standalone `.html` file (e.g. `deck.html` in the project), openable by double-click or in a preview panel. No build step, no framework.

- **Canvas:** every slide is a fixed 1280×720 `<section class="slide">`, scaled to fit the viewport by transform-scaling the whole stage (never by changing font sizes). A small inline script sets `transform: scale(min(innerWidth/1280, innerHeight/720))` on resize.
- **Single slide:** one stage, no navigation chrome.
- **Deck:** all slides in one file; keyboard nav (←/→, PageUp/PageDown, Space), small bottom-center dot indicators, subtle prev/next arrows, `#3` in the URL hash to deep-link a slide. Instant swap, no transitions. A `?print` mode (or `@media print`) stacks all slides one per page for PDF export.
- **Charts:** Chart.js 4 via `<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>`; if the environment blocks external scripts, save `chart.umd.min.js` next to the HTML and reference it relatively. Create each chart when its slide is first shown; `animation: false`; fonts and colors per charts.md §5. The React snippets in `reference/` show the Chart.js config — reuse the config, not the React wrapper.
- **Icons:** inline SVG (e.g. Lucide paths), stroke-width 1.5, used only as row/pillar markers per layout.md.
- **Fonts and CSS:** plain CSS with pixel sizes from the type scale; one `<style>` block with CSS variables for palette roles.
- **`.pptx` on request:** python-pptx with native charts, same workflow and rules (see Overrides).

## Worked examples

**1. Title: label → claim.**
- Bad: title "Revenue Growth Analysis" over a bar chart, bullets "Revenue grew significantly," "Margins under pressure."
- Good: title "50% annual growth with declining profitability is unsustainable — we need a strategy that balances both." Chart + evidence column (layout 5.1): combo Chart.js bar+line (revenue columns in primary, OI% black line), "48% CAGR" callout, right column of bold-metric evidence blocks ("48% CAGR", "250+ new hires", "−600bps OI"), source line "Source: Client financials, FY2014–17; team analysis."
- Why: the bad slide makes the reader do the analysis; the good slide asserts the conclusion and proves it, with axes, units, and a source.

**2. Chart honesty: decoration → labeled evidence.**
- Bad: gradient-filled CSS bars with no axes ("cleaner look"), values only on hover, five colors, no source.
- Good: Chart.js horizontal bar sorted by value, one primary-color focal bar and grey context bars, horizontal axis labeled "Store sales ($M)," dashed benchmark line labeled "Industry average $3M" on the chart, data labels on each bar, source line present.
- Why: an executive must decode the chart cold — type matched to an item comparison, every scale labeled, benchmark on the chart, one focal color.

**3. Copy: AI-slop → executive prose.**
- Bad: "Leveraging cutting-edge automation to unlock robust operational synergies across the value chain."
- Good: "Robotic process automation cuts labor cost 18% while lifting throughput."
- Why: banned words out, concrete verb, a number, and a consequence. Passes the partner test.

## Self-check (run per slide, fix before delivering)

- [ ] Title carries the slide's message (so-what sentence, or house-voice equivalent), ≤2 lines, active verb, no banned words
- [ ] Reading all titles in order tells the full story (deck-level, run once)
- [ ] Every analytical claim is attributed (source line, or in-content provenance under a house template)
- [ ] All charts are real chart objects (Chart.js / native pptx); type matches the comparison; axes labeled horizontally with units; benchmark/average lines labeled on the chart
- [ ] No invented figures — every missing number is a visible `[ CONFIRM · … ]` placeholder
- [ ] No text below 15px (including chart options); all sizes from the approved scale
- [ ] Every color maps to a palette role (primary/secondary/highlight/greyscale); no decorative or unassigned colors; same palette across all slides
- [ ] Margins (64/48/40), aligned columns, ≥20% whitespace; no cards, shadows, gradients
- [ ] ≤6 supporting points, ≤~8 words each; one idea per slide; slide stands alone without narration
- [ ] Numbers rounded, units shown, figures tie out across slides
- [ ] Copy passed the humanizer pass (no banned words/patterns; partner, evidence, verb, deletion tests)

## Step 6 — Critic pass (decks of 4+ slides)

If the `deck-critic` skill is installed, run it on the finished deck before delivering, fix its top 3 issues, and mention the grade in one line.
