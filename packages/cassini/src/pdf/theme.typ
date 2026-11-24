// ============================================================================
// @titan-lang/cassini/pdf/theme.typ — Cassini Observatory Monograph Stylesheet
//
// Bringhurst hanging grid, Source Serif 4 optical Display Regular + body prose,
// IBM Plex Sans Booktabs tables & kickers, IBM Plex Mono (ligatures off) with
// 6-voice archival `cassini-print` syntax highlighting.
//
// Trim: 7 × 9.25 in (177.8 × 235 mm) — prints at 100% scale on A4 & US Letter.
// Grid: Symmetric 19.5 mm outer frame (138.8 mm live structural rail);
//       16 mm (~3.8 picas) hanging left gutter -> 122.8 mm prose column
//       (71–77 chars/line at 10.2 pt Source Serif 4 on 14.43 pt baseline).
//
// Required fonts in --font-path (packages/cassini/src/fonts/typst, SIL OFL 1.1):
//   - Source Serif 4 (Regular, Italic, Semibold, SemiboldIt, Bold, BoldIt)
//   - Source Serif 4 Display (Regular, Italic, Semibold, Bold)
//   - Source Serif 4 Subhead (Regular, Semibold, Bold)
//   - Source Serif 4 Caption (Regular, Italic)
//   - IBM Plex Sans (Regular, Italic, Medium, MediumItalic, SemiBold, Bold)
//   - IBM Plex Mono (Regular, Italic, Medium, SemiBold, Bold)
// ============================================================================

// --- Color Palette: Cassini Print (All foregrounds >= 6.41:1 on PDF) --------
#let c-obsidian     = rgb("#080a07")  // Cover background (titan-lang.dev void)
#let c-cover-rule   = rgb("#2a2d22")  // Subtle cover colophon divider
#let c-cover-gold   = rgb("#e2d898")  // Saturnian gold (cover accent)
#let c-cover-cream  = rgb("#f4edc4")  // Sunlit cream (cover title)
#let c-cover-ochre  = rgb("#b9ad6b")  // Titan ochre (cover kicker)
#let c-cover-muted  = rgb("#c0ba9f")  // Cover subtitle

#let c-ink          = rgb("#1b1d18")  // Warm archival iron-gall ink (17.00:1)
#let c-ink-sub      = rgb("#2d2e27")  // Secondary heading & callout ink
#let c-ink-muted    = rgb("#585549")  // Running headers, folios, captions (7.47:1)
#let c-brass        = rgb("#73540a")  // Deep antique brass: kickers, internal links (7.00:1)
#let c-brass-rule   = rgb("#9a7d34")  // Structural accent bars & rails
#let c-brass-soft   = rgb("#cfc39b")  // Subtle decorative hairlines
#let c-ext-link     = rgb("#1c5463")  // Deep observatory slate-teal: external links (8.41:1)

#let c-paper-code   = rgb("#f7f5ee")  // Whisper-light cotton-rag tint for code blocks
#let c-rule-light   = rgb("#e2dccb")  // Soft horizontal hairlines
#let c-rule-strong  = rgb("#24241e")  // Booktabs top/bottom rules

// --- Layout Constants (Symmetric 19.5mm outer frame; 16mm hanging rail) -----
#let m-outer        = 19.5mm
#let m-hang         = 16mm            // ~45.4pt (~3.8 picas) hanging spine
#let m-prose-left   = m-outer + m-hang // 35.5mm -> 122.8mm prose measure
#let m-code-rail    = 3.2mm           // Rail + inset hang so code col 1 aligns to 19.5mm
#let s-duplex       = state("cassini-duplex", false)

// --- Verified Typst Font Family Constants (IBM Plex Sans fallback eliminates Libertinus on ↔)
#let f-display      = ("Source Serif 4 Display", "IBM Plex Sans")
#let f-subhead      = ("Source Serif 4 Subhead", "IBM Plex Sans")
#let f-serif        = ("Source Serif 4", "IBM Plex Sans")
#let f-caption      = ("Source Serif 4 Caption", "IBM Plex Sans")
#let f-sans         = "IBM Plex Sans"
#let f-sans-med     = "IBM Plex Sans Medm"
#let f-sans-semi    = "IBM Plex Sans SmBld"
#let f-mono         = ("IBM Plex Mono", "IBM Plex Sans")
#let f-mono-med     = ("IBM Plex Mono Medm", "IBM Plex Sans Medm")
#let f-mono-semi    = ("IBM Plex Mono SmBld", "IBM Plex Sans SmBld")

