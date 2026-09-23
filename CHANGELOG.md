# Changelog

## 1.2.0

### New
- **Source figures.** A new **Figures** button in the paper view (also in the
  right-click menu) downloads the paper's LaTeX source from arXiv and shows every
  figure as a thumbnail, numbered and captioned the way the paper prints them
  (Fig. 2a, 2b… for multi-panel figures). Images the text doesn't place in a
  figure are listed separately.
  - **Save to Downloads**: all figures or only the selected ones go to
    `~/Downloads/<arXiv id>_figures/`, with file names prefixed `Fig03a_…`.
  - **Keep in library**: stores the figures next to your PDFs for offline use.
    Settings shows the space they use and can delete them. Figures you only
    view stay in a temp folder that is cleared after a week.
  - PDF, PNG, JPG and SVG figures get previews. EPS/PS figures save and open
    normally but have no preview. Figures drawn in LaTeX (TikZ, code listings)
    are listed with their captions but have no image file.
  - Papers submitted to arXiv as a PDF only have no source, and the panel says so.

### Fixes
- **Ctrl +/- (and Settings → font size) now scales the whole app.** Dialogs,
  Settings, the Figures panel, right-click menus and toasts used to stay at 100%
  while only the main layout zoomed. The app now uses the webview's native zoom,
  so everything scales together and text stays sharp. The saved zoom is applied
  before the window first paints.
- When zoomed in on a smaller window, the sidebar and paper list narrow a little
  instead of squeezing the abstract pane to a sliver. Dragging a divider starts
  from the width you see.

## 1.1.0

### Fixes
- **Notes are no longer wiped** when a saved paper is saved again from search
  results (adding it to a collection from the search list, dragging it onto a tag,
  or downloading its PDF). The re-save used to overwrite the note with an empty one.
- **Restoring a backup no longer drops links.** Import used `INSERT OR REPLACE`,
  which (with foreign keys on) deleted and re-created collections and tags,
  silently removing paper↔collection / paper↔tag links that weren't in the backup
  and resetting archived flags and sidebar order. It now uses upserts inside a
  single transaction, and merges tags that share a name.
- **Backups now include the bibliography** (entries, folders, tags). Older backup
  files still import.
- **Settings import restores everything**: saved searches, font size/family and the
  history preference were previously ignored.
- **PDF downloads are validated.** Downloads stream to a temporary file and are only
  kept if they're actually a PDF. A dropped connection or an HTML error page used
  to be cached as the paper's PDF permanently.
- Network requests now have timeouts and reuse one connection pool (previously a
  stalled server could leave the UI waiting forever).
- Citation lookups for old-style arXiv ids containing a `v` (e.g. `solv-int/…`)
  were truncated; version suffixes are now stripped correctly.
- Library cards showed the *publication* date labelled as "Added"; they now show
  the real date the paper was added.
- The search query box was squeezed to ~40px at the default window size; it now
  gets its own full-width row.
- Selecting a paper in History wiped the History list; it no longer does, and the
  paper's full abstract is fetched.
- Main search and saved searches shared paging state, so "load more" could append
  the wrong query's results. They're now independent, and saved searches load more
  on scroll too.
- Backspace no longer trashes papers while a dialog or Settings is open.
- The Feedback button opens the project's issue tracker instead of github.com.

### New
- **Paste an arXiv id or link** into search (or ⌘/Ctrl-K) to open that paper
  directly: `2401.01234`, `arXiv:2401.01234v2`, `https://arxiv.org/abs/…`,
  `/pdf/…`, old-style `hep-th/9901001`, or several separated by spaces/commas.
- **Result counts**: search and saved-search titles show "50 of 11,004".
- **Citation counts load much faster**: a whole list is fetched in one Semantic
  Scholar batch request instead of one throttled request (≥1.1 s each) per paper,
  so a 50-paper page no longer takes about a minute to fill in. Results are cached
  for 3 days.
- **Undo** for Move to Trash (toast with an Undo button).
- **Author comments** ("12 pages, 4 figures, accepted in PRL") and
  submitted/updated/added dates in the detail pane.
- **Daily Feed "NEW" badges** for papers submitted since your last visit.
- **Smarter library filter**: every word must match somewhere in the title,
  authors, abstract, notes, categories, comments or tags; `#tag` filters by tag.
- **Sort library by citations.**
- **Keyboard**: `/` focus search or filter, `J`/`K` navigate, `S` save,
  `O` open PDF, `A` open arXiv page, ⌘/Ctrl-A select all, `Esc` closes any dialog,
  `Enter` submits the saved-search dialog, and `Esc` or ⌘/Ctrl-Enter finishes
  editing a note.
- Cite menu: copy a plain-text citation or the arXiv link.
- Deleting a non-empty collection asks for confirmation.

### Performance
- Bulk actions (trash, restore, delete, status, add to collection or tag, save
  many) run as one command in one database transaction instead of one IPC call and
  one disk sync per paper.
- SQLite uses WAL mode, and indexes were added for membership, tag and edge lookups.
- Selecting a paper no longer rebuilds the whole list, and re-renders keep the
  scroll position.

### Developer
- Unit tests for the arXiv parser, id handling and database behaviour
  (`cargo test`), plus network smoke tests (`cargo test -- --ignored`).
