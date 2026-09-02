/** Builds the self-contained page. Only the failed-case rows are embedded as
 *  data; the leaderboard is written as markup because nothing filters it. */

import type { ModelView, ViewData } from './view.ts'
import TAGS from './tags.json' with { type: 'json' }

interface TagCopy {
  definition: string
  examples?: string[]
  grading?: string
  /** Explained under the subtitle. The self-evident tags carry no entry on the page. */
  onPage?: boolean
}

const REPO = 'https://github.com/fjmatrix/flight-search-intent-eval'
/** GitHub's mark, from octicons `mark-github`. */
const GITHUB_MARK =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 ' +
  '7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53' +
  '.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08' +
  '-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 ' +
  '2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 ' +
  '8.013 0 0016 8c0-4.42-3.58-8-8-8Z"/></svg>'

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** Escaping `<` is what keeps a `</script>` inside model output from ending the tag. */
const embed = (data: unknown) => JSON.stringify(data).replace(/</g, '\\u003c')

/** Spelled out for the subtitle; a count past the list falls back to digits. */
const NUMBER = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve']
const spell = (n: number) => NUMBER[n] ?? String(n)

const pct = (t: { passed: number; of: number }) => (t.of ? t.passed / t.of : 0)
const status = (rate: number) =>
  rate >= 0.95 ? 'var(--good)' : rate >= 0.8 ? 'var(--warning)' : rate >= 0.5 ? 'var(--serious)' : 'var(--critical)'