// --- Metadata Markers (pure query-based, zero mutable-state drift) ----------
#let suppress-header-here() = [#metadata("suppress-head") <cassini-no-head>]

// Helper to outdent full-width structural elements to the 19.5mm left rail
#let full-rail(body) = context {
  if s-duplex.get() and calc.odd(here().page()) {
    pad(right: -m-hang, body)
  } else {
    pad(left: -m-hang, body)
  }
}

// --- Signature Motif: Tapered Edge-On Saturn Ring Hairline ------------------
#let ring-rule(width: 100%, thickness: 0.7pt, mode: "print-left") = {
  let grad = if mode == "cover" {
    gradient.linear(c-obsidian, c-cover-ochre, c-cover-cream, c-cover-ochre, c-obsidian)
  } else if mode == "print-center" {
    gradient.linear(white, c-brass-soft, c-brass-rule, c-brass-soft, white)
  } else {
    gradient.linear(c-brass-rule, c-brass-soft, c-rule-light, white)
  }
  line(length: width, stroke: thickness + grad)
}

#let book-rule() = {
  v(0.75em)
  ring-rule(width: 100%, thickness: 0.6pt, mode: "print-center")
  v(0.75em)
}

// --- Shiki Token Helpers (`cassini-print` — 6 Clean Archival Voices) --------
#let t(c, s)    = text(fill: rgb(c), s)
#let tb(c, s)   = text(font: f-mono-semi, fill: rgb(c), s)
#let ti(c, s)   = emph(text(fill: rgb(c), s))
#let tbi(c, s)  = emph(text(font: f-mono-semi, fill: rgb(c), s))

#let tok-kw(s)   = tb("#73540a", s)
#let tok-fn(s)   = t("#1b1d18", s)
#let tok-ty(s)   = t("#18585e", s)
#let tok-str(s)  = t("#2a5c30", s)
#let tok-esc(s)  = t("#8c3b1a", s)
#let tok-num(s)  = t("#8c3b1a", s)
#let tok-self(s) = ti("#8c3b1a", s)
#let tok-op(s)   = t("#1b1d18", s)
#let tok-punc(s) = t("#1b1d18", s)
#let tok-cm(s)   = ti("#585a51", s)

// --- Inline Code (Wash-free archival monospace — exact OS/2 x-height match) -
// SourceSerif4 sxHeight 475/1000 ÷ IBMPlexMono sxHeight 516/1000 = 0.9205em:
//   - 10.2pt serif prose  -> 9.38pt mono
//   -  8.6pt standard tbl -> 7.91pt mono
//   -  8.0pt compact tbl  -> 7.36pt mono
//
// Critic #40.1 & #52.1–2:
//   - `#ic(s)` wraps short prose spans (<= 16 chars) in `#box(...)` so justified
//     prose never stretches spaces or splits short spans.
//   - `#ic-rich[...]` formats longer prose spans and table code using atomic
//     `#ic-seg(...)` boxes (preventing any break after ASCII `-` while keeping
//     pure U+002D in PDF text) separated by non-stretching `#ic-sp` spaces and
//     `#sym.zws` punctuation break points.
#let ic-sp = [#h(0.6em, weak: true)#sym.zws]
#let ic-seg(s) = box(s)

#let ic(s) = box(
  text(
    font: f-mono,
    size: 0.92em,
    fill: rgb("#161914"),
    hyphenate: false,
    features: (liga: 0, calt: 0),
    s,
  ),
)

#let ic-rich(body) = text(
  font: f-mono,
  size: 0.92em,
  fill: rgb("#161914"),
  hyphenate: false,
  features: (liga: 0, calt: 0),
  body,
)

#let ic-table(s) = ic-rich(s)

