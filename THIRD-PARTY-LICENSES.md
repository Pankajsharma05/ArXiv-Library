# Third-Party Licenses and Attribution

ArXivLibrary itself is released under the MIT License (see `LICENSE`). It builds
on the following third-party components, each under its own permissive license.
All are compatible with MIT distribution.

## Bundled fonts (redistributed in this repository, under `src/fonts/`)

- **Inter** — © The Inter Project Authors.
  SIL Open Font License 1.1. Full text: `src/fonts/Inter-LICENSE.txt`
- **JetBrains Mono** — © The JetBrains Mono Project Authors.
  SIL Open Font License 1.1. Full text: `src/fonts/JetBrainsMono-LICENSE.txt`

The SIL OFL permits bundling and redistribution provided the license text
accompanies the fonts (it does) and the fonts are not sold on their own.

## Runtime libraries loaded from CDN (not redistributed here)

- **pdf.js** — © Mozilla Foundation. Apache License 2.0.
  Loaded from cdnjs at runtime for optional PDF handling.
- **KaTeX** — © Khan Academy and contributors. MIT License.
  Loaded from cdnjs at runtime to render math in abstracts.

## Rust dependencies (compiled in; fetched by Cargo at build time)

All are dual MIT/Apache-2.0 or MIT licensed:

- tauri, tauri-plugin-opener, tauri-plugin-dialog — MIT/Apache-2.0
- serde, serde_json — MIT/Apache-2.0
- tokio — MIT
- reqwest — MIT/Apache-2.0
- futures-util — MIT/Apache-2.0
- rusqlite (bundles SQLite, public domain) — MIT
- quick-xml — MIT
- chrono — MIT/Apache-2.0
- dirs — MIT/Apache-2.0
- once_cell — MIT/Apache-2.0
- flate2, tar — MIT/Apache-2.0

To regenerate a complete, exact dependency license report, run:

    cargo install cargo-about
    cd src-tauri && cargo about generate about.hbs > ../THIRD-PARTY-RUST.html

## Data sources / APIs

ArXivLibrary queries these public services at runtime. It is not affiliated with
or endorsed by any of them; please respect their terms of use:

- **arXiv API** — https://info.arxiv.org/help/api/
- **Semantic Scholar API** — https://www.semanticscholar.org/product/api
- **Crossref API** — https://www.crossref.org/documentation/retrieve-metadata/rest-api/

Paper metadata and abstracts retrieved via these APIs, and figures extracted
from arXiv source files, remain the property of their respective authors and
publishers.
