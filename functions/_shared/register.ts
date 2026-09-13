/**
 * The Dispatch register, for the two owner surfaces (23 August 2026).
 *
 * /studio and /rss are Pages Functions rather than Astro pages, so they cannot
 * import the fontsource CSS the site builds with: every woff2 in _astro/ is
 * fingerprinted and the hash moves on any rebuild that touches the faces.
 * The faces are self-hosted, so the two latin roman subsets are
 * copied to public/fonts/ at stable paths and declared here. Both faces are
 * OFL-1.1 and their licences ship beside them, which the licence requires of
 * anyone redistributing them.
 *
 * ONE DEFINITION, TWO CONSUMERS. The values below are lifted from
 * src/styles/tokens.css and MUST match it exactly. They did not on 23 August
 * 2026: --bg-ivory was written #1A1913 against the real #282621, and
 * --fg-ink-soft was written #B2AFA8, which is the value of --accent-mute on
 * the adjacent line. Both were hand-copied, which is the precise failure this
 * module exists to stop, and both were wrong only in the NIGHT register, where
 * an eye is least likely to catch them. Any change to tokens.css
 * is re-diffed against this block, resolved value by resolved value, not read
 * across by eye. Hand-copying them into each Function is
 * exactly the defect a C-8 round caught on the site that same night: a colour
 * written for a ground the site no longer has, sitting in a file nobody
 * re-inks when the palette moves. If tokens.css moves, this file moves with
 * it and both surfaces follow.
 *
 * What is deliberately NOT here: page structure, and anything either surface
 * uses once. This is the register, not a component library.
 */

/** Stable, unfingerprinted, served from public/fonts/. Roman only: neither
 *  surface sets italic, and the italic subsets are 143KB each. */
export const FACES = `
@font-face {
  font-family: 'Newsreader Variable';
  src: url('/fonts/newsreader-latin.woff2') format('woff2-variations');
  font-weight: 200 800;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'Archivo Variable';
  src: url('/fonts/archivo-latin.woff2') format('woff2-variations');
  font-weight: 100 900;
  font-stretch: 62% 125%;
  font-style: normal;
  font-display: swap;
}`;

/** The base register and its night inversion, both from tokens.css. The two
 *  owner surfaces follow the OS preference only: neither carries the site's
 *  day/night toggle, which lives in the Astro header. */
export const TOKENS = `
:root {
  color-scheme: light;
  --bg-parchment: #F7F6F2;
  --bg-ivory: #FDFCFA;
  --fg-ink: #15140F;
  --fg-ink-soft: #5A574C;
  --signal: #C0301B;
  --rule-hard: #15140F;
  --rule-soft: #D6D2C6;
  --line-soft: rgba(21, 20, 15, 0.12);
  --btn-solid-bg: #1E1C17;
  --btn-solid-fg: #EFEDE7;
  --label-wdth: 88;
  --font-display: 'Newsreader Variable', Newsreader, Georgia, 'Times New Roman', serif;
  --font-grot: 'Archivo Variable', Archivo, 'Helvetica Neue', Helvetica, Arial, sans-serif;
  --font-mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg-parchment: #100F0B;
    --bg-ivory: #282621;
    --fg-ink: #EFEDE7;
    --fg-ink-soft: #B3B1AA;
    --signal: #E6705C;
    --rule-hard: #EFEDE7;
    --rule-soft: #3A3830;
    --line-soft: rgba(239, 237, 231, 0.14);
    --btn-solid-bg: #EFEDE7;
    --btn-solid-fg: #100F0B;
  }
}`;

/** The grammar both surfaces share: the hard rule that opens a page, the label
 *  face, hairline-ruled blocks rather than cards, and the signal reserved for
 *  live state. No border-radius anywhere, which is the press register's whole
 *  argument with a dashboard's default look. */