// --- Code Block Frame (Hanging Optical Rail, 80+ Col Safe @ 8.1pt Mono) -----
// Print-native: NO web chrome bar, NO language pill, NO rounded borders.
// Optional quiet filename caption sits cleanly above the block only when named.
#let codeframe(lang: "", title: "", breakable: true, body) = context {
  let inner = block(width: 100%, above: 1.05em, below: 1.15em, breakable: breakable)[
    #if title != "" [
      #block(below: 3.5pt, sticky: true, inset: (left: m-code-rail))[
        #text(font: f-mono-med, size: 7.4pt, fill: c-ink-muted, title)
      ]
    ]
    #block(
      width: 100%,
      fill: c-paper-code,
      stroke: (left: 1.5pt + c-brass-rule),
      inset: (left: m-code-rail, right: 3pt, top: 6.5pt, bottom: 6.8pt),
      breakable: breakable,
      {
        set text(
          font: f-mono,
          size: 8.1pt,
          fill: c-ink,
          hyphenate: false,
          features: (liga: 0, calt: 0),
        )
        set par(leading: 0.72em, spacing: 0.72em, justify: false)
        body
      },
    )
  ]
  if s-duplex.get() and calc.odd(here().page()) {
    pad(left: -m-code-rail, right: -m-hang, inner)
  } else {
    pad(left: -(m-hang + m-code-rail), inner)
  }
}

// Orphan/widow guards for multi-page code listings (>= 3 lines on each side)
#let code-keep(body) = block(breakable: false, spacing: 0.72em, body)
#let code-flow(body) = block(breakable: true, spacing: 0.72em, body)

// --- Editorial Callout / Blockquote (Fill-Free Print Grammar) ---------------
#let callout(kind: "note", title: none, body) = {
  let bar-color = if kind == "warning" { rgb("#8c3b1a") }
    else if kind == "tip" { rgb("#18585e") }
    else { c-brass-rule }
  let label-text = if title != none { title }
    else if kind == "blockquote" { none }
    else if kind == "warning" { "Warning" }
    else if kind == "tip" { "Tip" }
    else { "Note" }

  block(
    width: 100%,
    stroke: (left: 1.4pt + bar-color),
    inset: (left: 10pt, right: 8pt, top: 2.5pt, bottom: 2.5pt),
    breakable: true,
    above: 1.15em,
    below: 1.25em,
  )[
    #set text(size: 9.6pt, fill: c-ink-sub)
    #set par(leading: 0.74em, spacing: 1.15em)
    #if label-text != none [
      #text(
        font: f-sans-semi,
        size: 7.8pt,
        tracking: 0.08em,
        fill: bar-color,
        upper(label-text),
      )#h(0.45em)#text(fill: c-brass-soft)[—]#h(0.45em)#body
    ] else [
      #body
    ]
  ]
}

// --- Pure Booktabs Tables (2-3 cols in 122.8mm prose; 4-5 cols on 138.8mm rail)
#let book-table(
  columns: auto,
  align: left + top,
  compact: false,
  wide: auto,
  header: (),
  rows: (),
  caption: none,
) = {
  let is-wide = if wide == auto { compact or header.len() >= 4 } else { wide }
  let body-size = if compact { 8.0pt } else { 8.6pt }
  let cell-inset = if compact { (x: 4.5pt, y: 4.2pt) } else { (x: 5.5pt, y: 4.5pt) }

  let tbl = block(width: 100%, above: 1.05em, below: 1.25em, breakable: true)[
    #if caption != none [
      #block(below: 0.5em, sticky: true)[
        #text(font: f-sans-med, size: 8.2pt, fill: c-ink-muted, caption)
      ]
    ]
    #set text(font: f-sans, size: body-size, fill: c-ink, number-width: "tabular")
    #set par(leading: 0.56em, spacing: 0.56em, justify: false)
    #show table.cell.where(y: 0): it => {
      set text(font: f-sans-semi, size: body-size, fill: c-ink)
      it
    }
    #table(
      columns: columns,
      align: align,
      inset: cell-inset,
      fill: none,
      stroke: (_, y) => (
        top: if y == 0 { 1.1pt + c-rule-strong } else if y == 1 { 0.65pt + c-brass-rule } else { 0.35pt + c-rule-light },
        bottom: 1.0pt + c-rule-strong,
        left: none,
        right: none,
      ),
      table.header(..header),
      ..rows.flatten(),
    )
  ]

  if is-wide { full-rail(tbl) } else { tbl }
}