/** What each dimension is called on the page, and what it looks at. */
const DIMENSION: Record<string, { name: string; note: string }> = {
  gradeAction: { name: 'action', note: 'search the query or reject it' },
  gradeSearchType: { name: 'search type', note: 'oneway · roundtrip · multi' },
  gradeOrigin: { name: 'origin', note: 'departure locations' },
  gradeDestination: { name: 'destination', note: 'arrival locations' },
  gradeDateRange: { name: 'travel dates', note: 'departure and return' },
  gradeDuration: { name: 'stay length', note: 'nights' },
  gradePassengers: { name: 'passengers', note: 'adults, children, infants' },
  gradeCabin: { name: 'cabin', note: 'cabin class' },
  gradeFilters: { name: 'filters', note: 'stops, price, bags, connections' },
  gradeDateSanity: { name: 'date validity', note: 'no past or out-of-order dates' },
  gradeTripShape: { name: 'trip shape', note: 'leg count, return xor duration' },
}
/** A grader with no entry above is shown as its name, spaced out: gradeFooBar → foo bar. */
const label = (g: string) =>
  DIMENSION[g]?.name ?? g.replace(/^grade/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()

function leaderboardRow(m: ModelView, i: number, v: ViewData, maxScored: number): string {
  const strip = v.graders
    .map((g) => {
      const d = m.dims[g]!
      if (!d.of) return '<i class="sc na" style="--w:8px"></i>'
      const w = (4 + 9 * Math.sqrt(d.of / maxScored)).toFixed(1)
      const h = (4 + 18 * pct(d)).toFixed(1)
      const tip = [label(g), DIMENSION[g]?.note].filter(Boolean).join(' — ')
      return `<i class="sc" style="--w:${w}px;--h:${h}px;--c:${status(pct(d))}" data-tip="${esc(tip)}\n${d.passed}/${d.of} passed · scored on ${d.of} of ${v.calls / v.models.length} calls"></i>`
    })
    .join('')

  const tagCells = v.tags
    .map((t, j) => {
      const s = m.tags[t]!
      const first = j === 0 ? ' first' : ''
      if (!s.of) return `<td class="tag${first}"><div class="tagfig"><b style="color:var(--ink3)">—</b></div></td>`
      return `<td class="tag${first}" data-tip="${esc(t)}\n${s.passed}/${s.of} cases passed every dimension">
        <div class="tagfig${s.of < 20 ? ' thin' : ''}">
          <b style="color:${status(pct(s))}">${(pct(s) * 100).toFixed(0)}%</b>
          <span class="tb"><i style="width:${pct(s) * 100}%;background:${status(pct(s))}"></i></span>
          <em>n=${s.of}</em>
        </div></td>`
    })
    .join('')

  const rate = m.passed / v.total
  const dims = v.graders
    .map((g) => {
      const d = m.dims[g]!
      const note = DIMENSION[g]?.note
      // The fraction's denominator is the scored count, so no column repeats it.
      return `<tr><td class="gname">${esc(label(g))}${note ? ` <em>${esc(note)}</em>` : ''}</td>
        <td class="frac" style="width:auto;color:${d.of ? status(pct(d)) : 'var(--ink3)'}">${d.of ? `${d.passed}/${d.of}` : 'never scored'}</td></tr>`
    })
    .join('')
  const langs = v.langs
    .map((l) => {
      const s = m.langs[l]!
      return `<tr><td class="gname">${esc(l)}</td>
        <td class="frac" style="color:${status(pct(s))}">${s.passed}/${s.of}</td>
        <td class="cov"><span class="cov-bar"><i style="width:${pct(s) * 100}%;background:${status(pct(s))}"></i></span></td>
        <td class="cov-txt">${(pct(s) * 100).toFixed(0)}%</td></tr>`
    })
    .join('')

  return `<tr class="row" tabindex="0" role="button" aria-expanded="false">
    <td class="rank">${i + 1}</td>
    <td class="mdl"><b>${esc(m.model)}</b>${m.effort ? `<span>${esc(m.effort)}</span>` : ''}</td>
    <td><div class="rate">
      <span class="pct">${(rate * 100).toFixed(0)}%</span>
      <span class="of">${m.passed}/${v.total}</span>
      <span class="bar"><i style="width:${rate * 100}%;background:${status(rate)}"></i></span>
    </div></td>
    <td><div class="strip">${strip}</div></td>
    ${tagCells}
    <td class="num" style="border-left:2px solid var(--rule2)${m.errors ? ';color:var(--warning);font-weight:600' : ''}">${m.errors || '—'}</td>
    <td class="chev"><i>▸</i></td>
  </tr>
  <tr class="panel" hidden><td colspan="${6 + v.tags.length}"><div class="panel-in">
    <div><h3>Per-dimension <em>pass rate over the repeats that scored it</em></h3>
      <table class="dims">${dims}</table></div>
    <div><h3>Cost &amp; latency</h3>
      <table class="dims">
        <tr><td class="gname">tokens in / out / reasoning<br><em>mean per call</em></td><td class="frac" style="width:auto">${m.usage.input} / ${m.usage.output} / ${m.usage.reasoning}</td></tr>
        <tr><td class="gname">total tokens</td><td class="frac" style="width:auto">${(m.tokens / 1000).toFixed(0)}k</td></tr>
        <tr><td class="gname">total cost</td><td class="frac" style="width:auto">${m.cost === null ? '<span style="color:var(--ink3)">no price set</span>' : `$${m.cost.toFixed(2)}`}</td></tr>
        <tr><td class="gname">cost per case</td><td class="frac" style="width:auto">${m.cost === null ? '<span style="color:var(--ink3)">—</span>' : `$${(m.cost / v.total).toFixed(4)}`}</td></tr>
        <tr><td class="gname">median latency</td><td class="frac" style="width:auto">${(m.latencyP50 / 1000).toFixed(1)}s</td></tr>
        <tr><td class="gname">errored calls</td><td class="frac" style="width:auto;color:${m.errors ? 'var(--warning)' : 'inherit'}">${m.errors}</td></tr>
      </table>
      <h3 class="mt">By language</h3><table class="dims">${langs}</table></div>
  </div></td></tr>`
}

/** The tag's own copy, for the column header's tooltip. */
function tagTip(t: string): string {
  const copy = (TAGS as Record<string, TagCopy>)[t]
  return copy ? `${t}\n${copy.definition}` : t
}

/**
 * The two tags whose column headers do not speak for themselves. Every other tag
 * is left to its header tooltip; a tag the run never used is left out.
 */
function tagLegend(v: ViewData): string {
  const rows = v.tags
    .map((t) => [t, (TAGS as Record<string, TagCopy>)[t]] as const)
    .filter(([, copy]) => copy?.onPage)
    .map(([t, copy]) => {
      const examples = (copy!.examples ?? []).map((e) => `<i>“${esc(e)}”</i>`).join(', ')
      return `<dt>${esc(t)}</dt><dd>${esc(copy!.definition)}${examples ? `: ${examples}` : ''}.${
        copy!.grading ? ` <em>${esc(copy!.grading)}</em>` : ''
      }</dd>`
    })
    .join('')
  if (!rows) return ''
  return `<div class="lg tagdefs">
    <h3>Tag columns <em>hover a header for its definition</em></h3>
    <dl>${rows}</dl></div>`
}

export function page(v: ViewData): string {
  const maxScored = Math.max(1, ...v.models.flatMap((m) => v.graders.map((g) => m.dims[g]!.of)))
  const labels = Object.fromEntries(v.graders.map((g) => [g, label(g)]))

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Flight Search Eval · ${esc(v.runId)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>${CSS}</style></head><body>
<div id="tip"></div>
<div class="wrap">
<header class="mast">
  <div class="mast-top">
    <h1>Flight Search Eval</h1>
    <a class="repo" href="${REPO}" target="_blank" rel="noreferrer">${GITHUB_MARK}<span>${esc(REPO.replace(/^https:\/\/github\.com\//, ''))}</span></a>
  </div>
  <p class="sub">A benchmark for flight-search intent parsing. Real-world queries in three
    languages — deduped, de-identified, hand-labeled — put to every model on the same terms;
    ${spell(v.graders.length)} independent graders decide whether each one caught the traveler's intent.</p>
</header>

<dl class="meta">
  <div><dt>Run</dt><dd>${esc(v.runId)}</dd></div>
  <div><dt>Anchor date</dt><dd>${esc(v.today)}</dd></div>
  <div><dt>Cases</dt><dd>${v.total}</dd></div>
  <div><dt>Languages</dt><dd>${v.langs.map(esc).join(' · ')}</dd></div>
  <div><dt>Prompt</dt><dd>${esc(v.prompt)}</dd></div>
  <div><dt>Repeats</dt><dd>${v.repeats}</dd></div>
  <div><dt>Models</dt><dd>${v.models.length}</dd></div>
  <div><dt>Calls</dt><dd>${v.calls.toLocaleString()}</dd></div>
  <div><dt>Fuzzy text similarity</dt><dd>cosine · threshold ≥ ${v.grading.similarity_threshold} · ${esc(v.grading.embedding_model)}</dd></div>
</dl>

<section>
  <h2>Leaderboard</h2>
  <div class="scroll"><table class="lb">
    <thead><tr><th></th><th>Model</th><th>Cases passed</th><th style="min-width:196px">Dimensions</th>
      ${v.tags.map((t, i) => `<th class="tg${i === 0 ? ' first' : ''}" data-tip="${esc(tagTip(t))}">${esc(t)}</th>`).join('')}
      <th class="num" style="border-left:2px solid var(--rule2)">Errors</th><th></th></tr></thead>
    <tbody>${v.models.map((m, i) => leaderboardRow(m, i, v, maxScored)).join('')}</tbody>
  </table></div>
  <div class="legend">
    <div class="lg">
    <h3>Dimension strip &amp; tag columns — pass rate</h3>
    <ul>
      <li><i class="swatch" style="--c:var(--good);height:18px"></i><span>95%+</span></li>
      <li><i class="swatch" style="--c:var(--warning);height:14px"></i><span>80–95%</span></li>
      <li><i class="swatch" style="--c:var(--serious);height:9px"></i><span>50–80%</span></li>
      <li><i class="swatch" style="--c:var(--critical);height:4px"></i><span>under 50%</span></li>
      <li><i class="swatch na" style="width:14px"></i><span>never scored</span></li>
    </ul></div>
    ${tagLegend(v)}
  </div>
</section>

<section>
  <h2>Failed cases by tags</h2>
  <div class="controls">
    <span class="lbl">Language</span>
    <div class="grp" id="f-lang">
      <button data-v="all" aria-pressed="true">all</button>
      ${v.langs.map((l) => `<button data-v="${esc(l)}" aria-pressed="false">${esc(l)}</button>`).join('')}
    </div>
    <span class="note" id="lang-note"></span>
  </div>
  <div class="scroll"><table class="fl">
    <thead><tr><th></th><th>Model</th><th>Failed cases</th><th class="num">Errored calls</th>
      <th>Where the failures sit</th><th></th></tr></thead>
    <tbody id="fl-body"></tbody>
  </table></div>
</section>
</div>

<script type="application/json" id="data">${embed({
    models: v.models.map((m) => ({
      key: m.key,
      model: m.model,
      id: m.effort ?? '',
    })),
    fails: v.fails,
    total: v.total,
    countByLang: v.countByLang,
    labels,
  })}</script>
<script>${CLIENT}</script>
</body></html>`
}

const CSS = `
:root{--paper:#ECEEE9;--card:#FBFCFA;--sunk:#E3E6DF;--ink:#1A1E20;--ink2:#5A6159;--ink3:#858C82;
--rule:#D3D8CE;--rule2:#C0C6BA;--accent:#1B5A7A;--accent-soft:#DCE8EE;--on-accent:#FBFCFA;
--good:#0ca30c;--warning:#fab219;--serious:#ec835a;--critical:#d03b3b;--na:#C7CCC2;
--f-disp:"Archivo","Helvetica Neue",Arial,sans-serif;--f-body:"IBM Plex Sans","Helvetica Neue",Arial,sans-serif;
--f-mono:"IBM Plex Mono","SF Mono",Menlo,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--paper:#15181A;--card:#1D2124;--sunk:#23282B;
--ink:#E6E9E4;--ink2:#9AA39C;--ink3:#6E766D;--rule:#2C3237;--rule2:#3A4147;--accent:#6FB3D6;
--accent-soft:#1E3742;--on-accent:#0E1417;--na:#39403C}}
:root[data-theme="dark"]{--paper:#15181A;--card:#1D2124;--sunk:#23282B;--ink:#E6E9E4;--ink2:#9AA39C;
--ink3:#6E766D;--rule:#2C3237;--rule2:#3A4147;--accent:#6FB3D6;--accent-soft:#1E3742;--on-accent:#0E1417;--na:#39403C}
*{box-sizing:border-box}
body{background:var(--paper);color:var(--ink);font-family:var(--f-body);font-size:14px;line-height:1.5;
margin:0;padding:0 20px 96px;-webkit-font-smoothing:antialiased}
.wrap{max-width:1280px;margin:0 auto}
h1,h2,h3{font-family:var(--f-disp);text-wrap:balance;margin:0}
.mono{font-family:var(--f-mono)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
header.mast{padding:34px 0 18px;border-bottom:2px solid var(--ink)}
h1{font-size:31px;font-weight:800;letter-spacing:-.022em;line-height:1.05}
.mast-top{display:flex;justify-content:space-between;align-items:baseline;gap:20px;flex-wrap:wrap}
.repo{display:inline-flex;align-items:center;gap:7px;font-family:var(--f-mono);font-size:12px;
color:var(--ink2);text-decoration:none;border:1px solid var(--rule2);padding:5px 9px}
.repo:hover{color:var(--accent);border-color:var(--accent)}
.repo svg{width:15px;height:15px;fill:currentColor;flex:none;align-self:center}
/* Capped measure: the sentence runs to about 90 characters a line rather than the full 1280px. */
.sub{margin:14px 0 0;color:var(--ink);font-size:16px;line-height:1.65;max-width:78ch}
.meta{display:flex;flex-wrap:wrap;margin:0;border-bottom:1px solid var(--rule)}
.meta div{padding:11px 20px 11px 0;margin-right:20px;border-right:1px solid var(--rule);display:flex;flex-direction:column;gap:2px}
.meta div:last-child{border-right:0}
.meta dt{font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--ink3);font-weight:500}
.meta dd{margin:0;font-family:var(--f-mono);font-size:13px;font-weight:500}
section{margin-top:46px}
h2{font-size:22px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;margin-bottom:12px}
.scroll{overflow-x:auto;border-bottom:1px solid var(--rule)}
table{border-collapse:collapse;width:100%;font-size:13px}
thead th{font-size:10px;letter-spacing:.08em;text-transform:uppercase;font-weight:600;color:var(--ink3);
text-align:left;padding:9px 10px;border-bottom:1px solid var(--rule2);white-space:nowrap}
thead th.num{text-align:right}
thead th.tg{text-align:center;padding:9px 6px;border-left:1px solid var(--rule)}
thead th.tg.first{border-left:2px solid var(--rule2)}
td{padding:0 10px;border-bottom:1px solid var(--rule);vertical-align:middle}
td.num{text-align:right;font-family:var(--f-mono);font-variant-numeric:tabular-nums}
tbody tr.row{cursor:pointer;background:var(--card)}
tbody tr.row:hover{background:var(--accent-soft)}
.lb tbody tr.row td{height:64px}
.rank{font-family:var(--f-mono);font-size:12px;color:var(--ink3);width:34px}
/* Nowrap keeps the effort beside the name; a long name widens the column instead of wrapping. */
.mdl{min-width:180px;white-space:nowrap}
.mdl b{font-family:var(--f-mono);font-size:13.5px;font-weight:600}
.mdl span{font-family:var(--f-mono);font-size:10.5px;color:var(--ink3);margin-left:7px}
.rate{display:flex;align-items:center;gap:9px;min-width:158px}
.rate .pct{font-family:var(--f-disp);font-size:19px;font-weight:700;width:50px;text-align:right;font-variant-numeric:tabular-nums}
.rate .of{font-family:var(--f-mono);font-size:11px;color:var(--ink3);white-space:nowrap}
.bar{height:7px;flex:1;min-width:48px;background:var(--sunk);position:relative}
.bar i{position:absolute;left:0;top:0;bottom:0;border-radius:0 2px 2px 0}
.strip{display:flex;align-items:flex-end;gap:3px;height:26px}
.strip .sc{width:var(--w);height:var(--h);background:var(--c);border-radius:1px 1px 0 0}
.strip .sc.na{background:var(--na);height:2px}
td.tag{border-left:1px solid var(--rule);padding:0 8px;width:82px}
td.tag.first{border-left:2px solid var(--rule2)}
.tagfig{display:flex;flex-direction:column;gap:3px}
.tagfig b{font-family:var(--f-mono);font-variant-numeric:tabular-nums;font-size:13px;font-weight:600;text-align:right}
.tagfig .tb{height:4px;background:var(--sunk);position:relative}
.tagfig .tb i{position:absolute;inset:0 auto 0 0}
.tagfig em{font-style:normal;font-family:var(--f-mono);font-size:9.5px;color:var(--ink3);text-align:right}
.tagfig.thin em{color:var(--warning);font-weight:600}
.chev{width:26px;text-align:center;color:var(--ink3);font-size:11px}
tr.row[aria-expanded="true"] .chev{color:var(--accent)}
tr.row .chev i{display:inline-block;transition:transform .12s ease;font-style:normal}
tr.row[aria-expanded="true"] .chev i{transform:rotate(90deg)}
tr.panel>td{padding:0;border-bottom:2px solid var(--rule2);background:var(--sunk)}
.panel-in{padding:20px 22px 24px;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:34px}
.panel-in.wide{display:block}
@media (max-width:920px){.panel-in{grid-template-columns:1fr;gap:24px}}
.panel-in h3{font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink3);font-weight:600;
margin-bottom:10px;font-family:var(--f-body)}
.panel-in h3.mt{margin-top:24px}
.panel-in h3 em{font-style:normal;text-transform:none;letter-spacing:0;font-weight:400;margin-left:8px}
table.dims{font-size:12.5px}
table.dims td{border-bottom:1px solid var(--rule);height:31px}
table.dims tr:last-child td{border-bottom:0}
.gname{font-family:var(--f-mono);font-size:12px}
.gname em{font-style:normal;color:var(--ink3);font-family:var(--f-body);font-size:11px}
.frac{font-family:var(--f-mono);font-variant-numeric:tabular-nums;text-align:right;width:66px;font-weight:500}
.cov{width:96px}
.cov-bar{height:5px;background:var(--rule);position:relative}
.cov-bar i{position:absolute;inset:0 auto 0 0;background:var(--ink3)}
.cov-txt{font-family:var(--f-mono);font-size:10.5px;color:var(--ink3);white-space:nowrap;padding-left:8px}
.controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:14px 0 12px}
.controls .grp{display:flex;border:1px solid var(--rule2);background:var(--card)}
.controls button{font-family:var(--f-mono);font-size:11px;background:none;border:0;border-right:1px solid var(--rule2);
padding:6px 13px;color:var(--ink2);cursor:pointer}
.controls button:last-child{border-right:0}
.controls button[aria-pressed="true"]{background:var(--accent);color:var(--on-accent)}
.controls .lbl{font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;color:var(--ink3);font-weight:500}
.controls .note{font-family:var(--f-mono);font-size:11px;color:var(--ink3);margin-left:6px}
.fl tbody tr.row td{height:58px}
.failcount{display:flex;align-items:center;gap:9px;min-width:180px}
.failcount .n{font-family:var(--f-disp);font-size:19px;font-weight:700;width:38px;text-align:right;font-variant-numeric:tabular-nums}
.failcount .of{font-family:var(--f-mono);font-size:11px;color:var(--ink3);white-space:nowrap}
.sits{display:flex;gap:5px;flex-wrap:wrap;max-width:36ch}
.sits span{font-family:var(--f-mono);font-size:10px;padding:2px 6px;border:1px solid var(--rule2);color:var(--ink2);white-space:nowrap}
.sits span b{color:var(--ink);font-weight:600;margin-left:4px}
.fails{width:100%;font-size:12px}
.fails th{font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink3);text-align:left;
padding:7px 14px 7px 0;border-bottom:1px solid var(--rule2);font-weight:600}
.fails td{padding:10px 14px 10px 0;border-bottom:1px solid var(--rule);vertical-align:top}
.fails tr:last-child td{border-bottom:0}
.fails .cid{font-family:var(--f-mono);font-size:11.5px;white-space:nowrap}
.lang{font-family:var(--f-mono);font-size:9.5px;padding:1px 4px;border:1px solid var(--rule2);color:var(--ink3);margin-left:6px}
.qt{font-size:12px;min-width:20ch;max-width:28ch}
.chips{display:flex;gap:4px;flex-wrap:wrap;max-width:16ch}
.chips span{font-family:var(--f-mono);font-size:9.5px;padding:1px 5px;border:1px solid var(--rule2);color:var(--ink2);white-space:nowrap}
/* Fixed side tracks and one shared gap: the header sits in the same grid as every row below it. */
.diff{display:grid;grid-template-columns:96px minmax(0,1fr) 12px minmax(0,1fr);gap:7px 12px;align-items:baseline;min-width:52ch}
.dhead{min-width:0}
.gtag{font-family:var(--f-mono);font-size:10.5px;color:var(--critical);line-height:1.5}
.gtag.err{color:var(--warning)}
.diff .exp{font-family:var(--f-mono);font-size:11px;color:var(--ink2);line-height:1.5}
.diff .arw{color:var(--ink3);font-size:11px}
.diff .got{font-family:var(--f-mono);font-size:11px;color:var(--critical);line-height:1.5}
.diff .full{grid-column:2/-1;font-family:var(--f-mono);font-size:11px;color:var(--warning)}
.faillist:not(.show-all) tr.extra{display:none}
.showall{font-family:var(--f-mono);font-size:11.5px;color:var(--accent);background:none;border:0;cursor:pointer;
text-decoration:underline;padding:12px 2px 0}
.clean{color:var(--ink3);font-size:12.5px;font-style:italic}
.legend{display:flex;gap:32px;flex-wrap:wrap;padding:18px 0 0;border-top:1px solid var(--rule);margin-top:14px}
.lg{display:flex;flex-direction:column;gap:7px}
.lg h3{font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink3);font-weight:600;font-family:var(--f-body)}
.lg h3 em{font-style:normal;text-transform:none;letter-spacing:0;font-weight:400;margin-left:9px}
.tagdefs{flex:1 1 44ch;min-width:0;gap:9px}
.tagdefs dl{margin:0;display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 14px}
.tagdefs dt{font-family:var(--f-mono);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;
color:var(--ink);font-weight:600;white-space:nowrap;padding-top:1px}
.tagdefs dd{margin:0;color:var(--ink2);font-size:12.5px;line-height:1.55}
.tagdefs dd i{font-style:normal;font-family:var(--f-mono);font-size:11.5px;color:var(--ink)}
.tagdefs dd em{font-style:normal;color:var(--ink3)}
.lg ul{list-style:none;margin:0;padding:0;display:flex;gap:14px;flex-wrap:wrap}
.lg li{display:flex;align-items:flex-end;gap:6px;font-size:11.5px;color:var(--ink2)}
.lg .swatch{width:6px;background:var(--c);border-radius:1px 1px 0 0}
.lg .swatch.na{background:var(--na);height:2px}
.lg li span{line-height:1.1}
#tip{position:fixed;z-index:50;pointer-events:none;opacity:0;transition:opacity .08s;background:var(--ink);
color:var(--paper);font-family:var(--f-mono);font-size:11px;padding:6px 9px;line-height:1.5;white-space:pre-wrap;max-width:340px}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`

const CLIENT = String.raw`
const D = JSON.parse(document.getElementById('data').textContent)
const CAP = 12
let lang = 'all'
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
const status = r => r >= .95 ? 'var(--good)' : r >= .8 ? 'var(--warning)' : r >= .5 ? 'var(--serious)' : 'var(--critical)'

function render() {
  const total = lang === 'all' ? D.total : (D.countByLang[lang] || 0)
  document.getElementById('lang-note').textContent =
    lang === 'all' ? total + ' cases · all languages' : total + ' ' + lang + ' cases'

  document.getElementById('fl-body').innerHTML = D.models.map((m, i) => {
    const model = m.model
    // Keyed by the results file, not the model name: one run holds the same
    // model at several efforts, and each row shows only its own failures.
    const rows = D.fails.filter(f => f.key === m.key && (lang === 'all' || f.lang === lang))
      .sort((a, b) => (a.errored - b.errored) || (b.missed.length - a.missed.length))
    const errN = rows.filter(f => f.errored).length
    const share = total ? rows.length / total : 0
    const counts = {}
    rows.forEach(f => f.tags.forEach(t => counts[t] = (counts[t] || 0) + 1))
    const sits = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([t, n]) => '<span>' + esc(t) + '<b>' + n + '</b></span>').join('')
      || '<span style="border:0;padding-left:0">—</span>'
    return '<tr class="row" tabindex="0" role="button" aria-expanded="false">' +
      '<td class="rank">' + (i + 1) + '</td>' +
      '<td class="mdl"><b>' + esc(model) + '</b>' + (m.id ? '<span>' + esc(m.id) + '</span>' : '') + '</td>' +
      '<td><div class="failcount"><span class="n" style="color:' + status(1 - share) + '">' + rows.length + '</span>' +
      '<span class="of">of ' + total + '</span>' +
      '<span class="bar"><i style="width:' + (share * 100).toFixed(1) + '%;background:' + status(1 - share) + '"></i></span></div></td>' +
      '<td class="num"' + (errN ? ' style="color:var(--warning);font-weight:600"' : '') + '>' + (errN || '—') + '</td>' +
      '<td><div class="sits">' + sits + '</div></td>' +
      '<td class="chev"><i>▸</i></td></tr>' +
      '<tr class="panel" hidden><td colspan="6"><div class="panel-in wide">' + panel(rows) + '</div></td></tr>'
  }).join('')
}

function panel(rows) {
  if (!rows.length) return '<p class="clean">Every case passed every applicable dimension.</p>'
  const body = rows.map((f, i) => {
    const diff = (f.errored ? '<span class="gtag err">error</span><span class="full">a call produced no grades</span>' : '') +
      f.missed.map(m =>
        '<span class="gtag">' + esc(D.labels[m.grader] || m.grader) + '</span>' +
        '<span class="exp">' + esc(m.exp) + '</span><span class="arw">→</span>' +
        '<span class="got">' + esc(m.got) + '</span>').join('')
    return '<tr class="' + (i >= CAP ? 'extra' : '') + '">' +
      '<td class="cid">' + esc(f.id) + '<span class="lang">' + esc(f.lang) + '</span></td>' +
      '<td class="qt">' + esc(f.text) + '</td>' +
      '<td><div class="chips">' + f.tags.map(t => '<span>' + esc(t) + '</span>').join('') + '</div></td>' +
      '<td><div class="diff">' + diff + '</div></td></tr>'
  }).join('')
  return '<div class="faillist"><table class="fails">' +
    '<thead><tr><th>Case</th><th>Query</th><th>Tags</th>' +
    '<th><div class="diff dhead"><span>Missed</span><span>Expected</span><span></span><span>Returned</span></div></th>' +
    '</tr></thead>' +
    '<tbody>' + body + '</tbody></table>' +
    (rows.length > CAP ? '<button class="showall">show all ' + rows.length + ' failed cases</button>' : '') + '</div>'
}
render()

document.addEventListener('click', e => {
  const btn = e.target.closest('.controls button')
  if (btn) {
    ;[...btn.parentElement.children].forEach(b => b.setAttribute('aria-pressed', String(b === btn)))
    lang = btn.dataset.v
    render()
    return
  }
  const sa = e.target.closest('.showall')
  if (sa) {
    const list = sa.closest('.faillist')
    const on = list.classList.toggle('show-all')
    const n = list.querySelectorAll('.fails tbody tr').length
    sa.textContent = on ? 'show first ' + CAP + ' only' : 'show all ' + n + ' failed cases'
    return
  }
  const row = e.target.closest('tr.row')
  if (row) toggle(row)
})
document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('row')) {
    e.preventDefault()
    toggle(e.target)
  }
})
function toggle(row) {
  const open = row.getAttribute('aria-expanded') === 'true'
  row.setAttribute('aria-expanded', String(!open))
  row.nextElementSibling.hidden = open
}

const tip = document.getElementById('tip')
document.addEventListener('mouseover', e => {
  const t = e.target.closest('[data-tip]')
  if (!t) { tip.style.opacity = 0; return }
  tip.textContent = t.dataset.tip
  tip.style.opacity = 1
  const r = t.getBoundingClientRect()
  tip.style.left = Math.min(Math.max(8, r.left), window.innerWidth - tip.offsetWidth - 12) + 'px'
  tip.style.top = (r.top - tip.offsetHeight - 8 < 8 ? r.bottom + 8 : r.top - tip.offsetHeight - 8) + 'px'
})
document.addEventListener('mouseout', e => {
  if (!e.relatedTarget || !e.relatedTarget.closest('[data-tip]')) tip.style.opacity = 0
})
`