export const BASE = `
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg-parchment);
  color: var(--fg-ink);
  font-family: var(--font-display);
  font-size: 1.0625rem;
  line-height: 1.6;
  font-optical-sizing: auto;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 60rem; margin: 0 auto; padding: 2rem 2rem 4rem; }

/* The masthead: a 2px hard rule, the name in display caps, a live dateline. */
.top {
  border-top: 2px solid var(--rule-hard);
  padding-top: 0.9rem;
  display: flex; flex-wrap: wrap;
  justify-content: space-between; align-items: baseline; gap: 1rem;
}
.top h1 {
  font-family: var(--font-display);
  font-weight: 500; font-size: 2rem; line-height: 1;
  letter-spacing: -0.025em; text-transform: uppercase; margin: 0;
}

/* The label face. Every scanned element takes it; nothing read does.
   h2 WAS IN THIS SELECTOR AND IS NOT ANY MORE (23 August 2026). 'Every h2 is
   a label' is false as a statement, and it was false on both surfaces the day
   it was written: /rss wraps every article title in an h2.ititle-wrap, so
   every headline in the reader rendered in capitals, and .mhead h2 asks for a
   1.35rem serif heading which was being capitalised against its own rule.
   Neither override caught it, because both set the 'font' shorthand, and that
   shorthand resets family, weight and size but NOT text-transform, which then
   inherited into the link inside.
   th stays, because a column header genuinely IS a label and the tag says so.
   A heading element does not say what register it wants; it says how important
   it is. Anything that wants the label face asks for it by class. */
.label, th, .stat-label, .tab, .badge {
  font-family: var(--font-grot);
  font-variation-settings: 'wdth' var(--label-wdth);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.16em;
}
.label { font-size: 0.625rem; color: var(--fg-ink-soft); }
.dot { color: var(--signal); margin-right: 0.4em; }

section { margin-top: 2.25rem; }
.sec-head {
  display: flex; flex-wrap: wrap;
  justify-content: space-between; align-items: center; gap: 1rem;
  border-bottom: 1px solid var(--rule-hard);
  padding-bottom: 0.5rem; margin-bottom: 1rem;
}
h2 { font-size: 0.6875rem; margin: 0; }

/* Tabs are labels with a rule under the live one, never pills. */
.tabs { display: flex; flex-wrap: wrap; gap: 1.25rem; }
.tab {
  font-size: 0.6875rem; letter-spacing: 0.14em;
  text-decoration: none; color: var(--fg-ink);
  position: relative; padding-bottom: 3px;
}
.tab.on::after {
  content: ''; position: absolute; left: 0; right: 0; bottom: 0;
  height: 2px; background: var(--signal);
}
.tab:hover::after {
  content: ''; position: absolute; left: 0; right: 0; bottom: 0;
  height: 1px; background: var(--rule-soft);
}
.tab.on:hover::after { height: 2px; background: var(--signal); }

/* Figures sit in ruled columns. A card with a border and a radius is a
   dashboard's default and says nothing; a hairline between columns says
   these are one set. */
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); }
.card { padding: 0.9rem 1.25rem; border-left: 1px solid var(--rule-soft); }
.card:first-child { border-left: 0; padding-left: 0; }
.stat {
  font-family: var(--font-display);
  font-weight: 400; font-size: 2.25rem; line-height: 1;
  letter-spacing: -0.02em; font-variant-numeric: tabular-nums;
}
.stat-label { margin-top: 0.35rem; font-size: 0.625rem; letter-spacing: 0.14em; color: var(--fg-ink-soft); }
.stat-note { margin-top: 0.15rem; font-size: 0.75rem; color: var(--fg-ink-soft); }

table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
th {
  text-align: left; font-size: 0.625rem; letter-spacing: 0.14em;
  color: var(--fg-ink-soft); padding: 0.4rem 0;
  border-bottom: 1px solid var(--rule-soft); white-space: nowrap;
}
td { padding: 0.55rem 0; border-bottom: 1px solid var(--rule-soft); font-size: 0.9375rem; }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
.badge { font-size: 0.5625rem; letter-spacing: 0.12em; color: var(--signal); }

a { color: var(--fg-ink); text-decoration-color: var(--rule-soft); text-underline-offset: 3px; }
a:hover { color: var(--signal); text-decoration-color: currentColor; }

:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }

.note {
  margin-top: 2rem; padding-top: 0.75rem;
  border-top: 1px solid var(--rule-soft);
  font-size: 0.8125rem; color: var(--fg-ink-soft); max-width: 52ch;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}`;

/** Everything a Function needs, in the order a stylesheet wants it. */
export const REGISTER = `${FACES}\n${TOKENS}\n${BASE}`;