// --- Cover Page (Full-Bleed Cassini Obsidian, Monumental 76mm Saturn Mark) --
#let book-cover(
  title: [The Titan\ Programming Language],
  subtitle: [Tutorial, Language Reference,\ Standard Library, and Toolchain],
  edition: "Version 0.6.1",
  author: "Fabio Mascarenhas and the Titan Contributors",
  url: "https://titan-lang.dev",
  site-label: "titan-lang.dev",
  logo: none,
) = {
  page(
    fill: c-obsidian,
    margin: (x: 20mm, top: 22mm, bottom: 20mm),
    header: none,
    footer: none,
  )[
    #set text(hyphenate: false)
    #set par(justify: false)
    #v(0.8cm)
    #align(center)[
      #if logo != none [
        #logo
        #v(1.15cm)
      ]
      #ring-rule(width: 100%, thickness: 0.85pt, mode: "cover")
      #v(0.95cm)
      #if edition != "" [
        #text(
          font: f-sans-med,
          size: 8.2pt,
          tracking: 0.22em,
          fill: c-cover-ochre,
          upper(edition),
        )
        #v(0.55cm)
      ]
      #block(width: 100%)[
        #set par(leading: 0.28em)
        #text(
          font: f-display,
          size: 36pt,
          weight: "regular",
          tracking: -0.02em,
          fill: c-cover-cream,
          title,
        )
      ]
      #if subtitle != none and subtitle != "" [
        #v(0.6cm)
        #block(width: 88%)[
          #set par(leading: 0.55em)
          #text(
            font: f-serif,
            style: "italic",
            size: 12pt,
            fill: c-cover-muted,
            subtitle,
          )
        ]
      ]
    ]
    #v(1fr)
    #line(length: 100%, stroke: 0.45pt + c-cover-rule)
    #v(0.42cm)
    #grid(
      columns: (1fr, auto),
      align: (left + horizon, right + horizon),
      text(font: f-sans, size: 8.4pt, fill: c-cover-muted, author),
      if url != "" and site-label != "" {
        link(url)[#text(font: f-mono-med, size: 8.2pt, fill: c-cover-gold)[#site-label]]
      } else {
        []
      },
    )
  ]
}

// --- Dedicated Half-Title & Edition Colophon Page (Frontmatter Page i) ------
#let book-colophon(
  title: [The Titan Programming Language],
  subtitle: "Tutorial, Language Reference, Standard Library, and Toolchain",
  edition-note: "Titan 0.6.1 (50 Chapters + Effective Titan Style Guide).",
  author: "Fabio Mascarenhas and the Titan Contributors",
  date-str: "2026",
  copyright-notice: "",
  license: "MIT License",
  repo-url: "https://github.com/mascarenhas/titan",
  repo-label: "github.com/mascarenhas/titan",
  site-url: "https://titan-lang.dev",
  site-label: "titan-lang.dev",
  source-note: "",
) = {
  page(
    margin: (x: m-outer, top: 24mm, bottom: 22mm),
    header: none,
    footer: none,
  )[
    #set par(justify: false)
    #set text(hyphenate: false)
    #v(3.2cm)
    #text(
      font: f-display,
      size: 26pt,
      weight: "regular",
      tracking: -0.018em,
      fill: c-ink,
      title,
    )
    #if subtitle != "" [
      #v(0.35cm)
      #text(font: f-serif, style: "italic", size: 11.2pt, fill: c-ink-muted, subtitle)
    ]
    #v(0.75cm)
    #ring-rule(width: 52mm, thickness: 0.85pt, mode: "print-left")
    #if author != "" [
      #v(0.75cm)
      #text(font: f-sans, size: 9.4pt, fill: c-ink-sub, author)
    ]

    #v(1fr)
    #line(length: 100%, stroke: 0.45pt + c-rule-light)
    #v(0.5cm)
    #set text(font: f-sans, size: 8.2pt, fill: c-ink-muted)
    #set par(leading: 0.65em, spacing: 0.95em)
    #if edition-note != "" [
      #text(font: f-sans-semi, fill: c-ink-sub)[Edition] — #edition-note
    ]

    #text(font: f-sans-semi, fill: c-ink-sub)[Copyright & License] — #if copyright-notice != "" [#copyright-notice. ] else if author != "" [© #date-str #author. ]Released under the #license.#if repo-url != "" [ Canonical source at #link(repo-url)[#repo-label]#if site-url != "" [\; web edition at #link(site-url)[#site-label]].] else if site-url != "" [ Web edition at #link(site-url)[#site-label].]

    #if source-note != "" [
      #text(font: f-sans-semi, fill: c-ink-sub)[Source] — #source-note
    ]

    #text(font: f-sans-semi, fill: c-ink-sub)[Colophon] — Typeset with Typst in #emph[Source Serif 4] (optical Display, Subhead, Text, and Caption masters), #emph[IBM Plex Sans], and #emph[IBM Plex Mono]. Trim size 7 × 9.25 in (177.8 × 235 mm), engineered to print at 100% scale on both international A4 and North American US Letter.
  ]
}

// --- Editorial Table of Contents Page (Symmetric 19.5mm Frame, No Kicker) ---
#let book-toc(title: "Contents", depth: 2) = {
  page(
    margin: (x: m-outer, top: 21mm, bottom: 21mm),
    numbering: "i",
    header: context {
      let cur = here().page()
      let suppressed = query(<cassini-no-head>).any(m => m.location().page() == cur)
      if not suppressed {
        let p = counter(page).get().first()
        let folio = text(font: f-sans-med, style: "normal", size: 8.2pt, fill: c-ink-muted, number-width: "tabular")[
          #counter(page).display()
        ]
        let label = text(font: f-caption, style: "italic", size: 8.2pt, fill: c-ink-muted)[#title]
        if calc.even(p) {
          [#folio #h(1.4em) #label]
        } else {
          [#h(1fr) #label #h(1.4em) #folio]
        }
        v(-0.55em)
        line(length: 100%, stroke: 0.35pt + c-rule-light)
      }
    },
    footer: context {
      let cur = here().page()
      let suppressed = query(<cassini-no-head>).any(m => m.location().page() == cur)
      if suppressed {
        align(right, text(font: f-sans-med, style: "normal", size: 8.2pt, fill: c-ink-muted, number-width: "tabular")[
          #counter(page).display()
        ])
      }
    },
  )[
    #suppress-header-here()
    #set par(justify: false)
    #v(18mm)
    #text(
      font: f-display,
      size: 27pt,
      weight: "regular",
      tracking: -0.018em,
      fill: c-ink,
      title,
    )
    #v(0.55em)
    #ring-rule(width: 100%, thickness: 0.75pt, mode: "print-left")
    #v(1.1em)
    #outline(title: none, depth: depth)
  ]
}

// --- Part Divider Page (Symmetric 19.5mm Frame, House Voice) ----------------
#let part-opener(numeral: "Part I", title: "", summary: "", chapters: ()) = {
  let dense = chapters.len() > 14
  page(
    margin: (x: m-outer, top: 21mm, bottom: 21mm),
    header: none,
    footer: none,
  )[
    // Invisible outlined level-1 heading registers the PDF bookmark & TOC entry
    #place(top + left, hide(heading(level: 1, outlined: true)[#if title != "" [#numeral — #title] else [#numeral]]))
    #set par(justify: false)
    #set text(hyphenate: false)
    #v(if dense { 2.4cm } else { 4.8cm })
    #text(
      font: f-sans-semi,
      size: 8.6pt,
      tracking: 0.2em,
      fill: c-brass,
      upper(numeral),
    )
    #v(0.45cm)
    #ring-rule(width: 58mm, thickness: 1.0pt, mode: "print-left")
    #v(0.6cm)
    #block(width: 90%)[
      #set par(leading: 0.34em)
      #text(
        font: f-display,
        size: 28pt,
        weight: "regular",
        tracking: -0.02em,
        fill: c-ink,
        if title != "" { title } else { numeral },
      )
    ]
    #if summary != "" [
      #v(0.5cm)
      #block(width: 84%)[
        #set par(leading: 0.72em)
        #text(font: f-serif, style: "italic", size: 10.8pt, fill: c-ink-muted, summary)
      ]
    ]

    #if chapters.len() > 0 [
      #v(1fr)
      #line(length: 100%, stroke: 0.45pt + c-rule-light)
      #v(if dense { 0.35cm } else { 0.45cm })
      #text(
        font: f-sans-semi,
        size: 7.4pt,
        tracking: 0.16em,
        fill: c-brass,
        upper("In This Part"),
      )
      #v(if dense { 0.25cm } else { 0.35cm })
      #set text(font: f-sans, size: if dense { 7.8pt } else { 8.2pt }, fill: c-ink-sub, number-width: "tabular")
      #set par(leading: 0.56em)
      #grid(
        columns: (1fr, 1fr),
        column-gutter: 14pt,
        row-gutter: if dense { 3.6pt } else { 5pt },
        ..chapters.map(c => [#if c.at(0) != "" [#text(font: f-mono-med, size: if dense { 7.3pt } else { 7.6pt }, fill: c-brass)[#c.at(0)] #h(0.45em)]#c.at(1)])
      )
      #v(0.25cm)
    ]
  ]
}

// --- Chapter Opener (Inherits Part Voice: 26mm Sink, 27pt Display Regular) --
#let chapter-opener(kicker: "", title: "", lead: none, lbl: none) = {
  pagebreak(weak: true)
  suppress-header-here()
  v(26mm)
  full-rail[
    #block(width: 100%, below: 1.35em, sticky: true)[
      #if kicker != "" [
        #text(
          font: f-sans-semi,
          size: 8.2pt,
          tracking: 0.18em,
          fill: c-brass,
          upper(kicker),
        )
        #v(6pt)
      ]
      #if lbl != none {
        [#heading(level: 2, outlined: true)[#title] #lbl]
      } else {
        heading(level: 2, outlined: true)[#title]
      }
      #v(0.6em)
      #ring-rule(width: 100%, thickness: 0.8pt, mode: "print-left")
    ]
  ]
  if lead != none {
    block(below: 1.35em)[
      #set par(leading: 0.72em, justify: false)
      #text(font: f-serif, style: "italic", size: 11pt, fill: c-ink-muted, lead)
    ]
  }
}

// --- Master Monograph Show Rule (`#show: titan-book.with(...)`) -------------
#let titan-book(
  title: "The Titan Programming Language",
  author: "Fabio Mascarenhas and the Titan Contributors",
  keywords: ("Titan", "Lua", "Programming Language", "Manual"),
  duplex: false,
  doc,
) = {
  set document(
    title: title,
    author: author,
    keywords: keywords,
  )

  s-duplex.update(duplex)

  // Trim: 7 × 9.25 in (177.8 × 235 mm)
  set page(
    width: 177.8mm,
    height: 235mm,
    margin: if duplex {
      (inside: 22mm, outside: 32mm, top: 21mm, bottom: 21mm)
    } else {
      (left: m-prose-left, right: m-outer, top: 21mm, bottom: 21mm)
    },
    header-ascent: 40%,
    footer-descent: 42%,
    // Bringhurst running head: single title per page + separated outer tabular folio;
    // zero footer watermark on running pages.
    header: context {
      let cur = here().page()
      let suppressed = query(<cassini-no-head>).any(m => m.location().page() == cur)
      if not suppressed {
        let p = counter(page).get().first()
        let prev-ch = query(selector(heading.where(level: 2)).before(here()))
        let ch-title = if prev-ch.len() > 0 { prev-ch.last().body } else { title }
        let folio = text(font: f-sans-med, style: "normal", size: 8.2pt, fill: c-ink-muted, number-width: "tabular")[
          #counter(page).display()
        ]
        full-rail[
          #set text(font: f-caption, style: "italic", size: 8.2pt, fill: c-ink-muted)
          #if calc.even(p) {
            [#folio #h(1.4em) #title]
          } else {
            [#h(1fr) #ch-title #h(1.4em) #folio]
          }
          #v(-0.55em)
          #line(length: 100%, stroke: 0.35pt + c-rule-light)
        ]
      }
    },
    // Chapter opener pages suppress the running head and show ONLY a bare outer folio
    footer: context {
      let cur = here().page()
      let suppressed = query(<cassini-no-head>).any(m => m.location().page() == cur)
      if suppressed {
        let p = counter(page).get().first()
        let folio = text(font: f-sans-med, style: "normal", size: 8.2pt, fill: c-ink-muted, number-width: "tabular")[
          #counter(page).display()
        ]
        full-rail[
          #if calc.even(p) {
            align(left, folio)
          } else {
            align(right, folio)
          }
        ]
      }
    },
  )

  // Body Typography: 10.2pt Source Serif 4 on measured 14.43pt baseline (1.415 ratio)
  set text(
    font: f-serif,
    size: 10.2pt,
    fill: c-ink,
    lang: "en",
    ligatures: true,
    kerning: true,
    number-type: "lining",
    costs: (widow: 150%, orphan: 150%, runt: 120%),
  )
  show raw.where(block: false): it => ic(it.text)
  set par(
    leading: 0.745em,
    spacing: 1.45em,
    justify: true,
    linebreaks: "optimized",
    justification-limits: (
      spacing: (min: 72%, max: 140%),
      tracking: (min: -0.015em, max: 0.03em),
    ),
  )
  set smartquote(enabled: true)
  // Drawn brass square + Source Serif native en-dash: ZERO fallback emoji fonts!
  set list(
    indent: 0.45em,
    body-indent: 0.6em,
    spacing: 0.745em,
    marker: (
      box(baseline: -0.22em, rect(width: 2.8pt, height: 2.8pt, fill: c-brass-rule)),
      text(fill: c-brass-rule)[–],
    ),
  )
  set enum(indent: 0.45em, body-indent: 0.6em, spacing: 0.745em)

  // Links: Antique Brass for internal cross-chapter links, Deep Teal for URLs
  show link: it => {
    if type(it.dest) == label {
      text(fill: c-brass, it)
    } else {
      text(fill: c-ext-link, it)
    }
  }

  // Headings: L1 = Part, L2 = Chapter (Display Regular), L3 = Section (Hangs to Rail),
  // L4 = Subsection (Aligned with Prose), L5 = Minor kicker
  show heading: set text(hyphenate: false)
  show heading: set par(justify: false)

  show heading.where(level: 2): it => {
    set par(leading: 0.30em)
    text(
      font: f-display,
      size: 27pt,
      weight: "regular",
      tracking: -0.02em,
      fill: c-ink,
      it.body,
    )
  }

  show heading.where(level: 3): it => {
    v(1.65em, weak: true)
    full-rail[
      #block(below: 0.6em, sticky: true)[
        #text(
          font: f-subhead,
          size: 13.5pt,
          weight: "semibold",
          tracking: -0.012em,
          fill: c-ink,
          it.body,
        )
      ]
    ]
  }

  show heading.where(level: 4): it => {
    v(1.3em, weak: true)
    block(below: 0.65em, sticky: true)[
      #text(
        font: f-sans-semi,
        size: 10.0pt,
        fill: c-ink-sub,
        it.body,
      )
    ]
  }

  show heading.where(level: 5): it => {
    v(1.15em, weak: true)
    block(below: 0.78em, sticky: true)[
      #text(
        font: f-sans-med,
        size: 8.6pt,
        tracking: 0.06em,
        fill: c-brass,
        upper(it.body),
      )
    ]
  }

  // Editorial Table of Contents: airy 15.23pt chapter baseline
  show outline.entry.where(level: 1): it => {
    v(1.25em, weak: true)
    block(width: 100%, below: 0.45em, stroke: (bottom: 0.4pt + c-rule-light), inset: (bottom: 3.5pt))[
      #link(it.element.location())[
        #text(font: f-sans-semi, size: 8.3pt, tracking: 0.11em, fill: c-brass, upper(it.body()))
        #h(1fr)
        #text(font: f-sans-med, size: 8.3pt, fill: c-ink-muted, number-width: "tabular", it.page())
      ]
    ]
  }

  show outline.entry.where(level: 2): it => {
    block(width: 100%, above: 0pt, below: 0pt, inset: (top: 4.2pt, bottom: 4.2pt))[
      #set par(leading: 0.75em)
      #link(it.element.location())[
        #text(font: f-serif, size: 10.0pt, fill: c-ink, it.body())
        #box(width: 1fr, repeat[#text(fill: rgb("#c2baa3"))[ . ]])
        #h(0.4em)
        #text(font: f-sans, size: 9.0pt, fill: c-ink-muted, number-width: "tabular", it.page())
      ]
    ]
  }

  doc
}
