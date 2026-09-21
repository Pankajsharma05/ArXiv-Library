// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Pankaj Sharma. See LICENSE.
// Tauri globals (withGlobalTauri enabled).
const { invoke } = window.__TAURI__.core;
const tauriEvent = window.__TAURI__.event;

// Live download progress, keyed by arxiv_id → { received, total, done }.
// A button can subscribe by registering a callback in downloadProgressCbs.
const downloadProgress = {};
const downloadProgressCbs = {};
if (tauriEvent && tauriEvent.listen) {
  tauriEvent.listen("download-progress", (evt) => {
    const p = evt.payload;
    if (!p || !p.arxiv_id) return;
    downloadProgress[p.arxiv_id] = p;
    const cb = downloadProgressCbs[p.arxiv_id];
    if (cb) cb(p);
  });
}
const openUrl = (url) => window.__TAURI__.opener.openUrl(url);
const openPath = (path) => invoke("open_in_default_app", { path });
const dialogSave = (opts) => window.__TAURI__.dialog.save(opts);

// PDF.js loaded lazily so startup never blocks on a CDN.
let pdfjsLib = null;
async function ensurePdfjs() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs");
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs";
  return pdfjsLib;
}

// KaTeX is loaded lazily, and only the first time an abstract actually contains
// math. Papers without "$...$" pay zero cost. Mirrors the pdf.js CDN pattern.
let katexLoading = null;
const KATEX_VER = "0.16.11";
function ensureKatex() {
  if (window.renderMathInElement) return Promise.resolve(true);
  if (katexLoading) return katexLoading;
  katexLoading = new Promise((resolve) => {
    try {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = `https://cdnjs.cloudflare.com/ajax/libs/KaTeX/${KATEX_VER}/katex.min.css`;
      document.head.appendChild(css);
      const core = document.createElement("script");
      core.src = `https://cdnjs.cloudflare.com/ajax/libs/KaTeX/${KATEX_VER}/katex.min.js`;
      core.onload = () => {
        const auto = document.createElement("script");
        auto.src = `https://cdnjs.cloudflare.com/ajax/libs/KaTeX/${KATEX_VER}/contrib/auto-render.min.js`;
        auto.onload = () => resolve(true);
        auto.onerror = () => resolve(false);
        document.head.appendChild(auto);
      };
      core.onerror = () => resolve(false);
      document.head.appendChild(core);
    } catch { resolve(false); }
  });
  return katexLoading;
}

// Heuristic: only typeset if the abstract looks like it contains TeX math.
function hasMath(text) {
  return /\$[^$]+\$|\\\(|\\\[|\\begin\{/.test(text || "");
}

async function typesetAbstractMath(summary) {
  if (!hasMath(summary)) return;
  const ok = await ensureKatex();
  if (!ok || !window.renderMathInElement) return;
  const el = document.getElementById("detail-abstract");
  if (!el) return; // user navigated away while loading
  try {
    window.renderMathInElement(el, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
        { left: "\\(", right: "\\)", display: false },
        { left: "\\[", right: "\\]", display: true },
      ],
      throwOnError: false,
      ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
    });
  } catch {}
}

// ---------- State ----------
const state = {
  papers: [],
  collections: [],
  membership: {},
  edges: [],
  tags: [],
  paperTags: {},   // paperId -> Set(tagId)
  view: { type: "search" },
  searchResults: [],
  selectedPaper: null,
  selectedIds: new Set(),  // multi-select
  lastClickedId: null,     // for shift-range
  libFilter: "",
  libSort: "added",
  libStatus: "",
  density: "normal",
  activeTag: null,
  feedResults: [],
  feedCategories: [],
  feedLoaded: false,
  savedResults: [],   // results for the active saved-search view (isolated from arXiv search)
  metricsCache: {},  // arxiv_id -> metrics
  savedSearches: [],
  savedSearchCache: {},  // id -> { results, paging }
  historyEnabled: true,
  selectedSearchIds: new Set(),
  selectedCollectionIds: new Set(),
  selectedTagIds: new Set(),
  bibFolders: [],
  bibTags: [],
  bibFilter: null,  // { type: "folder"|"tag", id } or null
  selectedBibIds: new Set(),
};

// ---------- Helpers ----------
const $ = (sel) => document.querySelector(sel);
const GRIP_SVG = `<svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true"><g fill="currentColor"><circle cx="2.5" cy="3" r="1.2"/><circle cx="7.5" cy="3" r="1.2"/><circle cx="2.5" cy="8" r="1.2"/><circle cx="7.5" cy="8" r="1.2"/><circle cx="2.5" cy="13" r="1.2"/><circle cx="7.5" cy="13" r="1.2"/></g></svg>`;
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};
const esc = (s) =>
  (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// toast("msg") or toast("msg", { label: "Undo", run: async () => … }).
// An action keeps the toast up longer so there's time to click it.
function toast(msg, action) {
  const t = $("#toast");
  t.textContent = msg;
  if (action) {
    const b = el("button", "toast-action", esc(action.label));
    b.onclick = async () => {
      t.classList.add("hidden");
      try { await action.run(); } catch (err) { toast(String(err)); }
    };
    t.append(b);
  }
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), action ? 6000 : 2400);
}

// Move papers to (or back out of) the trash in one call, with an Undo toast.
async function trashPapers(ids) {
  if (!ids.length) return;
  await invoke("bulk_set_trashed", { ids, trashed: true });
  state.selectedIds.clear();
  if (state.selectedPaper && ids.includes(state.selectedPaper.arxiv_id)) clearDetail();
  await loadLibrary();
  toast(ids.length > 1 ? `${ids.length} moved to Trash` : "Moved to Trash", {
    label: "Undo",
    run: async () => {
      await invoke("bulk_set_trashed", { ids, trashed: false });
      await loadLibrary();
      toast("Restored");
    },
  });
}
async function restorePapers(ids) {
  if (!ids.length) return;
  await invoke("bulk_set_trashed", { ids, trashed: false });
  state.selectedIds.clear();
  await loadLibrary();
  toast(ids.length > 1 ? `${ids.length} restored` : "Restored");
}
async function deletePapersForever(ids) {
  if (!ids.length) return false;
  const ok = await window.__TAURI__.dialog.confirm(
    ids.length > 1 ? `Permanently delete ${ids.length} papers? This cannot be undone.`
                   : "Permanently delete this paper? This cannot be undone.",
    { title: "Delete permanently", kind: "warning" });
  if (!ok) return false;
  await invoke("bulk_delete_papers", { ids });
  state.selectedIds.clear();
  if (state.selectedPaper && ids.includes(state.selectedPaper.arxiv_id)) clearDetail();
  await loadLibrary();
  return true;
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function isSaved(id) {
  return state.papers.some((p) => p.arxiv_id === id);
}
// Saved AND not in trash — i.e. actually present in the library.
function isInLibrary(id) {
  return state.papers.some((p) => p.arxiv_id === id && !p.trashed);
}
function isTrashed(id) {
  return state.papers.some((p) => p.arxiv_id === id && p.trashed);
}

// ---------- Theme ----------
const DEFAULT_ACCENT = { dark: "#c2362e", light: "#b3261e" };

// Relative luminance (0..1) of a hex color, for contrast decisions.
function luminance(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(rgb.r) + 0.7152 * f(rgb.g) + 0.0722 * f(rgb.b);
}
// Mix two hex colors by ratio t (0 = a, 1 = b).
function mixHex(a, b, t) {
  const ra = hexToRgb(a), rb = hexToRgb(b);
  if (!ra || !rb) return a;
  const m = (x, y) => Math.round(x + (y - x) * t);
  return rgbToHex(m(ra.r, rb.r), m(ra.g, rb.g), m(ra.b, rb.b));
}
function lightenHex(hex, amt) { return mixHex(hex, "#ffffff", amt); }
function darkenHex(hex, amt) { return mixHex(hex, "#000000", amt); }

// Derive a full coherent palette from a base (background) color + an accent.
// Returns an object of CSS variable values. Works for both light and dark bases.
function derivePalette(baseHex, accentHex) {
  const lum = luminance(baseHex);
  const isLight = lum > 0.45;
  // Elevations move *away* from the base: lighter on dark themes, darker on light.
  const lift = (amt) => isLight ? darkenHex(baseHex, amt) : lightenHex(baseHex, amt);
  const text = isLight ? "#1c1d22" : "#e8eaf0";
  const textDim = isLight ? mixHex(text, baseHex, 0.45) : mixHex(text, baseHex, 0.42);
  const accentSoft = isLight ? lightenHex(accentHex, 0.18) : lightenHex(accentHex, 0.28);
  return {
    "--bg": baseHex,
    "--bg-elev": lift(0.05),
    "--bg-elev2": lift(0.10),
    "--border": lift(0.16),
    "--text": text,
    "--text-dim": textDim,
    "--accent": accentHex,
    "--accent-soft": accentSoft,
    "--green": isLight ? "#1a7f37" : "#4cc463",
    "--shadow": isLight ? "rgba(40,40,50,0.14)" : "rgba(0,0,0,0.55)",
    "--pdf-bg": isLight ? lift(0.30) : darkenHex(baseHex, 0.25),
    "--highlight": isLight ? "rgba(255,205,0,0.6)" : "rgba(255,213,0,0.45)",
  };
}

// --- Theme storage ---
// Built-in "light"/"dark" keep the stylesheet defaults (with optional accent
// override). Custom themes are user-created {id,name,base,accent} and derive a
// full palette. Stored in localStorage as JSON.
function getCustomThemes() {
  try { return JSON.parse(localStorage.getItem("customThemes") || "[]"); } catch { return []; }
}
function saveCustomThemes(list) {
  try { localStorage.setItem("customThemes", JSON.stringify(list)); } catch {}
}
function getActiveTheme() {
  try { return localStorage.getItem("activeTheme") || "dark"; } catch { return "dark"; }
}
function setActiveTheme(id) {
  try { localStorage.setItem("activeTheme", id); } catch {}
}

function getCustomAccent(mode) {
  try { return localStorage.getItem("accent_" + mode) || null; } catch { return null; }
}
function setCustomAccent(mode, hex) {
  try {
    if (hex) localStorage.setItem("accent_" + mode, hex);
    else localStorage.removeItem("accent_" + mode);
  } catch {}
}

// Apply whichever theme id is active: built-in light/dark, or a custom palette.
function applyActiveTheme() {
  const id = getActiveTheme();
  const root = document.documentElement;
  // Clear any inline custom-palette overrides first.
  for (const v of ["--bg","--bg-elev","--bg-elev2","--border","--text","--text-dim","--accent","--accent-soft","--green","--shadow","--pdf-bg","--highlight"]) {
    root.style.removeProperty(v);
  }
  if (id === "light" || id === "dark") {
    root.setAttribute("data-theme", id);
    const custom = getCustomAccent(id);
    if (custom) {
      root.style.setProperty("--accent", custom);
      root.style.setProperty("--accent-soft", id === "light" ? lightenHex(custom, 0.18) : lightenHex(custom, 0.28));
    }
    try { localStorage.setItem("theme", id); } catch {}
    return;
  }
  // Custom theme: derive and apply the full palette.
  const theme = getCustomThemes().find((t) => t.id === id);
  if (!theme) { setActiveTheme("dark"); applyActiveTheme(); return; }
  // data-theme controls light/dark fallbacks for anything not overridden.
  root.setAttribute("data-theme", luminance(theme.base) > 0.45 ? "light" : "dark");
  const pal = derivePalette(theme.base, theme.accent);
  for (const [k, v] of Object.entries(pal)) root.style.setProperty(k, v);
}

// Back-compat shims (older code calls these).
function applyTheme(theme) { setActiveTheme(theme); applyActiveTheme(); }
function applyAccent(mode) { applyActiveTheme(); }
function initTheme() {
  // Migrate the old "theme" key into the new activeTheme key on first run.
  try {
    if (!localStorage.getItem("activeTheme")) {
      const old = localStorage.getItem("theme") || "dark";
      localStorage.setItem("activeTheme", old);
    }
  } catch {}
  applyActiveTheme();
}
$("#theme-toggle").onclick = () => {
  // The toggle flips between the two built-ins. If a custom theme is active,
  // toggling returns to dark/light based on the custom theme's brightness.
  const id = getActiveTheme();
  let next;
  if (id === "dark") next = "light";
  else if (id === "light") next = "dark";
  else {
    const t = getCustomThemes().find((x) => x.id === id);
    next = (t && luminance(t.base) > 0.45) ? "dark" : "light";
  }
  setActiveTheme(next);
  applyActiveTheme();
};

// ---------- Resizable panes ----------
function initResizers() {
  try {
    const s = localStorage.getItem("w-sidebar");
    const l = localStorage.getItem("w-list");
    if (s) document.documentElement.style.setProperty("--w-sidebar", s);
    if (l) document.documentElement.style.setProperty("--w-list", l);
  } catch {}

  const setup = (resizer, varName, storeKey, min, max) => {
    let startX, startW;
    const onMove = (e) => {
      const dx = e.clientX - startX;
      let w = startW + dx;
      w = Math.max(min, Math.min(max, w));
      document.documentElement.style.setProperty(varName, w + "px");
    };
    const onUp = () => {
      resizer.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      try {
        localStorage.setItem(storeKey,
          getComputedStyle(document.documentElement).getPropertyValue(varName).trim());
      } catch {}
    };
    resizer.addEventListener("mousedown", (e) => {
      startX = e.clientX;
      const cur = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
      startW = parseInt(cur) || (varName === "--w-sidebar" ? 230 : 360);
      resizer.classList.add("dragging");
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      e.preventDefault();
    });
  };
  setup($("#resizer-1"), "--w-sidebar", "w-sidebar", 160, 360);
  setup($("#resizer-2"), "--w-list", "w-list", 260, 640);
}

// ---------- Data loading ----------
async function loadLibrary() {
  const snap = await invoke("get_library");
  state.papers = snap.papers;
  state.collections = snap.collections;
  state.edges = snap.edges || [];
  state.tags = snap.tags || [];
  state.membership = {};
  for (const [pid, cid] of snap.membership) {
    (state.membership[pid] ||= new Set()).add(cid);
  }
  state.paperTags = {};
  for (const [pid, tid] of (snap.paper_tags || [])) {
    (state.paperTags[pid] ||= new Set()).add(tid);
  }
  renderCollections();
  renderTags();
  renderNavCounts();
  renderList();
  if (state.view.type === "graph") renderGraphScope();
}

// ---------- Sidebar ----------
function renderCollections() {
  const wrap = $("#collections-list");
  wrap.innerHTML = "";
  const archivedWrap = $("#archived-list");
  archivedWrap.innerHTML = "";

  // An archived collection (and its whole subtree) goes to the Archived section.
  const archivedIds = new Set(state.collections.filter((c) => c.archived).map((c) => c.id));
  // Mark descendants of archived collections as archived too.
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of state.collections) {
      if (!archivedIds.has(c.id) && c.parent_id && archivedIds.has(c.parent_id)) {
        archivedIds.add(c.id); changed = true;
      }
    }
  }

  const byParent = {};
  for (const c of state.collections) (byParent[c.parent_id || "root"] ||= []).push(c);

  const makeItem = (c, depth) => {
    const item = el("div", "collection-item");
    const stripeColor = c.color || "var(--border)";
    const count = state.papers.filter((p) => !p.trashed && state.membership[p.arxiv_id]?.has(c.id)).length;
    const icon = `<span class="col-folder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.2H19.5A1.5 1.5 0 0 1 21 9.7v8.8A1.5 1.5 0 0 1 19.5 20h-15A1.5 1.5 0 0 1 3 18.5V7.5Z"/></svg></span>`;
    item.innerHTML =
      `<span class="col-stripe" style="background:${esc(stripeColor)}"></span>` +
      `<span class="drag-handle" title="Drag to reorder">${GRIP_SVG}</span>` +
      `<span class="col-content" style="margin-left:${depth * 14}px">${icon}` +
      `<span class="col-name">${esc(c.name)}</span>` +
      `${count ? `<span class="col-count">${count}</span>` : ""}</span>`;
    item.dataset.reorderId = c.id;
    if (state.view.type === "collection" && state.view.id === c.id) item.classList.add("active");
    if (state.selectedCollectionIds.has(c.id)) item.classList.add("multi-selected");
    setupReorderHandle(item, c.id, "collection");
    item.onclick = (e) => {
      if (e.metaKey || e.ctrlKey) {
        if (state.selectedCollectionIds.has(c.id)) state.selectedCollectionIds.delete(c.id);
        else state.selectedCollectionIds.add(c.id);
        renderCollections();
        renderCollectionSelectionBar();
        return;
      }
      state.selectedCollectionIds.clear();
      renderCollectionSelectionBar();
      selectView({ type: "collection", id: c.id });
    };
    item.oncontextmenu = (e) => collectionMenu(e, c);
    item.ondragover = (e) => {
      if (reorderState) return; // reorder drag handled separately
      e.preventDefault();
      item.classList.toggle("drop-hover", inDropBand(e, item));
    };
    item.ondragleave = () => item.classList.remove("drop-hover");
    item.ondrop = async (e) => {
      if (reorderState) return;
      e.preventDefault();
      const hit = inDropBand(e, item);
      item.classList.remove("drop-hover");
      if (!hit) return;
      await handleDropToCollection(c.id, c.name);
    };
    return item;
  };

  const renderLevel = (parent, depth, target) => {
    for (const c of byParent[parent] || []) {
      if (target === wrap && archivedIds.has(c.id)) continue; // skip archived in main list
      if (target === archivedWrap && !archivedIds.has(c.id)) continue;
      target.appendChild(makeItem(c, depth));
      renderLevel(c.id, depth + 1, target);
    }
  };
  renderLevel("root", 0, wrap);
  // Archived: render archived roots (those whose parent isn't itself archived) flat.
  for (const c of state.collections) {
    if (archivedIds.has(c.id) && !(c.parent_id && archivedIds.has(c.parent_id))) {
      archivedWrap.appendChild(makeItem(c, 0));
    }
  }
  let showArchived = true;
  try { showArchived = localStorage.getItem("showArchived") !== "0"; } catch {}
  $("#archived-section").style.display = (archivedIds.size && showArchived) ? "" : "none";
}

function renderCollectionSelectionBar() {
  document.querySelector("#col-select-bar")?.remove();
  const n = state.selectedCollectionIds.size;
  if (n < 1) return;
  const wrap = $("#collections-list");
  const bar = el("div", "sidebar-select-bar");
  bar.id = "col-select-bar";
  bar.innerHTML = `<span>${n} selected</span>`;
  const ids = () => [...state.selectedCollectionIds];

  const colorBtn = el("button", "", "Color");
  colorBtn.onclick = () => openColorPicker({ id: "__multi__", name: `${n} collections` }, async (color) => {
    for (const id of ids()) await invoke("set_collection_color", { id, color });
    state.selectedCollectionIds.clear();
    await loadLibrary(); renderCollectionSelectionBar();
  });
  const archiveBtn = el("button", "", "Archive");
  archiveBtn.onclick = async () => {
    for (const id of ids()) await invoke("set_collection_archived", { id, archived: true });
    state.selectedCollectionIds.clear();
    await loadLibrary(); renderCollectionSelectionBar();
  };
  const delBtn = el("button", "danger", "Delete");
  delBtn.onclick = async () => {
    const ok = await window.__TAURI__.dialog.confirm(`Delete ${n} collection${n > 1 ? "s" : ""} and their subfolders?`, { title: "Delete collections", kind: "warning" });
    if (!ok) return;
    for (const id of ids()) await invoke("delete_collection", { id });
    if (state.view.type === "collection" && state.selectedCollectionIds.has(state.view.id)) selectView({ type: "smart", smart: "all" });
    state.selectedCollectionIds.clear();
    await loadLibrary(); renderCollectionSelectionBar();
  };
  const clearBtn = el("button", "", "Clear");
  clearBtn.onclick = () => { state.selectedCollectionIds.clear(); renderCollections(); renderCollectionSelectionBar(); };
  bar.append(colorBtn, archiveBtn, delBtn, clearBtn);
  wrap.after(bar);
}

function collectionMenu(e, c) {
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY, [
    { label: "Rename", action: () => openModal("Rename Collection", c.name, "Save", async (name) => {
        await invoke("rename_collection", { id: c.id, name });
        await loadLibrary();
      }) },
    { label: "New Subfolder", action: () => openModal("New Subfolder", "", "Create", async (name) => {
        await invoke("add_collection", { name, parentId: c.id });
        await loadLibrary();
      }) },
    { label: "Set color…", action: () => openColorPicker(c) },
    { label: c.archived ? "Unarchive" : "Archive", action: async () => {
        await invoke("set_collection_archived", { id: c.id, archived: !c.archived });
        await loadLibrary();
      } },
    { sep: true },
    { label: "Export DOIs to .txt…", action: () => exportDois(state.papers.filter((p) => state.membership[p.arxiv_id]?.has(c.id)), c.name) },
    { label: "Share by email", action: () => shareByEmail(state.papers.filter((p) => state.membership[p.arxiv_id]?.has(c.id)), c.name) },
    { sep: true },
    { label: "Delete", danger: true, action: async () => {
        const kids = state.collections.filter((x) => x.parent_id === c.id).length;
        const n = state.papers.filter((p) => state.membership[p.arxiv_id]?.has(c.id)).length;
        if (kids || n) {
          const ok = await window.__TAURI__.dialog.confirm(
            `Delete "${c.name}"${kids ? " and its subfolders" : ""}? The ${n} paper${n === 1 ? "" : "s"} in it stay in your library.`,
            { title: "Delete collection", kind: "warning" });
          if (!ok) return;
        }
        await invoke("delete_collection", { id: c.id });
        if (state.view.type === "collection" && state.view.id === c.id)
          selectView({ type: "smart", smart: "all" });
        await loadLibrary();
      } },
  ]);
}

// ---------- View switching ----------
const navHistory = { stack: [], index: -1, navigating: false };

function pushHistory(view) {
  if (navHistory.navigating) return;
  // Drop any forward entries, then push.
  navHistory.stack = navHistory.stack.slice(0, navHistory.index + 1);
  // Avoid duplicate consecutive entries.
  const last = navHistory.stack[navHistory.index];
  if (last && JSON.stringify(last) === JSON.stringify(view)) return;
  navHistory.stack.push(view);
  navHistory.index = navHistory.stack.length - 1;
  updateHistoryButtons();
}
function updateHistoryButtons() {
  const back = $("#nav-back"), fwd = $("#nav-forward");
  if (back) back.disabled = navHistory.index <= 0;
  if (fwd) fwd.disabled = navHistory.index >= navHistory.stack.length - 1;
}
function navBack() {
  if (navHistory.index <= 0) return;
  navHistory.index--;
  navHistory.navigating = true;
  selectView(navHistory.stack[navHistory.index]);
  navHistory.navigating = false;
  updateHistoryButtons();
}
function navForward() {
  if (navHistory.index >= navHistory.stack.length - 1) return;
  navHistory.index++;
  navHistory.navigating = true;
  selectView(navHistory.stack[navHistory.index]);
  navHistory.navigating = false;
  updateHistoryButtons();
}

function selectView(view) {
  pushHistory(view);
  state.view = view;
  // Clear every kind of sidebar highlight so only one item is active at a time.
  document.querySelectorAll(".nav-item, .saved-search-item, .collection-item, .tag-item")
    .forEach((n) => n.classList.remove("active"));

  const graphView = $("#graph-view");
  const listPane = $("#list-pane");
  const detailPane = $("#detail-pane");
  const resizer2 = $("#resizer-2");

  if (view.type === "graph") {
    document.querySelector('[data-view="graph"]')?.classList.add("active");
    listPane.classList.add("hidden");
    detailPane.classList.add("hidden");
    resizer2.classList.add("hidden");
    graphView.classList.remove("hidden");
    renderGraphScope();
    startGraph();
    return;
  }

  graphView.classList.add("hidden");
  listPane.classList.remove("hidden");
  detailPane.classList.remove("hidden");
  // Respect a user-collapsed detail pane: keep its resizer hidden if collapsed.
  resizer2.classList.toggle("hidden", detailPane.classList.contains("collapsed"));
  stopGraph();

  if (view.type === "search") {
    document.querySelector('[data-view="search"]')?.classList.add("active");
    $("#search-panel").classList.remove("hidden");
  } else {
    $("#search-panel").classList.add("hidden");
    if (view.type === "smart")
      document.querySelector(`[data-smart="${view.smart}"]`)?.classList.add("active");
  }
  // Feed controls only show in feed view.
  $("#feed-controls").classList.toggle("hidden", view.type !== "feed");
  $("#bib-controls").classList.toggle("hidden", view.type !== "bibliography");
  if (view.type !== "bibliography") {
    document.querySelector("#bib-group-bar")?.remove();
    document.querySelector("#bib-select-bar")?.remove();
    state.selectedBibIds.clear();
  }
  $("#ss-controls").classList.toggle("hidden", view.type !== "saved");
  if (view.type === "feed") {
    document.querySelector('[data-view="feed"]')?.classList.add("active");
    renderFeedControls();
    if (!state.feedLoaded) loadFeed();
  }
  if (view.type === "saved") {
    renderSavedSearches();
    loadSavedSearch(view.id);
  }
  if (view.type === "history") {
    document.querySelector('[data-view="history"]')?.classList.add("active");
    loadHistory();
  }
  if (view.type === "bibliography") {
    document.querySelector('[data-view="bibliography"]')?.classList.add("active");
    loadBibliography();
  }
  renderCollections();
  renderTags();
  renderNavCounts();
  if (view.type !== "history" && view.type !== "bibliography" && view.type !== "saved") renderList();
}

// ---------- List rendering ----------
// Resolve a paper object by arxiv_id across every result store and the library.
// Used by drag, bibliography-add, and selection actions so they work from any view.
function resolvePaper(id) {
  return state.searchResults.find((x) => x.arxiv_id === id)
    || state.savedResults.find((x) => x.arxiv_id === id)
    || state.feedResults.find((x) => x.arxiv_id === id)
    || state.papers.find((x) => x.arxiv_id === id)
    || null;
}

// Drag hit-test: only treat a dragover as "on target" when the cursor (which
// tracks the vertical center of the floating drag image) falls within the
// middle band of the target's height — full width, central ~60% of height.
// This stops a drop option appearing when the dragged panel merely grazes the
// top or bottom edge of a sidebar row.
const DROP_BAND = 0.6; // central fraction of height that counts as a hit
// Drag-to-reorder via a dedicated three-dot handle. Uses a distinct dataTransfer
// type ("x-reorder-<kind>") so it never collides with paper drag-and-drop.
// On drop, computes the new id order and calls the matching reorder command.
let reorderState = null; // { kind, id }
function setupReorderHandle(item, id, kind) {
  const handle = item.querySelector(".drag-handle");
  if (!handle) return;
  handle.draggable = true;
  handle.addEventListener("dragstart", (e) => {
    e.stopPropagation();
    reorderState = { kind, id };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(`x-reorder-${kind}`, id);
    item.classList.add("reordering");
  });
  handle.addEventListener("dragend", () => {
    item.classList.remove("reordering");
    document.querySelectorAll(".reorder-over").forEach((el2) => el2.classList.remove("reorder-over"));
  });
  // The whole item is a drop target *for reorder drags only*.
  item.addEventListener("dragover", (e) => {
    if (!reorderState || reorderState.kind !== kind) return; // not a reorder drag
    e.preventDefault();
    e.stopPropagation();
    item.classList.add("reorder-over");
  });
  item.addEventListener("dragleave", () => item.classList.remove("reorder-over"));
  item.addEventListener("drop", async (e) => {
    if (!reorderState || reorderState.kind !== kind) return;
    e.preventDefault();
    e.stopPropagation();
    item.classList.remove("reorder-over");
    const draggedId = reorderState.id;
    const targetId = id;
    reorderState = null;
    if (draggedId === targetId) return;
    await applyReorder(kind, draggedId, targetId);
  });
}

async function applyReorder(kind, draggedId, targetId) {
  if (kind === "collection") {
    // Reorder within the flat top-level order (uses current display order).
    const order = state.collections.map((c) => c.id);
    moveInArray(order, draggedId, targetId);
    await invoke("reorder_collections", { ids: order });
    await loadLibrary();
  } else if (kind === "tag") {
    const order = state.tags.map((t) => t.id);
    moveInArray(order, draggedId, targetId);
    await invoke("reorder_tags", { ids: order });
    await loadLibrary();
  } else if (kind === "saved") {
    const order = state.savedSearches.map((s) => s.id);
    moveInArray(order, draggedId, targetId);
    state.savedSearches = order.map((id) => state.savedSearches.find((s) => s.id === id)).filter(Boolean);
    await persistSavedSearches();
    renderSavedSearches();
  }
}

function moveInArray(arr, fromId, toId) {
  const from = arr.indexOf(fromId), to = arr.indexOf(toId);
  if (from < 0 || to < 0) return;
  arr.splice(to, 0, arr.splice(from, 1)[0]);
}

function inDropBand(e, elem) {
  const r = elem.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right) return false;
  const margin = (r.height * (1 - DROP_BAND)) / 2;
  return e.clientY >= r.top + margin && e.clientY <= r.bottom - margin;
}

function basePapers() {
  if (state.view.type === "search") return state.searchResults;
  if (state.view.type === "saved") return state.savedResults;
  if (state.view.type === "feed") return state.feedResults;
  // Trash view shows only trashed papers.
  if (state.view.type === "smart" && state.view.smart === "trash")
    return state.papers.filter((p) => p.trashed);
  // Everywhere else, exclude trashed papers.
  const live = state.papers.filter((p) => !p.trashed);
  if (state.view.type === "tag")
    return live.filter((p) => state.paperTags[p.arxiv_id]?.has(state.view.id));
  if (state.view.type === "smart") {
    if (state.view.smart === "all") return live;
    if (state.view.smart === "recent") return live.slice(0, 20);
    if (state.view.smart === "unsorted")
      return live.filter((p) => !(state.membership[p.arxiv_id]?.size));
  }
  if (state.view.type === "collection")
    return live.filter((p) => state.membership[p.arxiv_id]?.has(state.view.id));
  return [];
}

function currentPapers() {
  let papers = basePapers();
  if (state.view.type === "search" || state.view.type === "feed" || state.view.type === "saved") return papers; // fetched results aren't re-sorted/filtered locally

  // Status filter
  if (state.libStatus) {
    papers = papers.filter((p) => (p.reading_status || "unread") === state.libStatus);
  }
  // Text filter: every word must appear somewhere in the title, authors,
  // abstract, notes, categories, id, comments or tag names. "#tag" matches tags only.
  const words = state.libFilter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) {
    const tagName = Object.fromEntries(state.tags.map((t) => [t.id, t.name.toLowerCase()]));
    papers = papers.filter((p) => {
      const tags = [...(state.paperTags[p.arxiv_id] || [])].map((id) => tagName[id] || "");
      const hay = [p.title, p.authors.join(" "), p.summary, p.note || "", p.categories.join(" "),
        p.arxiv_id, p.comment || "", p.journal_ref || ""].join("\n").toLowerCase();
      return words.every((w) => w.startsWith("#") && w.length > 1
        ? tags.some((t) => t.includes(w.slice(1)))
        : hay.includes(w) || tags.some((t) => t.includes(w)));
    });
  }
  // Sort
  const s = state.libSort;
  papers = [...papers].sort((a, b) => {
    if (s === "title") return a.title.localeCompare(b.title);
    if (s === "author") return (a.authors[0] || "").localeCompare(b.authors[0] || "");
    if (s === "published") return new Date(b.published) - new Date(a.published);
    if (s === "opened") return new Date(b.last_opened || 0) - new Date(a.last_opened || 0);
    if (s === "citations") {
      const c = (p) => state.metricsCache[baseId(p.arxiv_id)]?.citation_count ?? -1;
      return c(b) - c(a);
    }
    return 0; // "added" — already in added-desc order from backend
  });
  return papers;
}

function listTitle() {
  if (state.view.type === "search") return "Search Results";
  if (state.view.type === "saved") return state.savedSearches.find((s) => s.id === state.view.id)?.title || "Saved Search";
  if (state.view.type === "feed") return "Daily Feed";
  if (state.view.type === "tag")
    return "#" + (state.tags.find((t) => t.id === state.view.id)?.name || "tag");
  if (state.view.type === "smart")
    return { all: "All Papers", unsorted: "Unsorted", recent: "Recently Added", trash: "Trash" }[state.view.smart];
  if (state.view.type === "collection")
    return state.collections.find((c) => c.id === state.view.id)?.name || "Collection";
  return "";
}

function renderTags() {
  const wrap = $("#tags-list");
  wrap.innerHTML = "";
  for (const t of state.tags) {
    const item = el("div", "tag-item");
    if (state.view.type === "tag" && state.view.id === t.id) item.classList.add("active");
    const tcount = state.papers.filter((p) => !p.trashed && state.paperTags[p.arxiv_id]?.has(t.id)).length;
    item.innerHTML = `<span class="drag-handle" title="Drag to reorder">${GRIP_SVG}</span><span class="tag-dot" style="${t.color ? `background:${esc(t.color)}` : ""}"></span><span class="tag-name">${esc(t.name)}</span>${tcount ? `<span class="tag-count">${tcount}</span>` : ""}`;
    item.dataset.reorderId = t.id;
    setupReorderHandle(item, t.id, "tag");
    if (state.view.type === "tag" && state.view.id === t.id) item.classList.add("active");
    if (state.selectedTagIds.has(t.id)) item.classList.add("multi-selected");
    item.onclick = (e) => {
      if (e.metaKey || e.ctrlKey) {
        if (state.selectedTagIds.has(t.id)) state.selectedTagIds.delete(t.id);
        else state.selectedTagIds.add(t.id);
        renderTags();
        renderTagSelectionBar();
        return;
      }
      state.selectedTagIds.clear();
      renderTagSelectionBar();
      selectView({ type: "tag", id: t.id });
    };
    item.ondragover = (e) => {
      if (reorderState) return;
      e.preventDefault();
      item.classList.toggle("drop-hover", inDropBand(e, item));
    };
    item.ondragleave = () => item.classList.remove("drop-hover");
    item.ondrop = async (e) => {
      if (reorderState) return;
      e.preventDefault();
      const hit = inDropBand(e, item);
      item.classList.remove("drop-hover");
      if (!hit) return;
      await handleDropToTag(t.id, t.name);
    };
    item.oncontextmenu = (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: "Set color…", action: () => openColorPicker(t, "tag") },
        { sep: true },
        { label: "Delete tag", danger: true, action: async () => {
          await invoke("delete_tag", { id: t.id });
          if (state.view.type === "tag" && state.view.id === t.id) selectView({ type: "smart", smart: "all" });
          await loadLibrary();
        }},
      ]);
    };
    wrap.appendChild(item);
  }
  renderTagSelectionBar();
}

function renderTagSelectionBar() {
  document.querySelector("#tag-select-bar")?.remove();
  const n = state.selectedTagIds.size;
  if (n < 1) return;
  const wrap = $("#tags-list");
  const bar = el("div", "sidebar-select-bar");
  bar.id = "tag-select-bar";
  bar.innerHTML = `<span>${n} selected</span>`;
  const ids = () => [...state.selectedTagIds];
  const colorBtn = el("button", "", "Color");
  colorBtn.onclick = () => openColorPicker({ id: "__multitag__", name: `${n} tags` }, async (color) => {
    for (const id of ids()) await invoke("set_tag_color", { id, color }).catch(() => {});
    state.selectedTagIds.clear();
    await loadLibrary(); renderTagSelectionBar();
  });
  const delBtn = el("button", "danger", "Delete");
  delBtn.onclick = async () => {
    const ok = await window.__TAURI__.dialog.confirm(`Delete ${n} tag${n > 1 ? "s" : ""}?`, { title: "Delete tags", kind: "warning" });
    if (!ok) return;
    for (const id of ids()) await invoke("delete_tag", { id });
    if (state.view.type === "tag" && state.selectedTagIds.has(state.view.id)) selectView({ type: "smart", smart: "all" });
    state.selectedTagIds.clear();
    await loadLibrary(); renderTagSelectionBar();
  };
  const clearBtn = el("button", "", "Clear");
  clearBtn.onclick = () => { state.selectedTagIds.clear(); renderTags(); };
  bar.append(colorBtn, delBtn, clearBtn);
  wrap.after(bar);
}

function renderNavCounts() {
  const live = state.papers.filter((p) => !p.trashed);
  const counts = {
    all: live.length,
    unsorted: live.filter((p) => !(state.membership[p.arxiv_id]?.size)).length,
    trash: state.papers.filter((p) => p.trashed).length,
  };
  for (const [smart, n] of Object.entries(counts)) {
    const btn = document.querySelector(`.nav-item[data-smart="${smart}"]`);
    if (!btn) continue;
    let badge = btn.querySelector(".nav-count");
    if (n > 0) {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "nav-count";
        btn.appendChild(badge);
      }
      badge.textContent = String(n);
    } else if (badge) {
      badge.remove();
    }
  }
}

function renderListActions() {
  const wrap = $("#list-actions");
  wrap.innerHTML = "";
  const papers = currentPapers();
  if (state.view.type === "search" || state.view.type === "feed" || state.view.type === "saved") return;

  // Empty Trash button in trash view
  if (state.view.type === "smart" && state.view.smart === "trash") {
    if (!papers.length) return;
    const emptyBtn = el("button", "list-action-btn danger-btn", "Empty Trash");
    emptyBtn.onclick = async () => {
      const ok = await window.__TAURI__.dialog.confirm(
        `Permanently delete all ${papers.length} papers in Trash? This cannot be undone.`,
        { title: "Empty Trash", kind: "warning" });
      if (!ok) return;
      const n = await invoke("empty_trash");
      await loadLibrary();
      toast(`Deleted ${n} paper${n === 1 ? "" : "s"}`);
    };
    wrap.append(emptyBtn);
    return;
  }

  if (!papers.length) return;
  const name = listTitle();
  const exportBtn = el("button", "list-action-btn", "Export ▾");
  exportBtn.onclick = (e) => {
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [
      { label: "DOIs + links (.txt)", action: () => exportDois(papers, name) },
      { label: "BibTeX (.bib)", action: () => exportCitations(papers, name, "bibtex") },
      { label: "RIS (.ris)", action: () => exportCitations(papers, name, "ris") },
      { label: "Plain text citations (.txt)", action: () => exportCitations(papers, name, "text") },
      { sep: true },
      { label: "Email links", action: () => shareByEmail(papers, name) },
    ]);
  };
  wrap.append(exportBtn);
}

function statusBadge(p) {
  const s = p.reading_status || "unread";
  return `<span class="status-badge status-${s}">${s}</span>`;
}

function wirePaperListDelegation(list) {
  if (list.dataset.delegated === "1") return;
  list.dataset.delegated = "1";

  const paperFor = (id) => currentPapers().find((x) => x.arxiv_id === id);
  const searchingNow = () =>
    state.view.type === "search" || state.view.type === "feed" || state.view.type === "saved";

  list.addEventListener("click", (e) => {
    const card = e.target.closest(".paper-card");
    if (!card) return;
    const id = card.dataset.id;
    const p = paperFor(id);
    if (!p) return;

    // Author link → author search.
    const al = e.target.closest(".author-link");
    if (al) { e.stopPropagation(); searchByAuthor(al.dataset.author); return; }

    // Save button (search/feed/saved views).
    if (e.target.classList.contains("save-btn")) {
      e.stopPropagation();
      saveWithDupCheck(p);
      return;
    }

    // Checkbox toggles multi-selection.
    if (e.target.classList.contains("card-check")) {
      e.stopPropagation();
      toggleSelect(id, currentPapers());
      return;
    }

    // Card body click.
    if (e.metaKey || e.ctrlKey) { toggleSelect(id, currentPapers()); return; }
    if (e.shiftKey && state.lastClickedId) { selectRange(state.lastClickedId, id, currentPapers()); return; }
    state.selectedIds.clear();
    state.lastClickedId = id;
    selectPaper(p);
  });

  list.addEventListener("contextmenu", (e) => {
    const card = e.target.closest(".paper-card");
    if (!card) return;
    const p = paperFor(card.dataset.id);
    if (!p) return;
    searchingNow() ? searchResultMenu(e, p) : paperMenu(e, p);
  });

  list.addEventListener("dragstart", (ev) => {
    const card = ev.target.closest(".paper-card");
    if (!card) return;
    const id = card.dataset.id;
    const ids = (state.selectedIds.size && state.selectedIds.has(id)) ? [...state.selectedIds] : [id];
    ev.dataTransfer.setData("application/x-arxiv-ids", JSON.stringify(ids));
    ev.dataTransfer.setData("application/x-arxiv-from", searchingNow() ? "search" : "library");
    ev.dataTransfer.effectAllowed = "copyMove";
    dragPapers = ids.map((pid) => resolvePaper(pid)).filter(Boolean);
  });
}

function renderList() {
  const isSearch = state.view.type === "search";
  const isFeed = state.view.type === "feed";
  const isSavedView = state.view.type === "saved";
  const searching = isSearch || isFeed || isSavedView; // all show save-buttons, hide library controls
  const papers = currentPapers();
  // Title with a greyish count beside it.
  let countText = "";
  if (papers.length) {
    const total = isSearch ? searchPaging.total : (isSavedView ? savedPaging.total : null);
    countText = total && total > papers.length
      ? ` <span class="title-count">${papers.length.toLocaleString()} of ${total.toLocaleString()}</span>`
      : ` <span class="title-count">${papers.length.toLocaleString()}</span>`;
  }
  $("#list-title").innerHTML = esc(listTitle()) + countText;
  renderListActions();
  $("#library-controls").classList.toggle("hidden", searching);

  const list = $("#paper-list");
  // Re-rendering the same view (after a save, tag, status change…) keeps the
  // scroll position; switching to a different view starts at the top.
  const viewKey = JSON.stringify(state.view);
  const keepScroll = list.dataset.viewKey === viewKey ? list.scrollTop : 0;
  list.dataset.viewKey = viewKey;
  list.className = "paper-list" + (state.density === "compact" ? " compact" : "");
  list.innerHTML = "";
  wirePaperListDelegation(list);

  // Selection toolbar (when 1+ selected)
  renderSelectionToolbar(papers);

  if (!papers.length) {
    let msg;
    if (isSearch) msg = `Search arXiv above, or paste an arXiv id / link (e.g. <code>2401.01234</code>) to jump straight to that paper.<br><br>
      Use <code>"quotes"</code> for exact phrases and Advanced for fields, subjects and dates. Press <kbd>/</kbd> to focus the search box.`;
    else if (isFeed) msg = state.feedCategories.length
      ? "Loading the latest papers… or hit Refresh."
      : "Add a category above (e.g. cond-mat.supr-con) to see the newest papers each day.";
    else if (state.view.type === "smart" && state.view.smart === "trash")
      msg = "Trash is empty. Papers you delete land here, and you can restore them or empty the trash.";
    else msg = (state.libFilter || state.libStatus) ? "No papers match this filter." : "No papers here yet. Search arXiv and save some.";
    list.appendChild(el("div", "empty-list", `<div class="empty-icon">&#9634;</div><p>${msg}</p>`));
    return;
  }

  const frag = document.createDocumentFragment();
  const metricTargets = [];
  for (const p of papers) {
    const card = el("div", "paper-card");
    card.dataset.id = p.arxiv_id;
    if (state.selectedPaper?.arxiv_id === p.arxiv_id) card.classList.add("active");
    if (state.selectedIds.has(p.arxiv_id)) card.classList.add("multi-selected");
    card.draggable = true;
    const authors = p.authors.slice(0, 4).join(", ") + (p.authors.length > 4 ? " et al." : "");
    let action = "";
    if (searching) {
      action = isInLibrary(p.arxiv_id)
        ? `<span class="saved-tag">&#10003; Saved</span>`
        : isTrashed(p.arxiv_id)
          ? `<button class="save-btn" title="This paper is in the Trash — click to restore it">↺ Restore</button>`
          : `<button class="save-btn">+ Save</button>`;
      if (isFeed && isNewInFeed(p)) action = `<span class="new-badge" title="New since your last visit">NEW</span>` + action;
    } else {
      action = statusBadge(p);
    }
    const tagIds = state.paperTags[p.arxiv_id];
    const tagChips = (!searching && tagIds && tagIds.size)
      ? `<div class="paper-tags-row">${[...tagIds].map((tid) => {
          const t = state.tags.find((x) => x.id === tid);
          return t ? `<span class="paper-tag-chip">#${esc(t.name)}</span>` : "";
        }).join("")}</div>` : "";
    const dates = !searching && (p.added_at || p.last_opened)
      ? `<div class="card-dates">${p.added_at ? `Added ${fmtDate(p.added_at)}` : ""}${p.added_at && p.last_opened ? " · " : ""}${p.last_opened ? `Opened ${fmtDate(p.last_opened)}` : ""}</div>`
      : "";
    // Clickable author links (first few)
    const authorList = p.authors.slice(0, 4).map((a) =>
      `<span class="author-link" data-author="${esc(a)}">${esc(a)}</span>`).join(", ")
      + (p.authors.length > 4 ? " et al." : "");
    const metricsRow = `<div class="card-metrics" data-metrics="${esc(p.arxiv_id)}"></div>`;
    card.innerHTML = `
      <input type="checkbox" class="card-check" ${state.selectedIds.has(p.arxiv_id) ? "checked" : ""} />
      <div class="card-body">
        <h3>${esc(p.title)}</h3>
        <div class="authors">${authorList}</div>
        <div class="meta">
          <span class="cat-chip">${esc(p.primary_category)}</span>
          <span class="date">${fmtDate(p.published)}</span>
          ${action}
        </div>
        ${metricsRow}
        ${tagChips}
        ${dates}
      </div>`;

    metricTargets.push([card.querySelector(`[data-metrics]`), p.arxiv_id]);
    frag.appendChild(card);
  }
  // Single reflow: append the whole fragment at once.
  list.appendChild(frag);
  list.scrollTop = keepScroll;
  // Kick off lazy metric loads after the cards are in the DOM.
  for (const [target, id] of metricTargets) loadMetricsInto(target, id);
}

let dragPapers = [];

async function ensureSaved(ids) {
  // Save any dragged papers not yet in the library (from search results), and
  // bring back any that are sitting in the trash.
  const papers = ids
    .filter((id) => !isInLibrary(id))
    .map((id) => dragPapers.find((x) => x.arxiv_id === id) || resolvePaper(id))
    .filter(Boolean);
  if (papers.length) await invoke("save_papers", { papers, collectionId: null });
}
async function handleDropToCollection(cid, cname) {
  const ids = dragPapers.map((p) => p.arxiv_id);
  if (!ids.length) return;
  await ensureSaved(ids);
  await invoke("bulk_assign", { ids, collectionId: cid });
  dragPapers = []; state.selectedIds.clear();
  await loadLibrary();
  toast(`Added ${ids.length} to ${cname}`);
}
async function handleDropToTag(tid, tname) {
  const ids = dragPapers.map((p) => p.arxiv_id);
  if (!ids.length) return;
  await ensureSaved(ids);
  await invoke("bulk_tag", { ids, tagId: tid });
  dragPapers = []; state.selectedIds.clear();
  await loadLibrary();
  toast(`Tagged ${ids.length} with #${tname}`);
}
async function handleDropToLibrary() {
  const ids = dragPapers.map((p) => p.arxiv_id);
  if (!ids.length) return;
  await ensureSaved(ids);
  dragPapers = []; state.selectedIds.clear();
  await loadLibrary();
  toast(`Added ${ids.length} to library`);
}

// ---------- Saved Searches ----------
function renderSavedSearches() {
  const wrap = $("#saved-searches-list");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!state.savedSearches.length) {
    wrap.innerHTML = `<div style="padding:6px 8px;font-size:11.5px;color:var(--text-dim)">Click + to pin a keyword search.</div>`;
    return;
  }
  for (const s of state.savedSearches) {
    const item = el("div", "saved-search-item");
    if (state.view.type === "saved" && state.view.id === s.id) item.classList.add("active");
    if (state.selectedSearchIds.has(s.id)) item.classList.add("multi-selected");
    item.innerHTML = `<span class="drag-handle" title="Drag to reorder">${GRIP_SVG}</span><span class="ss-icon">⌕</span><span class="ss-name">${esc(s.title)}</span>`;
    item.dataset.reorderId = s.id;
    setupReorderHandle(item, s.id, "saved");
    item.onclick = (e) => {
      if (e.metaKey || e.ctrlKey) {
        if (state.selectedSearchIds.has(s.id)) state.selectedSearchIds.delete(s.id);
        else state.selectedSearchIds.add(s.id);
        renderSavedSearches();
        renderSavedSearchSelectionBar();
        return;
      }
      state.selectedSearchIds.clear();
      renderSavedSearchSelectionBar();
      selectView({ type: "saved", id: s.id });
    };
    item.oncontextmenu = (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: "Refresh", action: () => { delete state.savedSearchCache[s.id]; if (state.view.type === "saved" && state.view.id === s.id) loadSavedSearch(s.id); } },
        { label: "Edit…", action: () => openSavedSearchModal(s) },
        { sep: true },
        { label: "Delete", danger: true, action: async () => {
          state.savedSearches = state.savedSearches.filter((x) => x.id !== s.id);
          delete state.savedSearchCache[s.id];
          await persistSavedSearches();
          if (state.view.type === "saved" && state.view.id === s.id) selectView({ type: "search" });
          renderSavedSearches();
        }},
      ]);
    };
    wrap.appendChild(item);
  }
}

function renderSavedSearchSelectionBar() {
  document.querySelector("#ss-select-bar")?.remove();
  const n = state.selectedSearchIds.size;
  if (n < 1) return;
  const wrap = $("#saved-searches-list");
  const bar = el("div", "sidebar-select-bar");
  bar.id = "ss-select-bar";
  bar.innerHTML = `<span>${n} selected</span>`;
  const del = el("button", "danger", "Delete");
  del.onclick = async () => {
    const ok = await window.__TAURI__.dialog.confirm(`Delete ${n} saved search${n > 1 ? "es" : ""}?`, { title: "Delete saved searches", kind: "warning" });
    if (!ok) return;
    state.savedSearches = state.savedSearches.filter((x) => !state.selectedSearchIds.has(x.id));
    for (const id of state.selectedSearchIds) delete state.savedSearchCache[id];
    if (state.view.type === "saved" && state.selectedSearchIds.has(state.view.id)) selectView({ type: "search" });
    state.selectedSearchIds.clear();
    await persistSavedSearches();
    renderSavedSearches();
    renderSavedSearchSelectionBar();
  };
  const clear = el("button", "", "Clear");
  clear.onclick = () => { state.selectedSearchIds.clear(); renderSavedSearches(); renderSavedSearchSelectionBar(); };
  bar.append(del, clear);
  wrap.after(bar);
}

async function persistSavedSearches() {
  try { await invoke("set_saved_searches", { searches: state.savedSearches }); } catch {}
}

function openSavedSearchModal(existing) {
  const modal = $("#saved-search-modal");
  $("#ss-modal-title").textContent = existing ? "Edit Saved Search" : "New Saved Search";
  $("#ss-title").value = existing?.title || "";
  $("#ss-keywords").value = existing?.keywords || "";
  $("#ss-field").value = existing?.field || "all";
  $("#ss-sort").value = existing?.sort || "relevance";
  $("#ss-ok").textContent = existing ? "Save" : "Create";
  modal.classList.remove("hidden");
  $("#ss-title").focus();
  $("#ss-cancel").onclick = () => modal.classList.add("hidden");
  for (const inp of ["#ss-title", "#ss-keywords"]) {
    $(inp).onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); $("#ss-ok").click(); } };
  }
  $("#ss-ok").onclick = async () => {
    const title = $("#ss-title").value.trim();
    const keywords = $("#ss-keywords").value.trim();
    if (!title || !keywords) { toast("Title and keywords are required"); return; }
    const field = $("#ss-field").value, sort = $("#ss-sort").value;
    if (existing) {
      Object.assign(existing, { title, keywords, field, sort });
      delete state.savedSearchCache[existing.id];
    } else {
      const id = "ss" + Date.now().toString(36);
      state.savedSearches.push({ id, title, keywords, field, sort });
    }
    modal.classList.add("hidden");
    await persistSavedSearches();
    renderSavedSearches();
    if (existing && state.view.type === "saved" && state.view.id === existing.id) loadSavedSearch(existing.id);
  };
}

function savedSearchQuery(s) {
  const kw = s.keywords.trim();
  const field = s.field || "all";
  if (field === "cat") return `cat:${kw}`;
  const words = kw.split(/\s+/).filter(Boolean);
  if (field === "all") {
    // "All fields" = each word must appear in the title, author, OR abstract.
    // ANDs the words together, each matched across those three fields.
    const perWord = words.map((w) => `(ti:${w} OR abs:${w} OR au:${w})`);
    return perWord.join(" AND ");
  }
  const prefix = { ti: "ti", abs: "abs", au: "au" }[field] || "all";
  return words.map((w) => `${prefix}:${w}`).join(" AND ");
}

async function loadSavedSearch(id) {
  const s = state.savedSearches.find((x) => x.id === id);
  if (!s) return;
  $("#ss-desc").textContent = `${s.keywords} · ${s.field} · ${s.sort === "submittedDateOldest" ? "oldest" : s.sort}`;
  const list = $("#paper-list");
  // Use cache if present.
  if (state.savedSearchCache[id]) {
    state.savedResults = state.savedSearchCache[id].results;
    savedPaging = state.savedSearchCache[id].paging;
    renderList();
    return;
  }
  list.innerHTML = '<div class="loading">Searching arXiv…</div>';
  $("#list-title").textContent = s.title;
  const q = savedSearchQuery(s);
  try {
    const { papers: res, total } = await invoke("search_arxiv", { query: q, sortBy: s.sort, maxResults: 50, start: 0 });
    // The user may have clicked elsewhere while arXiv was answering.
    if (state.view.type !== "saved" || state.view.id !== id) return;
    state.savedResults = res;
    savedPaging = { query: q, sort: s.sort, start: res.length, pageSize: 50, total, done: res.length < 50 || res.length >= total, loading: false, savedId: id };
    state.savedSearchCache[id] = { results: res, paging: savedPaging };
    renderList();
  } catch (err) {
    list.innerHTML = `<div class="empty-list"><div class="empty-icon">&#9888;</div><p>${esc(String(err))}</p>
      <button id="ss-retry" class="btn-secondary" style="margin-top:12px">Try again</button></div>`;
    const rb = $("#ss-retry"); if (rb) rb.onclick = () => loadSavedSearch(id);
  }
}

// ---------- Daily Feed ----------
const DEFAULT_FEED_CATEGORIES = ["cond-mat.supr-con", "cond-mat.mes-hall"];

async function initFeedCategories() {
  try {
    const s = await invoke("get_settings");
    state.feedCategories = (s.followed_categories && s.followed_categories.length)
      ? s.followed_categories : [...DEFAULT_FEED_CATEGORIES];
  } catch { state.feedCategories = [...DEFAULT_FEED_CATEGORIES]; }
}

async function saveFeedCategories() {
  try { await invoke("set_followed_categories", { categories: state.feedCategories }); } catch {}
}

function renderFeedControls() {
  const wrap = $("#feed-cats");
  wrap.innerHTML = "";
  for (const cat of state.feedCategories) {
    const chip = el("span", "feed-cat-chip");
    chip.innerHTML = `${esc(cat)} <span class="rm" title="Remove">&times;</span>`;
    chip.querySelector(".rm").onclick = async () => {
      state.feedCategories = state.feedCategories.filter((c) => c !== cat);
      await saveFeedCategories();
      renderFeedControls();
      loadFeed();
    };
    wrap.appendChild(chip);
  }
}

// "NEW" badges: papers submitted after the newest one seen on the previous
// visit. The threshold is read once per session so badges don't vanish on refresh.
let feedThreshold = null;
try { feedThreshold = localStorage.getItem("feedLastSeen"); } catch {}
function isNewInFeed(p) {
  return !!feedThreshold && p.published > feedThreshold;
}
function rememberFeedSeen(papers) {
  const newest = papers.reduce((m, p) => (p.published > m ? p.published : m), "");
  if (!newest) return;
  try {
    if (newest > (localStorage.getItem("feedLastSeen") || "")) localStorage.setItem("feedLastSeen", newest);
  } catch {}
}

async function loadFeed() {
  if (!state.feedCategories.length) { state.feedResults = []; state.feedLoaded = true; renderList(); return; }
  const list = $("#paper-list");
  list.innerHTML = '<div class="loading">Fetching the latest papers…</div>';
  // Build an OR query across followed categories, sorted by newest submission.
  const q = state.feedCategories.map((c) => `cat:${c}`).join(" OR ");
  try {
    const { papers: res } = await invoke("search_arxiv", { query: q, sortBy: "submittedDate", maxResults: 60, start: 0 });
    state.feedResults = res;
    state.feedLoaded = true;
    rememberFeedSeen(res);
    if (state.view.type === "feed") renderList();
  } catch (err) {
    state.feedLoaded = false;
    list.innerHTML = `<div class="empty-list"><div class="empty-icon">&#9888;</div>
      <p>${esc(String(err))}</p>
      <button id="feed-retry" class="btn-secondary" style="margin-top:12px">Try again</button></div>`;
    const rb = $("#feed-retry");
    if (rb) rb.onclick = () => loadFeed();
  }
}

// ---------- View History ----------
async function loadHistory() {
  const list = $("#paper-list");
  $("#list-actions").innerHTML = "";
  $("#library-controls").classList.add("hidden");
  list.className = "paper-list";
  list.innerHTML = '<div class="loading">Loading history…</div>';
  try {
    const hist = await invoke("get_history");
    $("#list-title").innerHTML = `History <span class="title-count">${hist.length}</span>`;
    const clearBtn = el("button", "list-action-btn danger-btn", "Clear history");
    clearBtn.onclick = async () => {
      const ok = await window.__TAURI__.dialog.confirm("Clear your view history?", { title: "Clear history", kind: "warning" });
      if (!ok) return;
      await invoke("clear_history");
      loadHistory();
    };
    $("#list-actions").innerHTML = "";
    if (hist.length) $("#list-actions").append(clearBtn);

    if (!hist.length) {
      list.innerHTML = `<div class="empty-list"><div class="empty-icon">🕐</div><p>No history yet. Papers you open will appear here (last 50).</p></div>`;
      return;
    }
    list.innerHTML = "";
    for (const h of hist) {
      const card = el("div", "paper-card");
      const authors = (h.authors || []).slice(0, 4).join(", ") + ((h.authors || []).length > 4 ? " et al." : "");
      card.innerHTML = `<div class="card-body">
        <h3>${esc(h.title)}</h3>
        <div class="authors">${esc(authors)}</div>
        <div class="meta"><span class="cat-chip">${esc(h.primary_category || "")}</span>
          <span class="date">${h.published ? fmtDate(h.published) : ""}</span></div>
        <div class="history-time">Viewed ${fmtDateTime(h.viewed_at)}</div>
      </div>`;
      card.onclick = async () => {
        const existing = state.papers.find((x) => x.arxiv_id === h.arxiv_id);
        if (existing) { selectView({ type: "smart", smart: "all" }); selectPaper(existing); return; }
        // History only stores a summary line; show it at once, then fetch the
        // full record (abstract, PDF link, comments) from arXiv.
        selectPaper({
          arxiv_id: h.arxiv_id, title: h.title, authors: h.authors || [],
          summary: "Loading abstract…", categories: h.primary_category ? [h.primary_category] : [],
          primary_category: h.primary_category || "", published: h.published || "",
          updated: "", pdf_url: `https://arxiv.org/pdf/${h.arxiv_id}`, abs_url: h.abs_url || `https://arxiv.org/abs/${h.arxiv_id}`,
        });
        try {
          const [full] = (await invoke("lookup_arxiv_ids", { input: h.arxiv_id })) || [];
          if (full && state.selectedPaper?.arxiv_id === h.arxiv_id) selectPaper(full);
        } catch {
          if (state.selectedPaper?.arxiv_id === h.arxiv_id) $("#detail-abstract").textContent = "Couldn't load the abstract (offline?).";
        }
      };
      list.appendChild(card);
    }
  } catch (err) {
    list.innerHTML = `<div class="empty-list"><div class="empty-icon">&#9888;</div><p>${esc(String(err))}</p></div>`;
  }
}

function fmtDateTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " +
           d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  } catch { return iso; }
}

// ---------- Bibliography ----------
function citationToBibtex(c) {
  const first = (c.authors[0] || "unknown").split(/\s+/).pop().replace(/[^a-zA-Z]/g, "");
  const key = `${first}${c.year || ""}`;
  // arXiv preprint → @misc with eprint fields.
  if (c.is_preprint) {
    const f = [
      `  title = {${c.title}}`,
      `  author = {${c.authors.join(" and ")}}`,
    ];
    if (c.year) f.push(`  year = {${c.year}}`);
    if (c.arxiv_id) { f.push(`  eprint = {${c.arxiv_id}}`); f.push(`  archivePrefix = {arXiv}`); }
    f.push(`  howpublished = {arXiv preprint}`);
    return `@misc{${key},\n${f.join(",\n")}\n}`;
  }
  const fields = [
    `  title = {${c.title}}`,
    `  author = {${c.authors.join(" and ")}}`,
  ];
  if (c.year) fields.push(`  year = {${c.year}}`);
  if (c.container) fields.push(`  journal = {${c.container}}`);
  if (c.volume) fields.push(`  volume = {${c.volume}}`);
  if (c.issue) fields.push(`  number = {${c.issue}}`);
  if (c.page) fields.push(`  pages = {${c.page}}`);
  if (c.publisher) fields.push(`  publisher = {${c.publisher}}`);
  fields.push(`  doi = {${c.doi}}`);
  return `@article{${key},\n${fields.join(",\n")}\n}`;
}
function citationToRis(c) {
  const ty = c.is_preprint ? "TY  - GEN" : "TY  - JOUR";
  const lines = [ty, `TI  - ${c.title}`];
  for (const a of c.authors) lines.push(`AU  - ${a}`);
  if (c.year) lines.push(`PY  - ${c.year}`);
  if (c.container) lines.push(`JO  - ${c.container}`);
  if (c.volume) lines.push(`VL  - ${c.volume}`);
  if (c.issue) lines.push(`IS  - ${c.issue}`);
  if (c.page) lines.push(`SP  - ${c.page}`);
  if (c.doi) lines.push(`DO  - ${c.doi}`);
  if (c.url) lines.push(`UR  - ${c.url}`);
  lines.push("ER  - ");
  return lines.join("\n");
}

async function loadBibliography() {
  const list = $("#paper-list");
  $("#list-actions").innerHTML = "";
  $("#library-controls").classList.add("hidden");
  list.className = "paper-list";
  list.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const [entries, folders, tags] = await Promise.all([
      invoke("get_bib_entries"), invoke("get_bib_folders"), invoke("get_bib_tags"),
    ]);
    state.bibFolders = folders;
    state.bibTags = tags;

    // Apply folder/tag filter.
    let shown = entries;
    if (state.bibFilter) {
      const key = state.bibFilter.type === "folder" ? "folder_ids" : "tag_ids";
      shown = entries.filter((e) => (e[key] || []).includes(state.bibFilter.id));
    }

    $("#list-title").innerHTML = `Bibliography <span class="title-count">${shown.length}</span>`;
    renderBibGroupBar(entries);
    renderBibSelectionBar(entries);

    if (!shown.length) {
      list.innerHTML = `<div class="empty-list"><div class="empty-icon">❝</div><p>${
        state.bibFilter ? "No citations in this group yet." :
        "No citations yet. Paste a DOI above to fetch a citation, or import a .bib/.ris file."
      }</p></div>`;
      return;
    }
    list.innerHTML = "";
    const folderById = Object.fromEntries(folders.map((f) => [f.id, f]));
    const tagById = Object.fromEntries(tags.map((t) => [t.id, t]));
    for (const e of shown) {
      let c;
      try { c = JSON.parse(e.raw_json); } catch { continue; }
      const card = el("div", "bib-card");
      if (state.selectedBibIds.has(e.id)) card.classList.add("bib-selected");
      const authors = (c.authors || []).slice(0, 5).join(", ") + ((c.authors || []).length > 5 ? " et al." : "");
      const folderTags = [
        ...(e.folder_ids || []).map((id) => folderById[id]).filter(Boolean).map((f) => `<span class="bib-mini-tag">📁 ${esc(f.name)}</span>`),
        ...(e.tag_ids || []).map((id) => tagById[id]).filter(Boolean).map((t) => `<span class="bib-mini-tag">#${esc(t.name)}</span>`),
      ].join("");
      card.innerHTML = `
        <div class="bib-title">${esc(c.title || "(untitled)")}${c.is_preprint ? ' <span class="bib-mini-tag">preprint</span>' : ""}</div>
        <div class="bib-meta">${esc(authors)}${c.year ? ` · ${c.year}` : ""}${c.container ? ` · ${esc(c.container)}` : ""}</div>
        <div class="bib-doi">${esc(c.doi || "")}</div>
        ${folderTags ? `<div class="bib-folder-tags">${folderTags}</div>` : ""}
        <div class="bib-actions">
          <button class="bib-copy-bib">Copy BibTeX</button>
          <button class="bib-copy-ris">Copy RIS</button>
          <button class="bib-organize">Organize ▾</button>
          <button class="bib-del">Remove</button>
        </div>`;
      // Cmd/Ctrl-click selects; normal click does nothing special.
      card.onclick = (ev) => {
        if (ev.target.closest(".bib-actions")) return;
        if (ev.metaKey || ev.ctrlKey) {
          if (state.selectedBibIds.has(e.id)) state.selectedBibIds.delete(e.id);
          else state.selectedBibIds.add(e.id);
          card.classList.toggle("bib-selected", state.selectedBibIds.has(e.id));
          renderBibSelectionBar(entries);
        }
      };
      card.querySelector(".bib-copy-bib").onclick = () => { navigator.clipboard.writeText(citationToBibtex(c)); toast("BibTeX copied"); };
      card.querySelector(".bib-copy-ris").onclick = () => { navigator.clipboard.writeText(citationToRis(c)); toast("RIS copied"); };
      card.querySelector(".bib-del").onclick = async () => { await invoke("delete_bib_entry", { id: e.id }); state.selectedBibIds.delete(e.id); loadBibliography(); };
      card.querySelector(".bib-organize").onclick = (ev) => { ev.stopPropagation(); openBibOrganizeMenu(ev, [e.id]); };
      list.appendChild(card);
    }
  } catch (err) {
    list.innerHTML = `<div class="empty-list"><div class="empty-icon">&#9888;</div><p>${esc(String(err))}</p></div>`;
  }
}

function renderBibGroupBar(entries) {
  // Render folder + tag filter chips above the list, inside the bib controls row area.
  let bar = $("#bib-group-bar");
  if (!bar) {
    bar = el("div", "bib-group-bar");
    bar.id = "bib-group-bar";
    $("#bib-controls").after(bar);
  }
  bar.innerHTML = "";
  const allChip = el("span", "bib-chip" + (state.bibFilter ? "" : " active"), "All");
  allChip.onclick = () => { state.bibFilter = null; loadBibliography(); };
  bar.appendChild(allChip);
  for (const f of state.bibFolders) {
    const n = entries.filter((e) => (e.folder_ids || []).includes(f.id)).length;
    const chip = el("span", "bib-chip" + (state.bibFilter?.type === "folder" && state.bibFilter.id === f.id ? " active" : ""));
    chip.innerHTML = `${f.color ? `<span class="bib-chip-dot" style="background:${esc(f.color)}"></span>` : "📁"} ${esc(f.name)} ${n ? `<span style="opacity:.6">${n}</span>` : ""}`;
    chip.onclick = () => { state.bibFilter = { type: "folder", id: f.id }; loadBibliography(); };
    chip.oncontextmenu = (ev) => { ev.preventDefault(); showContextMenu(ev.clientX, ev.clientY, [
      { label: "Rename…", action: () => openModal("Rename folder", f.name, "Save", async (name) => { await invoke("rename_bib_folder", { id: f.id, name }); loadBibliography(); }) },
      { label: "Set color…", action: () => openColorPicker({ id: f.id, name: f.name, color: f.color }, async (color) => { await invoke("set_bib_folder_color", { id: f.id, color }); loadBibliography(); }) },
      { sep: true },
      { label: "Delete folder", danger: true, action: async () => { await invoke("delete_bib_folder", { id: f.id }); if (state.bibFilter?.id === f.id) state.bibFilter = null; loadBibliography(); } },
    ]); };
    bar.appendChild(chip);
  }
  for (const t of state.bibTags) {
    const n = entries.filter((e) => (e.tag_ids || []).includes(t.id)).length;
    const chip = el("span", "bib-chip" + (state.bibFilter?.type === "tag" && state.bibFilter.id === t.id ? " active" : ""));
    chip.innerHTML = `#${esc(t.name)} ${n ? `<span style="opacity:.6">${n}</span>` : ""}`;
    chip.onclick = () => { state.bibFilter = { type: "tag", id: t.id }; loadBibliography(); };
    chip.oncontextmenu = (ev) => { ev.preventDefault(); showContextMenu(ev.clientX, ev.clientY, [
      { label: "Delete tag", danger: true, action: async () => { await invoke("delete_bib_tag", { id: t.id }); if (state.bibFilter?.id === t.id) state.bibFilter = null; loadBibliography(); } },
    ]); };
    bar.appendChild(chip);
  }
  // New folder / tag buttons.
  const addF = el("span", "bib-chip", "+ folder");
  addF.onclick = () => openModal("New bib folder", "", "Create", async (name) => { if (name.trim()) { await invoke("add_bib_folder", { name: name.trim() }); loadBibliography(); } });
  bar.appendChild(addF);
  const addT = el("span", "bib-chip", "+ tag");
  addT.onclick = () => openModal("New bib tag", "", "Create", async (name) => { if (name.trim()) { await invoke("add_bib_tag", { name: name.trim(), color: null }); loadBibliography(); } });
  bar.appendChild(addT);
}

function renderBibSelectionBar(entries) {
  document.querySelector("#bib-select-bar")?.remove();
  const n = state.selectedBibIds.size;
  if (n < 1) return;
  const bar = el("div", "sidebar-select-bar");
  bar.id = "bib-select-bar";
  bar.style.margin = "0 16px 8px";
  bar.innerHTML = `<span>${n} selected</span>`;
  const org = el("button", "", "Organize ▾");
  org.onclick = (ev) => openBibOrganizeMenu(ev, [...state.selectedBibIds]);
  const del = el("button", "danger", "Delete");
  del.onclick = async () => {
    const ok = await window.__TAURI__.dialog.confirm(`Remove ${n} citation${n > 1 ? "s" : ""}?`, { title: "Remove citations", kind: "warning" });
    if (!ok) return;
    for (const id of state.selectedBibIds) await invoke("delete_bib_entry", { id });
    state.selectedBibIds.clear();
    loadBibliography();
  };
  const clear = el("button", "", "Clear");
  clear.onclick = () => { state.selectedBibIds.clear(); loadBibliography(); };
  bar.append(org, del, clear);
  const gbar = $("#bib-group-bar");
  (gbar || $("#bib-controls")).after(bar);
}

function openBibOrganizeMenu(ev, bibIds) {
  ev.stopPropagation?.();
  const items = [];
  if (state.bibFolders.length) {
    for (const f of state.bibFolders)
      items.push({ label: `📁 Add to ${f.name}`, action: async () => { for (const id of bibIds) await invoke("assign_bib_folder", { bibId: id, folderId: f.id }); loadBibliography(); } });
    items.push({ sep: true });
  }
  if (state.bibTags.length) {
    for (const t of state.bibTags)
      items.push({ label: `# ${t.name}`, action: async () => { for (const id of bibIds) await invoke("assign_bib_tag", { bibId: id, tagId: t.id }); loadBibliography(); } });
    items.push({ sep: true });
  }
  items.push({ label: "New folder…", action: () => openModal("New bib folder", "", "Create", async (name) => { if (!name.trim()) return; const f = await invoke("add_bib_folder", { name: name.trim() }); for (const id of bibIds) await invoke("assign_bib_folder", { bibId: id, folderId: f.id }); loadBibliography(); }) });
  items.push({ label: "New tag…", action: () => openModal("New bib tag", "", "Create", async (name) => { if (!name.trim()) return; const t = await invoke("add_bib_tag", { name: name.trim(), color: null }); for (const id of bibIds) await invoke("assign_bib_tag", { bibId: id, tagId: t.id }); loadBibliography(); }) });
  if (state.bibFilter) {
    items.push({ sep: true });
    const label = state.bibFilter.type === "folder" ? "Remove from this folder" : "Remove this tag";
    items.push({ label, action: async () => {
      for (const id of bibIds) {
        if (state.bibFilter.type === "folder") await invoke("unassign_bib_folder", { bibId: id, folderId: state.bibFilter.id });
        else await invoke("unassign_bib_tag", { bibId: id, tagId: state.bibFilter.id });
      }
      loadBibliography();
    }});
  }
  showContextMenu(ev.clientX || 200, ev.clientY || 200, items);
}

async function addBibByDoi() {
  const input = $("#bib-doi-input");
  const doi = input.value.trim();
  if (!doi) return;
  toast("Looking up DOI…");
  try {
    const c = await invoke("fetch_citation", { doi });
    await invoke("add_bib_entry", { doi: c.doi, rawJson: JSON.stringify(c) });
    input.value = "";
    toast("Citation added");
    loadBibliography();
  } catch (err) {
    toast(String(err));
  }
}

// Resolve a saved arXiv paper to its published DOI and add the journal citation
// to the bibliography. Returns "added" | "preprint" | "error".
async function addPaperToBibliography(arxivId, silent = false) {
  try {
    const c = await invoke("fetch_published_citation", { arxivId: arxivId });
    if (!c) {
      if (!silent) toast("No published version found yet (still a preprint)");
      return "preprint";
    }
    await invoke("add_bib_entry", { doi: c.doi, rawJson: JSON.stringify(c) });
    if (!silent) toast(`Added: ${c.title.slice(0, 40)}${c.title.length > 40 ? "…" : ""}`);
    return "added";
  } catch (err) {
    if (!silent) toast(String(err));
    return "error";
  }
}

// Add the arXiv *preprint* itself as a bibliography entry (no DOI lookup).
async function addPreprintToBibliography(p, silent = false) {
  try {
    const paper = p.title ? p : resolvePaper(p);
    if (!paper) { if (!silent) toast("Paper not found"); return "error"; }
    const c = {
      doi: paper.doi || `arXiv:${paper.arxiv_id}`,
      title: paper.title,
      authors: paper.authors || [],
      year: paper.published ? Number(String(paper.published).slice(0, 4)) : null,
      container: "arXiv preprint",
      volume: null, issue: null, page: null,
      publisher: "arXiv",
      url: paper.abs_url || `https://arxiv.org/abs/${paper.arxiv_id}`,
      arxiv_id: paper.arxiv_id,
      is_preprint: true,
    };
    await invoke("add_bib_entry", { doi: c.doi, rawJson: JSON.stringify(c) });
    if (!silent) toast(`Added preprint: ${paper.title.slice(0, 36)}${paper.title.length > 36 ? "…" : ""}`);
    return "added";
  } catch (err) {
    if (!silent) toast(String(err));
    return "error";
  }
}

async function addManyToBibliography(ids) {
  if (!ids.length) return;
  toast(`Resolving ${ids.length} paper${ids.length > 1 ? "s" : ""}…`);
  let added = 0, preprint = 0, failed = 0;
  for (const id of ids) {
    const r = await addPaperToBibliography(id, true);
    if (r === "added") added++;
    else if (r === "preprint") preprint++;
    else failed++;
    // Gentle pacing for the external APIs.
    await new Promise((r) => setTimeout(r, 400));
  }
  const parts = [`${added} added`];
  if (preprint) parts.push(`${preprint} preprint-only`);
  if (failed) parts.push(`${failed} failed`);
  toast(parts.join(", "));
}

async function exportBibliography(format) {
  try {
    const entries = await invoke("get_bib_entries");
    if (!entries.length) { toast("No citations to export"); return; }
    const cites = entries.map((e) => { try { return JSON.parse(e.raw_json); } catch { return null; } }).filter(Boolean);
    const fn = format === "ris" ? citationToRis : citationToBibtex;
    const ext = format === "ris" ? "ris" : "bib";
    const contents = cites.map(fn).join("\n\n") + "\n";
    const path = await dialogSave({
      title: "Export bibliography",
      defaultPath: `bibliography.${ext}`,
      filters: [{ name: format, extensions: [ext] }],
    });
    if (!path) return;
    await invoke("write_text_file", { path, contents });
    toast(`Exported ${cites.length} citations`);
  } catch (err) { toast("Export failed: " + err); }
}

// ---- Bibliography import (.bib / .ris) ----
function parseBibtex(text) {
  const out = [];
  // Split on @type{ ... } records by tracking braces.
  const re = /@(\w+)\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    const type = m[1].toLowerCase();
    let i = re.lastIndex, depth = 1;
    while (i < text.length && depth > 0) { if (text[i] === "{") depth++; else if (text[i] === "}") depth--; i++; }
    const body = text.slice(re.lastIndex, i - 1);
    const fields = {};
    // First token before first comma is the cite key (ignored).
    const fieldStr = body.slice(body.indexOf(",") + 1);
    const fre = /(\w+)\s*=\s*(\{([^{}]*(\{[^{}]*\})*[^{}]*)\}|"[^"]*"|[^,]+)/g;
    let fm;
    while ((fm = fre.exec(fieldStr))) {
      let v = fm[2].trim().replace(/^[{"]|[}"]$/g, "").replace(/\s+/g, " ").trim();
      fields[fm[1].toLowerCase()] = v;
    }
    const authors = (fields.author || "").split(/\s+and\s+/).map((a) => {
      a = a.trim();
      if (a.includes(",")) { const [f, g] = a.split(","); return `${g.trim()} ${f.trim()}`.trim(); }
      return a;
    }).filter(Boolean);
    const isPre = type === "misc" || /arxiv/i.test(fields.archiveprefix || "") || /arxiv/i.test(fields.journal || fields.howpublished || "");
    out.push({
      doi: fields.doi || (fields.eprint ? `arXiv:${fields.eprint}` : (fields.title || "").slice(0, 40)),
      title: fields.title || "(untitled)",
      authors,
      year: fields.year ? Number(fields.year) : null,
      container: fields.journal || fields.booktitle || (isPre ? "arXiv preprint" : null),
      volume: fields.volume || null, issue: fields.number || null, page: fields.pages || null,
      publisher: fields.publisher || (isPre ? "arXiv" : null),
      url: fields.url || null,
      arxiv_id: fields.eprint || null,
      is_preprint: isPre,
    });
  }
  return out;
}
function parseRis(text) {
  const out = [];
  const records = text.split(/\n(?=TY\s+-)/);
  for (const rec of records) {
    if (!/TY\s+-/.test(rec)) continue;
    const get = (tag) => { const m = rec.match(new RegExp(`^${tag}\\s+-\\s+(.*)$`, "m")); return m ? m[1].trim() : null; };
    const authors = [...rec.matchAll(/^(?:AU|A1)\s+-\s+(.*)$/gm)].map((m) => {
      let a = m[1].trim();
      if (a.includes(",")) { const [f, g] = a.split(","); return `${g.trim()} ${f.trim()}`.trim(); }
      return a;
    });
    const ty = get("TY");
    const isPre = ty === "GEN" || /arxiv/i.test(get("JO") || get("JF") || "");
    out.push({
      doi: get("DO") || (get("UR") || "").replace(/^https?:\/\/(dx\.)?doi\.org\//, "") || (get("TI") || "").slice(0, 40),
      title: get("TI") || get("T1") || "(untitled)",
      authors,
      year: get("PY") ? Number((get("PY").match(/\d{4}/) || [])[0]) : null,
      container: get("JO") || get("JF") || get("T2") || (isPre ? "arXiv preprint" : null),
      volume: get("VL"), issue: get("IS"), page: get("SP"),
      publisher: get("PB") || (isPre ? "arXiv" : null),
      url: get("UR"),
      is_preprint: isPre,
    });
  }
  return out;
}

async function importBibliography() {
  try {
    const path = await window.__TAURI__.dialog.open({
      title: "Import .bib or .ris",
      filters: [{ name: "Bibliography", extensions: ["bib", "ris", "txt"] }],
      multiple: false, directory: false,
    });
    if (!path) return;
    const text = await invoke("read_text_file", { path });
    const isRis = /\.ris$/i.test(path) || /^TY\s+-/m.test(text);
    const cites = isRis ? parseRis(text) : parseBibtex(text);
    if (!cites.length) { toast("No entries found in that file"); return; }
    let n = 0;
    for (const c of cites) { await invoke("add_bib_entry", { doi: c.doi, rawJson: JSON.stringify(c) }); n++; }
    toast(`Imported ${n} citation${n > 1 ? "s" : ""}`);
    loadBibliography();
  } catch (err) { toast("Import failed: " + err); }
}

// ---------- arXiv category taxonomy ----------
const ARXIV_CATEGORIES = {
  "Physics — Condensed Matter": [
    ["cond-mat.dis-nn", "Disordered Systems and Neural Networks"],
    ["cond-mat.mtrl-sci", "Materials Science"],
    ["cond-mat.mes-hall", "Mesoscale and Nanoscale Physics"],
    ["cond-mat.other", "Other Condensed Matter"],
    ["cond-mat.quant-gas", "Quantum Gases"],
    ["cond-mat.soft", "Soft Condensed Matter"],
    ["cond-mat.stat-mech", "Statistical Mechanics"],
    ["cond-mat.str-el", "Strongly Correlated Electrons"],
    ["cond-mat.supr-con", "Superconductivity"],
  ],
  "Physics — General": [
    ["physics.acc-ph", "Accelerator Physics"],
    ["physics.app-ph", "Applied Physics"],
    ["physics.atom-ph", "Atomic Physics"],
    ["physics.atm-clus", "Atomic and Molecular Clusters"],
    ["physics.bio-ph", "Biological Physics"],
    ["physics.chem-ph", "Chemical Physics"],
    ["physics.class-ph", "Classical Physics"],
    ["physics.comp-ph", "Computational Physics"],
    ["physics.data-an", "Data Analysis, Statistics and Probability"],
    ["physics.flu-dyn", "Fluid Dynamics"],
    ["physics.gen-ph", "General Physics"],
    ["physics.geo-ph", "Geophysics"],
    ["physics.hist-ph", "History and Philosophy of Physics"],
    ["physics.ins-det", "Instrumentation and Detectors"],
    ["physics.med-ph", "Medical Physics"],
    ["physics.optics", "Optics"],
    ["physics.ed-ph", "Physics Education"],
    ["physics.soc-ph", "Physics and Society"],
    ["physics.plasm-ph", "Plasma Physics"],
    ["physics.pop-ph", "Popular Physics"],
    ["physics.space-ph", "Space Physics"],
  ],
  "Physics — Other Areas": [
    ["astro-ph.CO", "Cosmology and Nongalactic Astrophysics"],
    ["astro-ph.EP", "Earth and Planetary Astrophysics"],
    ["astro-ph.GA", "Astrophysics of Galaxies"],
    ["astro-ph.HE", "High Energy Astrophysical Phenomena"],
    ["astro-ph.IM", "Instrumentation and Methods for Astrophysics"],
    ["astro-ph.SR", "Solar and Stellar Astrophysics"],
    ["gr-qc", "General Relativity and Quantum Cosmology"],
    ["hep-ex", "High Energy Physics — Experiment"],
    ["hep-lat", "High Energy Physics — Lattice"],
    ["hep-ph", "High Energy Physics — Phenomenology"],
    ["hep-th", "High Energy Physics — Theory"],
    ["math-ph", "Mathematical Physics"],
    ["nlin.AO", "Adaptation and Self-Organizing Systems"],
    ["nlin.CG", "Cellular Automata and Lattice Gases"],
    ["nlin.CD", "Chaotic Dynamics"],
    ["nlin.SI", "Exactly Solvable and Integrable Systems"],
    ["nlin.PS", "Pattern Formation and Solitons"],
    ["nucl-ex", "Nuclear Experiment"],
    ["nucl-th", "Nuclear Theory"],
    ["quant-ph", "Quantum Physics"],
  ],
  "Computer Science": [
    ["cs.AI", "Artificial Intelligence"],
    ["cs.CL", "Computation and Language"],
    ["cs.CC", "Computational Complexity"],
    ["cs.CE", "Computational Engineering, Finance, and Science"],
    ["cs.CG", "Computational Geometry"],
    ["cs.GT", "Computer Science and Game Theory"],
    ["cs.CV", "Computer Vision and Pattern Recognition"],
    ["cs.CY", "Computers and Society"],
    ["cs.CR", "Cryptography and Security"],
    ["cs.DS", "Data Structures and Algorithms"],
    ["cs.DB", "Databases"],
    ["cs.DL", "Digital Libraries"],
    ["cs.DM", "Discrete Mathematics"],
    ["cs.DC", "Distributed, Parallel, and Cluster Computing"],
    ["cs.ET", "Emerging Technologies"],
    ["cs.FL", "Formal Languages and Automata Theory"],
    ["cs.GL", "General Literature"],
    ["cs.GR", "Graphics"],
    ["cs.AR", "Hardware Architecture"],
    ["cs.HC", "Human-Computer Interaction"],
    ["cs.IR", "Information Retrieval"],
    ["cs.IT", "Information Theory"],
    ["cs.LG", "Machine Learning"],
    ["cs.LO", "Logic in Computer Science"],
    ["cs.MS", "Mathematical Software"],
    ["cs.MA", "Multiagent Systems"],
    ["cs.MM", "Multimedia"],
    ["cs.NI", "Networking and Internet Architecture"],
    ["cs.NE", "Neural and Evolutionary Computing"],
    ["cs.NA", "Numerical Analysis"],
    ["cs.OS", "Operating Systems"],
    ["cs.OH", "Other Computer Science"],
    ["cs.PF", "Performance"],
    ["cs.PL", "Programming Languages"],
    ["cs.RO", "Robotics"],
    ["cs.SI", "Social and Information Networks"],
    ["cs.SE", "Software Engineering"],
    ["cs.SD", "Sound"],
    ["cs.SC", "Symbolic Computation"],
    ["cs.SY", "Systems and Control"],
  ],
  "Mathematics": [
    ["math.AG", "Algebraic Geometry"],
    ["math.AT", "Algebraic Topology"],
    ["math.AP", "Analysis of PDEs"],
    ["math.CT", "Category Theory"],
    ["math.CA", "Classical Analysis and ODEs"],
    ["math.CO", "Combinatorics"],
    ["math.AC", "Commutative Algebra"],
    ["math.CV", "Complex Variables"],
    ["math.DG", "Differential Geometry"],
    ["math.DS", "Dynamical Systems"],
    ["math.FA", "Functional Analysis"],
    ["math.GM", "General Mathematics"],
    ["math.GN", "General Topology"],
    ["math.GT", "Geometric Topology"],
    ["math.GR", "Group Theory"],
    ["math.HO", "History and Overview"],
    ["math.IT", "Information Theory"],
    ["math.KT", "K-Theory and Homology"],
    ["math.LO", "Logic"],
    ["math.MP", "Mathematical Physics"],
    ["math.MG", "Metric Geometry"],
    ["math.NT", "Number Theory"],
    ["math.NA", "Numerical Analysis"],
    ["math.OA", "Operator Algebras"],
    ["math.OC", "Optimization and Control"],
    ["math.PR", "Probability"],
    ["math.QA", "Quantum Algebra"],
    ["math.RT", "Representation Theory"],
    ["math.RA", "Rings and Algebras"],
    ["math.SP", "Spectral Theory"],
    ["math.ST", "Statistics Theory"],
    ["math.SG", "Symplectic Geometry"],
  ],
  "Quantitative Biology": [
    ["q-bio.BM", "Biomolecules"],
    ["q-bio.CB", "Cell Behavior"],
    ["q-bio.GN", "Genomics"],
    ["q-bio.MN", "Molecular Networks"],
    ["q-bio.NC", "Neurons and Cognition"],
    ["q-bio.OT", "Other Quantitative Biology"],
    ["q-bio.PE", "Populations and Evolution"],
    ["q-bio.QM", "Quantitative Methods"],
    ["q-bio.SC", "Subcellular Processes"],
    ["q-bio.TO", "Tissues and Organs"],
  ],
  "Quantitative Finance": [
    ["q-fin.CP", "Computational Finance"],
    ["q-fin.EC", "Economics"],
    ["q-fin.GN", "General Finance"],
    ["q-fin.MF", "Mathematical Finance"],
    ["q-fin.PM", "Portfolio Management"],
    ["q-fin.PR", "Pricing of Securities"],
    ["q-fin.RM", "Risk Management"],
    ["q-fin.ST", "Statistical Finance"],
    ["q-fin.TR", "Trading and Market Microstructure"],
  ],
  "Statistics": [
    ["stat.AP", "Applications"],
    ["stat.CO", "Computation"],
    ["stat.ML", "Machine Learning"],
    ["stat.ME", "Methodology"],
    ["stat.OT", "Other Statistics"],
    ["stat.TH", "Statistics Theory"],
  ],
  "Economics & EESS": [
    ["econ.EM", "Econometrics"],
    ["econ.GN", "General Economics"],
    ["econ.TH", "Theoretical Economics"],
    ["eess.AS", "Audio and Speech Processing"],
    ["eess.IV", "Image and Video Processing"],
    ["eess.SP", "Signal Processing"],
    ["eess.SY", "Systems and Control"],
  ],
};

function openCategoryPicker() {
  const modal = $("#category-modal");
  const listEl = $("#category-list");
  const searchEl = $("#category-search");
  searchEl.value = "";
  const picked = new Set();

  const render = (filter = "") => {
    const f = filter.toLowerCase();
    listEl.innerHTML = "";
    for (const [group, cats] of Object.entries(ARXIV_CATEGORIES)) {
      const matching = cats.filter(([code, name]) =>
        !f || code.toLowerCase().includes(f) || name.toLowerCase().includes(f) || group.toLowerCase().includes(f));
      if (!matching.length) continue;
      listEl.appendChild(el("div", "cat-group-label", esc(group)));
      for (const [code, name] of matching) {
        const already = state.feedCategories.includes(code);
        const row = el("label", "cat-option" + (already ? " already" : ""));
        row.innerHTML = `<input type="checkbox" ${already ? "checked disabled" : ""} ${picked.has(code) ? "checked" : ""}/>
          <span class="cat-code">${esc(code)}</span><span class="cat-name">${esc(name)}</span>`;
        const cb = row.querySelector("input");
        if (!already) {
          cb.onchange = () => { if (cb.checked) picked.add(code); else picked.delete(code); };
        }
        listEl.appendChild(row);
      }
    }
    if (!listEl.children.length) listEl.innerHTML = `<p class="settings-hint">No categories match "${esc(filter)}".</p>`;
  };
  render();
  const catClear = $("#category-search-clear");
  searchEl.oninput = () => {
    catClear.classList.toggle("hidden", !searchEl.value);
    render(searchEl.value);
  };
  catClear.onclick = () => {
    searchEl.value = "";
    catClear.classList.add("hidden");
    render("");
    searchEl.focus();
  };
  catClear.classList.add("hidden");

  modal.classList.remove("hidden");
  searchEl.focus();
  $("#category-cancel").onclick = () => modal.classList.add("hidden");
  $("#category-ok").onclick = async () => {
    for (const code of picked) {
      if (!state.feedCategories.includes(code)) state.feedCategories.push(code);
    }
    modal.classList.add("hidden");
    await saveFeedCategories();
    renderFeedControls();
    loadFeed();
  };
}

// ---------- Author search ----------
function searchByAuthor(author) {
  selectView({ type: "search" });
  $("#search-input").value = author;
  $("#search-clear").classList.remove("hidden");
  // Ensure advanced is closed so it's a plain author search; use au: prefix via advanced field.
  // We do a direct author-field query.
  runAuthorSearch(author);
}

async function runAuthorSearch(author) {
  const list = $("#paper-list");
  list.innerHTML = '<div class="loading">Searching by author…</div>';
  $("#list-title").textContent = "Search Results";
  const q = `au:"${author}"`;
  searchPaging = { query: q, sort: "submittedDate", start: 0, pageSize: 50, total: 0, done: false, loading: true };
  state.searchResults = [];
  try {
    const { papers: res, total } = await invoke("search_arxiv", { query: q, sortBy: "submittedDate", maxResults: 50, start: 0 });
    state.searchResults = res;
    searchPaging.start = res.length;
    searchPaging.total = total;
    searchPaging.done = res.length < 50 || res.length >= total;
    searchPaging.loading = false;
    renderList();
    toast(`Papers by ${author}`);
  } catch (err) {
    searchPaging.loading = false;
    list.innerHTML = `<div class="empty-list"><div class="empty-icon">&#9888;</div><p>${esc(String(err))}</p></div>`;
  }
}

// ---------- Citation metrics (Semantic Scholar) ----------
// Lookups are batched: every card that needs metrics registers its container,
// and a short debounce later all pending ids go to Semantic Scholar in a
// single batch request (hundreds of ids per call) instead of one throttled
// request per paper. Results are cached in localStorage for a few days so
// revisiting a list is instant and doesn't touch the network.
const METRICS_TTL_MS = 3 * 24 * 3600 * 1000;
const METRICS_STORE_KEY = "metricsCache.v1";
const metricsWaiting = new Map(); // base id -> Set(container)
let metricsTimer = null;
let metricsInFlight = false;

(function loadMetricsStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(METRICS_STORE_KEY) || "{}");
    const now = Date.now();
    for (const [id, entry] of Object.entries(raw)) {
      if (entry && now - entry.t < METRICS_TTL_MS) state.metricsCache[id] = entry.m;
    }
  } catch {}
})();
function persistMetricsStore(fresh) {
  try {
    const raw = JSON.parse(localStorage.getItem(METRICS_STORE_KEY) || "{}");
    const now = Date.now();
    for (const m of fresh) raw[m.arxiv_id] = { t: now, m };
    for (const [id, entry] of Object.entries(raw)) {
      if (!entry || now - entry.t >= METRICS_TTL_MS) delete raw[id];
    }
    localStorage.setItem(METRICS_STORE_KEY, JSON.stringify(raw));
  } catch {}
}

async function flushMetrics() {
  metricsTimer = null;
  if (metricsInFlight) { metricsTimer = setTimeout(flushMetrics, 300); return; }
  // Only fetch for ids whose cards are still on screen.
  const ids = [];
  for (const [id, set] of metricsWaiting) {
    for (const c of set) if (!c.isConnected) set.delete(c);
    if (set.size) ids.push(id); else metricsWaiting.delete(id);
  }
  if (!ids.length) return;
  const batch = ids.slice(0, 400);
  metricsInFlight = true;
  try {
    const results = await invoke("fetch_metrics_batch", { arxivIds: batch });
    for (const m of results) {
      state.metricsCache[m.arxiv_id] = m;
      for (const c of metricsWaiting.get(m.arxiv_id) || []) {
        if (c.isConnected) { c.classList.remove("metrics-loading"); renderMetrics(c, m); }
      }
      metricsWaiting.delete(m.arxiv_id);
    }
    persistMetricsStore(results);
  } catch (err) {
    // Leave cards blank on failure; they retry the next time they're rendered.
    for (const id of batch) {
      for (const c of metricsWaiting.get(id) || []) { c.classList.remove("metrics-loading"); c.textContent = ""; }
      metricsWaiting.delete(id);
    }
  } finally {
    metricsInFlight = false;
  }
  if (metricsWaiting.size) metricsTimer = setTimeout(flushMetrics, 300);
}

function loadMetricsInto(container, arxivId) {
  if (!container) return;
  const base = baseId(arxivId);
  if (state.metricsCache[base]) { renderMetrics(container, state.metricsCache[base]); return; }
  container.classList.add("metrics-loading");
  container.textContent = "···";
  if (!metricsWaiting.has(base)) metricsWaiting.set(base, new Set());
  metricsWaiting.get(base).add(container);
  if (!metricsTimer) metricsTimer = setTimeout(flushMetrics, 120);
}

function renderMetrics(container, m) {
  const bits = [];
  if (m.citation_count != null) {
    bits.push(`<span class="metric-cite">${m.citation_count} citation${m.citation_count === 1 ? "" : "s"}</span>`);
  }
  if (m.venue) bits.push(`<span class="metric-venue">${esc(m.venue)}</span>`);
  else if (m.year) bits.push(`<span class="metric-venue">${m.year}</span>`);
  container.innerHTML = bits.join("");
}

// Update active/selected styling in place — no list rebuild, so it's cheap
// and never disturbs scroll position or views that aren't paper lists.
function refreshListHighlight() {
  for (const card of document.querySelectorAll("#paper-list .paper-card[data-id]")) {
    const id = card.dataset.id;
    const sel = state.selectedIds.has(id);
    card.classList.toggle("active", state.selectedPaper?.arxiv_id === id);
    card.classList.toggle("multi-selected", sel);
    const cb = card.querySelector(".card-check");
    if (cb) cb.checked = sel;
  }
  const t = state.view.type;
  if (t !== "history" && t !== "bibliography") renderSelectionToolbar(currentPapers());
}

function toggleSelect(id, papers) {
  if (state.selectedIds.has(id)) state.selectedIds.delete(id);
  else state.selectedIds.add(id);
  state.lastClickedId = id;
  refreshListHighlight();
}

function selectRange(fromId, toId, papers) {
  const ids = papers.map((p) => p.arxiv_id);
  const a = ids.indexOf(fromId), b = ids.indexOf(toId);
  if (a < 0 || b < 0) return;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  for (let i = lo; i <= hi; i++) state.selectedIds.add(ids[i]);
  state.lastClickedId = toId;
  refreshListHighlight();
}

function renderSelectionToolbar(papers) {
  const existing = $("#selection-toolbar");
  if (existing) existing.remove();
  const n = state.selectedIds.size;
  if (n === 0) return;
  const searching = state.view.type === "search" || state.view.type === "saved" || state.view.type === "feed";
  const inTrash = state.view.type === "smart" && state.view.smart === "trash";
  const bar = el("div", "selection-toolbar");
  bar.id = "selection-toolbar";
  bar.innerHTML = `<span class="sel-count">${n} selected</span>`;
  const actions = el("div", "sel-actions");

  const mkBtn = (label, fn, danger) => {
    const b = el("button", danger ? "danger-btn" : "", label);
    b.onclick = fn;
    return b;
  };

  if (searching) {
    actions.append(mkBtn("Add to Library", async () => {
      const papers = [...state.selectedIds].filter((id) => !isInLibrary(id)).map(resolvePaper).filter(Boolean);
      if (papers.length) await invoke("save_papers", { papers, collectionId: null });
      state.selectedIds.clear();
      await loadLibrary();
      toast("Added to library");
    }));
    if (state.collections.length) {
      const sel = el("select", "save-collection-select");
      sel.innerHTML = `<option value="">Add to collection…</option>` +
        state.collections.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
      sel.onchange = async () => {
        const cid = sel.value; if (!cid) return;
        const papers = [...state.selectedIds].map(resolvePaper).filter(Boolean);
        await invoke("save_papers", { papers, collectionId: cid });
        state.selectedIds.clear();
        await loadLibrary();
        toast("Saved to collection");
      };
      actions.append(sel);
    }
  } else if (inTrash) {
    actions.append(mkBtn("Restore", () => restorePapers([...state.selectedIds])));
    actions.append(mkBtn("Delete permanently", () => deletePapersForever([...state.selectedIds]), true));
  } else {
    if (state.collections.length) {
      const sel = el("select", "save-collection-select");
      sel.innerHTML = `<option value="">Move to collection…</option>` +
        state.collections.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
      sel.onchange = async () => {
        const cid = sel.value; if (!cid) return;
        await invoke("bulk_assign", { ids: [...state.selectedIds], collectionId: cid });
        state.selectedIds.clear(); await loadLibrary(); toast("Added to collection");
      };
      actions.append(sel);
    }
    if (state.view.type === "collection") {
      actions.append(mkBtn("Remove from collection", async () => {
        await invoke("bulk_unassign", { ids: [...state.selectedIds], collectionId: state.view.id });
        state.selectedIds.clear(); await loadLibrary();
      }));
    }
    actions.append(mkBtn("→ Bibliography", async () => {
      const ids = [...state.selectedIds];
      state.selectedIds.clear(); renderList();
      await addManyToBibliography(ids);
    }));
    actions.append(mkBtn("Move to Trash", () => trashPapers([...state.selectedIds]), true));
  }
  actions.append(mkBtn("Clear", () => { state.selectedIds.clear(); refreshListHighlight(); }));

  // Select all papers currently shown in this view.
  const allShown = papers || currentPapers();
  const allSelected = allShown.length > 0 && allShown.every((p) => state.selectedIds.has(p.arxiv_id));
  if (!allSelected) {
    const selAllBtn = mkBtn(`Select all (${allShown.length})`, () => {
      for (const p of allShown) state.selectedIds.add(p.arxiv_id);
      refreshListHighlight();
    });
    selAllBtn.classList.add("sel-all-btn");
    actions.prepend(selAllBtn);
  }

  bar.append(actions);
  $("#paper-list").before(bar);
}

function searchResultMenu(e, p) {
  e.preventDefault();
  const sel = state.selectedIds;
  const targetIds = (sel.size > 1 && sel.has(p.arxiv_id)) ? [...sel] : [p.arxiv_id];
  const multi = targetIds.length > 1;
  const label = (s) => multi ? `${s} (${targetIds.length})` : s;
  const getPaper = (id) => resolvePaper(id);
  const items = [];
  if (!multi) {
    if (isInLibrary(p.arxiv_id)) {
      // Already in the library — show a non-clickable status line.
      items.push({ label: "✓ Added to library", disabled: true });
    } else if (isTrashed(p.arxiv_id)) {
      // In trash — offer to restore rather than misleadingly "add".
      items.push({ label: "Restore from trash", action: async () => {
        await invoke("set_trashed", { id: p.arxiv_id, trashed: false });
        await loadLibrary(); renderList(); toast("Restored from trash");
      }});
    } else {
      items.push({ label: "Add to Library", action: async () => {
        await invoke("save_papers", { papers: [resolvePaper(p.arxiv_id) || p], collectionId: null });
        await loadLibrary(); renderList(); toast("Added to library");
      }});
    }
  } else {
    items.push({ label: label("Add to Library"), action: async () => {
      const papers = targetIds.filter((id) => !isInLibrary(id)).map(getPaper).filter(Boolean);
      if (papers.length) await invoke("save_papers", { papers, collectionId: null });
      state.selectedIds.clear(); await loadLibrary(); renderList(); toast("Added to library");
    }});
  }
  if (state.collections.length) {
    items.push({ sep: true });
    for (const c of state.collections) {
      items.push({ label: `${label("Add to")}: ${c.name}`, action: async () => {
        await invoke("save_papers", { papers: targetIds.map(getPaper).filter(Boolean), collectionId: c.id });
        state.selectedIds.clear(); await loadLibrary(); renderList(); toast(`Saved to ${c.name}`);
      }});
    }
  }
  if (!multi) {
    items.push({ sep: true });
    items.push({ label: "Open abstract page", action: () => openUrl(p.abs_url) });
  }
  showContextMenu(e.clientX, e.clientY, items);
}

function paperMenu(e, p) {
  e.preventDefault();
  const sel = state.selectedIds;
  const targetIds = (sel.size > 1 && sel.has(p.arxiv_id)) ? [...sel] : [p.arxiv_id];
  const multi = targetIds.length > 1;
  const label = (s) => multi ? `${s} (${targetIds.length})` : s;
  const items = [];
  const inTrash = state.view.type === "smart" && state.view.smart === "trash";

  if (inTrash) {
    items.push({ label: label("Restore"), action: () => restorePapers(targetIds) });
    items.push({ sep: true });
    items.push({ label: label("Delete permanently"), danger: true, action: () => deletePapersForever(targetIds) });
    showContextMenu(e.clientX, e.clientY, items);
    return;
  }

  // Add to collection (submenu-style flat list)
  if (state.collections.length) {
    for (const c of state.collections) {
      items.push({ label: `${label("Add to")}: ${c.name}`, action: async () => {
        let added = 0;
        for (const id of targetIds) { if (await addToCollection(id, c.id, c.name)) added++; }
        if (added) toast(multi ? `Added ${added} to ${c.name}` : `Added to ${c.name}`);
      }});
    }
    items.push({ label: "+ New collection…", action: () =>
      openModal("New Collection", "", "Create", async (name) => {
        if (!name?.trim()) return;
        const col = await invoke("add_collection", { name: name.trim(), parentId: null });
        for (const id of targetIds) await addToCollection(id, col.id, col.name);
        toast(`Added to ${col.name}`);
      }) });
    items.push({ sep: true });
  }

  // Tags: existing + create new
  const tagSub = [];
  for (const t of state.tags) {
    tagSub.push({ label: `#${t.name}`, action: async () => {
      let added = 0;
      for (const id of targetIds) { if (await addTagToPaper(id, t.id, t.name)) added++; }
      if (added) toast(`Tagged with #${t.name}`);
    }});
  }
  // Always offer create-new-tag
  items.push({ label: label("Add new tag…"), action: () =>
    openModal("New Tag", "", "Create", async (name) => {
      const t = await invoke("add_tag", { name, color: null });
      await invoke("bulk_tag", { ids: targetIds, tagId: t.id });
      await loadLibrary();
      toast(`Tagged with #${name}`);
    }) });
  if (tagSub.length) {
    for (const ts of tagSub) items.push(ts);
  }
  items.push({ sep: true });

  if (state.view.type === "collection") {
    items.push({ label: label("Remove from this collection"), action: async () => {
      await invoke("bulk_unassign", { ids: targetIds, collectionId: state.view.id });
      state.selectedIds.clear();
      await loadLibrary();
    }});
  }

  if (!multi) {
    items.push({ label: "Open abstract page", action: () => openUrl(p.abs_url) });
    if (state.papers.filter((x) => !x.trashed).length > 1) {
      items.push({ label: "Connect to…", action: () => startConnectFromMenu(p) });
    }
    items.push({ label: "Add to Bibliography", sub: [
      { label: "Published version", action: () => addPaperToBibliography(p.arxiv_id) },
      { label: "arXiv version", action: () => addPreprintToBibliography(p) },
    ]});
  } else {
    items.push({ label: label("Add to Bibliography"), sub: [
      { label: "Published version (each)", action: () => addManyToBibliography(targetIds) },
      { label: "arXiv version (each)", action: async () => {
        for (const id of targetIds) { await addPreprintToBibliography(id, true); await new Promise((r)=>setTimeout(r,150)); }
        toast(`${targetIds.length} preprints added`);
      }},
    ]});
  }
  // Reading status
  for (const st of ["unread", "reading", "read", "archived"]) {
    items.push({ label: label(`Mark ${st}`), action: async () => {
      await invoke("bulk_set_reading_status", { ids: targetIds, status: st });
      await loadLibrary();
    }});
  }
  items.push({ sep: true });

  const storedForMenu = state.papers.find((x) => x.arxiv_id === p.arxiv_id);
  if (!multi && storedForMenu?.local_pdf_path) {
    items.push({ label: "Delete downloaded PDF", action: async () => {
      await invoke("delete_pdf", { id: p.arxiv_id });
      await loadLibrary();
      if (state.selectedPaper?.arxiv_id === p.arxiv_id) {
        const updated = state.papers.find((x) => x.arxiv_id === p.arxiv_id);
        if (updated) selectPaper(updated);
      }
      toast("PDF deleted");
    }});
  }
  items.push({ label: label("Move to Trash"), danger: true, action: () => trashPapers(targetIds) });
  showContextMenu(e.clientX, e.clientY, items);
}

// ---------- Detail pane ----------
// Build the right-panel collection control: colored "Added to X" chips for each
// collection the paper belongs to, plus an add-to-collection button (with a
// create-new option). Returns HTML; handlers are wired in selectPaper.
function collectionControl(p, saved) {
  const memberIds = state.membership[p.arxiv_id] || new Set();
  const chips = [...memberIds].map((cid) => {
    const col = state.collections.find((c) => c.id === cid);
    if (!col) return "";
    const color = col.color || "var(--border)";
    return `<span class="coll-chip" data-cid="${col.id}" style="--chip-color:${esc(color)}">Added to ${esc(col.name)} <span class="coll-chip-x" data-cid="${col.id}" title="Remove">✕</span></span>`;
  }).join("");
  const addBtn = state.collections.length || true
    ? `<button id="add-collection-btn" class="add-coll-btn">${memberIds.size ? "+ Add to another" : (saved ? "+ Add to collection" : "+ Save to collection")} &#9662;</button>`
    : "";
  return `<span class="coll-control">${chips}${addBtn}</span>`;
}

function clearDetail() {
  state.selectedPaper = null;
  $("#detail-content").classList.add("hidden");
  $("#empty-detail").classList.remove("hidden");
}

function selectPaper(p) {
  state.selectedPaper = p;
  // Record in view history (fire-and-forget) unless the user disabled it.
  if (state.historyEnabled !== false) {
    invoke("record_view", { entry: {
      arxiv_id: p.arxiv_id, title: p.title, authors: p.authors || [],
      primary_category: p.primary_category || null, published: p.published || null,
      abs_url: p.abs_url || null, viewed_at: "",
    }}).catch(() => {});
  }
  // If the detail pane was collapsed, bring it back.
  if ($("#detail-pane").classList.contains("collapsed")) setDetailCollapsed(false);
  refreshListHighlight();
  $("#empty-detail").classList.add("hidden");
  const c = $("#detail-content");
  c.classList.remove("hidden");

  const saved = isSaved(p.arxiv_id);
  const stored = state.papers.find((x) => x.arxiv_id === p.arxiv_id);
  const hasLocal = stored?.local_pdf_path;
  const doi = (stored?.doi) || p.doi;
  const journal = (stored?.journal_ref) || p.journal_ref;
  const comment = (stored?.comment) || p.comment;
  const status = stored?.reading_status || "unread";

  // Mark as opened (fire-and-forget) when viewing a saved paper.
  if (saved) { invoke("mark_opened", { id: p.arxiv_id }).catch(() => {}); }

  const paperTagIds = state.paperTags[p.arxiv_id] || new Set();
  const tagsBlock = saved ? `
    <div class="detail-section-label">Tags</div>
    <div class="paper-tags-row" id="detail-tags">
      ${[...paperTagIds].map((tid) => {
        const t = state.tags.find((x) => x.id === tid);
        return t ? `<span class="paper-tag-chip" data-tid="${t.id}">#${esc(t.name)} ✕</span>` : "";
      }).join("")}
      <button id="add-paper-tag" class="ghost-btn" style="padding:2px 8px;font-size:11px">+ tag</button>
    </div>` : "";

  c.innerHTML = `
    <h1>${esc(p.title)}</h1>
    <div class="detail-authors">${esc(p.authors.join(", "))}</div>
    ${journal ? `<div class="detail-journal">${esc(journal)}</div>` : ""}
    ${comment ? `<div class="detail-comment" title="Author comments">${esc(comment)}</div>` : ""}
    <div class="detail-dates">Submitted ${fmtDate(p.published)}${p.updated && fmtDate(p.updated) !== fmtDate(p.published) ? ` · updated ${fmtDate(p.updated)}` : ""}${stored?.added_at ? ` · added to library ${fmtDate(stored.added_at)}` : ""}</div>
    <div class="detail-cats">${p.categories.slice(0, 6).map((x) => `<span class="cat-chip">${esc(x)}</span>`).join("")}</div>
    <div class="doi-line">arXiv: <a href="#" id="open-abs2">${esc(p.arxiv_id)}</a>${doi ? ` &nbsp;&middot;&nbsp; DOI: <a href="#" id="open-doi">${esc(doi)}</a>` : ""}</div>
    <div class="card-metrics" id="detail-metrics" data-metrics="${esc(p.arxiv_id)}"></div>
    <div class="detail-actions">
      <a href="#" id="open-abs">Abstract &#8599;</a>
      ${hasLocal ? `<button id="read-pdf">Read PDF</button>` : `<button id="dl-pdf">${saved ? "Download PDF" : "Save & Download PDF"}</button>`}
      ${hasLocal ? `<button id="del-pdf">Delete PDF</button>` : ""}
      ${hasLocal ? "" : `<button id="open-preview" title="Open without saving to your library">${IS_MAC ? "Open in Preview" : "Open in PDF viewer"}</button>`}
      <button id="save-downloads">Save to Downloads</button>
      <button id="cite-paper" title="Resolve published DOI and add to Bibliography">Cite ▾</button>
      ${isTrashed(p.arxiv_id)
        ? `<button class="primary" id="restore-lib">Restore from trash</button>`
        : (saved ? `<select id="status-select" class="status-select">
        ${["unread","reading","read","archived"].map((s) => `<option value="${s}"${s===status?" selected":""}>${s[0].toUpperCase()+s.slice(1)}</option>`).join("")}
      </select>` : `<button class="primary" id="save-lib">Save to Library</button>`)}
      ${isTrashed(p.arxiv_id) ? "" : collectionControl(p, saved)}
    </div>
    ${tagsBlock}
    <div class="detail-section-label">Abstract</div>
    <div class="abstract" id="detail-abstract">${esc(p.summary)}</div>
    ${saved ? `
      <div class="divider"></div>
      <div class="detail-section-label">Notes (Markdown)</div>
      <div class="note-rendered" id="note-rendered">${stored?.note ? renderMarkdown(stored.note) : '<span style="color:var(--text-dim)">Click to add notes…</span>'}</div>
      <textarea id="note-editor" class="hidden" placeholder="Your notes (Markdown supported)&#8230;">${esc(stored?.note || "")}</textarea>
      <div class="note-edit-hint">Click the note to edit · Markdown: **bold**, *italic*, # heading, - list, \`code\`</div>
    ` : ""}
  `;

  $("#open-abs").onclick = (e) => { e.preventDefault(); openUrl(p.abs_url); };
  $("#open-abs2").onclick = (e) => { e.preventDefault(); openUrl(p.abs_url); };
  loadMetricsInto($("#detail-metrics"), p.arxiv_id);
  typesetAbstractMath(p.summary);
  $("#open-doi")?.addEventListener("click", (e) => { e.preventDefault(); openUrl(`https://doi.org/${doi}`); });
  $("#save-lib")?.addEventListener("click", async () => {
    const did = await saveWithDupCheck(p, null);
    if (did) selectPaper(state.papers.find((x) => x.arxiv_id === p.arxiv_id) || p);
  });
  $("#restore-lib")?.addEventListener("click", async () => {
    await invoke("set_trashed", { id: p.arxiv_id, trashed: false });
    await loadLibrary();
    selectPaper(state.papers.find((x) => x.arxiv_id === p.arxiv_id) || p);
    toast("Restored from trash");
  });
  $("#status-select")?.addEventListener("change", async (ev) => {
    await invoke("set_reading_status", { id: p.arxiv_id, status: ev.target.value });
    const s = state.papers.find((x) => x.arxiv_id === p.arxiv_id);
    if (s) s.reading_status = ev.target.value;
    renderList();
  });
  // Add-to-collection button → menu of collections + create-new.
  $("#add-collection-btn")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const memberIds = state.membership[p.arxiv_id] || new Set();
    const items = state.collections
      .filter((c) => !memberIds.has(c.id))
      .map((c) => ({ label: c.name, action: async () => {
        const did = await saveWithDupCheck(p, c.id);
        if (did) selectPaper(state.papers.find((x) => x.arxiv_id === p.arxiv_id) || p);
      }}));
    items.push({ sep: true });
    items.push({ label: "+ Create new collection…", action: () =>
      openModal("New Collection", "", "Create", async (name) => {
        if (!name?.trim()) return;
        const col = await invoke("add_collection", { name: name.trim(), parentId: null });
        const did = await saveWithDupCheck(p, col.id);
        if (did) selectPaper(state.papers.find((x) => x.arxiv_id === p.arxiv_id) || p);
        else { await loadLibrary(); selectPaper(state.papers.find((x) => x.arxiv_id === p.arxiv_id) || p); }
      }) });
    showContextMenu(ev.clientX, ev.clientY, items);
  });
  // Remove-from-collection chips.
  c.querySelectorAll(".coll-chip-x").forEach((x) => {
    x.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const cid = x.dataset.cid;
      await invoke("unassign_paper", { paperId: p.arxiv_id, collectionId: cid });
      await loadLibrary();
      selectPaper(state.papers.find((x2) => x2.arxiv_id === p.arxiv_id) || p);
    });
  });
  // Tags
  $("#add-paper-tag")?.addEventListener("click", (e) => {
    const items = state.tags
      .filter((t) => !paperTagIds.has(t.id))
      .map((t) => ({ label: `#${t.name}`, action: async () => {
        await invoke("tag_paper", { paperId: p.arxiv_id, tagId: t.id });
        await loadLibrary();
        selectPaper(state.papers.find((x) => x.arxiv_id === p.arxiv_id) || p);
      }}));
    items.push({ sep: true });
    items.push({ label: "+ Create new tag…", action: () =>
      openModal("New Tag", "", "Create", async (name) => {
        const t = await invoke("add_tag", { name, color: null });
        await invoke("tag_paper", { paperId: p.arxiv_id, tagId: t.id });
        await loadLibrary();
        selectPaper(state.papers.find((x) => x.arxiv_id === p.arxiv_id) || p);
      }) });
    showContextMenu(e.clientX, e.clientY, items);
  });
  c.querySelectorAll(".paper-tag-chip[data-tid]").forEach((chip) => {
    chip.style.cursor = "pointer";
    chip.onclick = async () => {
      await invoke("untag_paper", { paperId: p.arxiv_id, tagId: chip.dataset.tid });
      await loadLibrary();
      selectPaper(state.papers.find((x) => x.arxiv_id === p.arxiv_id) || p);
    };
  });
  $("#dl-pdf")?.addEventListener("click", async (ev) => {
    const btn = ev.target;
    const labelText = (pct) => pct != null ? `Downloading… ${pct}%` : "Downloading…";
    btn.textContent = labelText(null);
    btn.disabled = true;
    btn.classList.add("downloading");
    btn.style.setProperty("--dl-pct", "0%");

    downloadProgressCbs[p.arxiv_id] = (prog) => {
      if (prog.total > 0) {
        const pct = Math.min(100, Math.round((prog.received / prog.total) * 100));
        btn.style.setProperty("--dl-pct", pct + "%");
        btn.textContent = labelText(pct);
      } else {
        // Unknown total: show received KB instead of a percentage.
        const kb = Math.round(prog.received / 1024);
        btn.textContent = `Downloading… ${kb} KB`;
      }
    };

    try {
      await invoke("download_pdf", { paper: p });
      await loadLibrary();
      const updated = state.papers.find((x) => x.arxiv_id === p.arxiv_id);
      selectPaper(updated || p);
      toast("PDF downloaded");
    } catch (err) {
      toast("Download failed: " + err);
      btn.textContent = "Download PDF";
      btn.disabled = false;
      btn.classList.remove("downloading");
    } finally {
      delete downloadProgressCbs[p.arxiv_id];
    }
  });
  $("#read-pdf")?.addEventListener("click", () => {
    invoke("mark_opened", { id: p.arxiv_id }).catch(() => {});
    // In-app PDF reader is frozen for now (memory cost); open in the system's
    // default PDF app instead. The in-app reader code is retained (openPdf) and
    // can be re-enabled later by swapping this call back to openPdf(hasLocal, p.title).
    openPath(hasLocal);
  });
  $("#del-pdf")?.addEventListener("click", async () => {
    await invoke("delete_pdf", { id: p.arxiv_id });
    await loadLibrary();
    const updated = state.papers.find((x) => x.arxiv_id === p.arxiv_id) || p;
    selectPaper(updated);
    toast("PDF deleted");
  });
  $("#open-preview")?.addEventListener("click", async (ev) => {
    if (hasLocal) { openPath(hasLocal); return; }
    const original = ev.target.textContent;
    ev.target.textContent = "Opening…"; ev.target.disabled = true;
    try {
      const tmpPath = await invoke("open_pdf_temp", { paper: p });
      await openPath(tmpPath);
    } catch (err) { toast("Could not open: " + err); }
    ev.target.textContent = original; ev.target.disabled = false;
  });
  $("#save-downloads")?.addEventListener("click", async (ev) => {
    const original = ev.target.textContent;
    ev.target.textContent = "Saving…"; ev.target.disabled = true;
    try {
      await invoke("save_to_downloads", { paper: p });
      await loadLibrary();
      const updated = state.papers.find((x) => x.arxiv_id === p.arxiv_id);
      if (updated && state.selectedPaper?.arxiv_id === p.arxiv_id) selectPaper(updated);
      toast("Saved to Downloads");
    } catch (err) {
      toast("Could not save: " + err);
      ev.target.textContent = original; ev.target.disabled = false;
    }
  });
  $("#cite-paper")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    showContextMenu(ev.clientX, ev.clientY, [
      { label: "Add to Bibliography (published version)", action: () => addPaperToBibliography(p.arxiv_id) },
      { label: "Add to Bibliography (arXiv version)", action: () => addPreprintToBibliography(p) },
      { sep: true },
      { label: "Copy BibTeX Entry (arXiv version)", action: () => { navigator.clipboard.writeText(bibtexEntry(p)); toast("BibTeX copied"); } },
      { label: "Copy citation (text)", action: () => { navigator.clipboard.writeText(textCitation(p)); toast("Citation copied"); } },
      { label: "Copy arXiv link", action: () => { navigator.clipboard.writeText(`https://arxiv.org/abs/${baseId(p.arxiv_id)}`); toast("Link copied"); } },
      { label: "Copy BibTeX Entry (published version)", action: async () => {
        toast("Resolving…");
        try {
          const c = await invoke("fetch_published_citation", { arxivId: p.arxiv_id });
          if (!c) { toast("No published version found yet"); return; }
          navigator.clipboard.writeText(citationToBibtex(c));
          toast("Published BibTeX copied");
        } catch (err) { toast(String(err)); }
      }},
    ]);
  });
  const noteRendered = $("#note-rendered");
  const noteEditor = $("#note-editor");
  if (noteRendered && noteEditor) {
    let t;
    const startEdit = () => {
      noteRendered.classList.add("hidden");
      noteEditor.classList.remove("hidden");
      noteEditor.focus();
    };
    const finishEdit = () => {
      noteEditor.classList.add("hidden");
      noteRendered.classList.remove("hidden");
      noteRendered.innerHTML = noteEditor.value
        ? renderMarkdown(noteEditor.value)
        : '<span style="color:var(--text-dim)">Click to add notes…</span>';
    };
    const saveNote = async () => {
      clearTimeout(t);
      const s = state.papers.find((x) => x.arxiv_id === p.arxiv_id);
      if (s && s.note === noteEditor.value) return;
      try {
        await invoke("update_note", { id: p.arxiv_id, note: noteEditor.value });
        if (s) s.note = noteEditor.value;
      } catch (err) { toast("Could not save note: " + err); }
    };
    noteRendered.addEventListener("click", (e) => {
      if (e.target.closest("a")) return; // let links open instead of entering edit mode
      startEdit();
    });
    noteEditor.addEventListener("blur", () => { saveNote(); finishEdit(); });
    noteEditor.addEventListener("keydown", (e) => {
      if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        e.stopPropagation();
        noteEditor.blur();
      }
    });
    noteEditor.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(saveNote, 500);
    });
  }
}

// ---------- Tiny Markdown renderer (safe subset) ----------
function renderMarkdown(src) {
  let html = esc(src);
  // code spans
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  // bold / italic
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  // links [text](url)
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" data-ext>$1</a>');
  // headings and lists, line by line
  const lines = html.split("\n");
  let out = [], inList = false;
  for (let line of lines) {
    if (/^###\s+/.test(line)) { if (inList){out.push("</ul>");inList=false;} out.push("<h3>" + line.replace(/^###\s+/, "") + "</h3>"); }
    else if (/^##\s+/.test(line)) { if (inList){out.push("</ul>");inList=false;} out.push("<h2>" + line.replace(/^##\s+/, "") + "</h2>"); }
    else if (/^#\s+/.test(line)) { if (inList){out.push("</ul>");inList=false;} out.push("<h1>" + line.replace(/^#\s+/, "") + "</h1>"); }
    else if (/^[-*]\s+/.test(line)) { if (!inList){out.push("<ul>");inList=true;} out.push("<li>" + line.replace(/^[-*]\s+/, "") + "</li>"); }
    else if (line.trim() === "") { if (inList){out.push("</ul>");inList=false;} out.push("<br>"); }
    else { if (inList){out.push("</ul>");inList=false;} out.push(line + "<br>"); }
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
}

// ---------- DOI export ----------
// ---------- Duplicate detection ----------
function baseId(arxivId) {
  return arxivId.replace(/v\d+$/, "");
}
// Add a paper to a collection, warning if it's already a member.
async function addToCollection(paperId, collectionId, colName) {
  const mem = state.membership[paperId];
  if (mem && mem.has(collectionId)) {
    toast(`Already in ${colName || "collection"}`);
    return false;
  }
  await invoke("assign_paper", { paperId, collectionId });
  await loadLibrary();
  return true;
}

// Add a tag to a paper, warning if already tagged.
async function addTagToPaper(paperId, tagId, tagName) {
  const tags = state.paperTags[paperId];
  if (tags && tags.has(tagId)) {
    toast(`Already tagged #${tagName || ""}`);
    return false;
  }
  await invoke("tag_paper", { paperId, tagId });
  await loadLibrary();
  return true;
}

async function saveWithDupCheck(p, collectionId = null) {
  // If this exact paper is in the trash, restoring is the right action.
  if (isTrashed(p.arxiv_id)) {
    await invoke("set_trashed", { id: p.arxiv_id, trashed: false });
    if (collectionId) await invoke("assign_paper", { paperId: p.arxiv_id, collectionId });
    await loadLibrary();
    renderList();
    toast("Restored from trash");
    return true;
  }
  const base = baseId(p.arxiv_id);
  const dup = state.papers.find((x) => baseId(x.arxiv_id) === base && x.arxiv_id !== p.arxiv_id);
  if (dup) {
    const ok = await window.__TAURI__.dialog.confirm(
      `You already have a version of this paper saved (${dup.arxiv_id}). Save this version (${p.arxiv_id}) too?`,
      { title: "Possible duplicate", kind: "warning" });
    if (!ok) return false;
  }
  await invoke("save_paper", { paper: p, collectionId });
  await loadLibrary();
  renderList();
  toast("Saved to library");
  return true;
}

// ---------- Citation export ----------
function citeKey(p) {
  const first = (p.authors[0] || "unknown").split(/\s+/).pop().replace(/[^a-zA-Z]/g, "");
  const year = (p.published || "").slice(0, 4);
  return `${first}${year}_${baseId(p.arxiv_id).replace(/[.\/]/g, "")}`;
}
function bibtexEntry(p) {
  const authors = p.authors.join(" and ");
  const year = (p.published || "").slice(0, 4);
  const fields = [
    `  title = {${p.title}}`,
    `  author = {${authors}}`,
    `  year = {${year}}`,
    `  eprint = {${baseId(p.arxiv_id)}}`,
    `  archivePrefix = {arXiv}`,
    `  primaryClass = {${p.primary_category}}`,
  ];
  if (p.doi) fields.push(`  doi = {${p.doi}}`);
  if (p.journal_ref) fields.push(`  journal = {${p.journal_ref}}`);
  fields.push(`  url = {https://arxiv.org/abs/${p.arxiv_id}}`);
  return `@article{${citeKey(p)},\n${fields.join(",\n")}\n}`;
}
function risEntry(p) {
  const lines = ["TY  - JOUR", `TI  - ${p.title}`];
  for (const a of p.authors) lines.push(`AU  - ${a}`);
  lines.push(`PY  - ${(p.published || "").slice(0, 4)}`);
  if (p.journal_ref) lines.push(`JO  - ${p.journal_ref}`);
  if (p.doi) lines.push(`DO  - ${p.doi}`);
  lines.push(`UR  - https://arxiv.org/abs/${p.arxiv_id}`);
  lines.push(`AB  - ${p.summary}`);
  lines.push("ER  - ");
  return lines.join("\n");
}
function textCitation(p) {
  const authors = p.authors.length > 3
    ? p.authors.slice(0, 3).join(", ") + " et al."
    : p.authors.join(", ");
  const year = (p.published || "").slice(0, 4);
  let s = `${authors} (${year}). ${p.title}. arXiv:${baseId(p.arxiv_id)}`;
  if (p.journal_ref) s += `. ${p.journal_ref}`;
  if (p.doi) s += `. https://doi.org/${p.doi}`;
  return s;
}
async function exportCitations(papers, label, format) {
  if (!papers.length) { toast("Nothing to export"); return; }
  const safe = label.replace(/[^a-z0-9\-_ ]/gi, "_").trim() || "library";
  const cfg = {
    bibtex: { ext: "bib", fn: bibtexEntry, sep: "\n\n" },
    ris: { ext: "ris", fn: risEntry, sep: "\n\n" },
    text: { ext: "txt", fn: textCitation, sep: "\n\n" },
  }[format];
  const contents = papers.map(cfg.fn).join(cfg.sep) + "\n";
  let path;
  try {
    path = await dialogSave({
      title: "Save citations",
      defaultPath: `${safe}.${cfg.ext}`,
      filters: [{ name: format, extensions: [cfg.ext] }],
    });
  } catch (err) { toast("Dialog error: " + err); return; }
  if (!path) return;
  try {
    await invoke("write_text_file", { path, contents });
    toast(`Exported ${papers.length} citation${papers.length === 1 ? "" : "s"}`);
  } catch (err) { toast("Could not save: " + err); }
}

// ---------- Backup / restore ----------
async function backupLibrary() {
  const btn = $("#backup-library");
  const rect = btn.getBoundingClientRect();
  // Position the menu just above the button.
  const items = [
    { label: "Export backup (.json)", action: doExportBackup },
    { label: "Import backup (.json)", action: doImportBackup },
    { sep: true },
    { label: "Export settings (.json)", action: doExportSettings },
    { label: "Import settings (.json)", action: doImportSettings },
  ];
  showContextMenu(rect.left, rect.top - (items.length * 36) - 8, items);
}
async function doExportSettings() {
  try {
    const json = await invoke("export_settings");
    const path = await dialogSave({
      title: "Save settings",
      defaultPath: `arxivlibrary-settings-${new Date().toISOString().slice(0,10)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) return;
    await invoke("write_text_file", { path, contents: json });
    toast("Settings exported");
  } catch (err) { toast("Settings export failed: " + err); }
}
async function doImportSettings() {
  try {
    const path = await window.__TAURI__.dialog.open({
      title: "Choose a settings file",
      filters: [{ name: "JSON", extensions: ["json"] }],
      multiple: false, directory: false,
    });
    if (!path) return;
    const json = await invoke("read_text_file", { path });
    await invoke("import_settings", { json });
    appSettings = await invoke("get_settings");
    await initFeedCategories();
    toast("Settings imported");
  } catch (err) { toast("Settings import failed: " + err); }
}
async function doExportBackup() {
  try {
    const json = await invoke("export_backup");
    const path = await dialogSave({
      title: "Save library backup",
      defaultPath: `arxivlibrary-backup-${new Date().toISOString().slice(0,10)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) return;
    await invoke("write_text_file", { path, contents: json });
    toast("Backup saved");
  } catch (err) { toast("Backup failed: " + err); }
}
async function doImportBackup() {
  try {
    const path = await window.__TAURI__.dialog.open({
      title: "Choose a backup file",
      filters: [{ name: "JSON", extensions: ["json"] }],
      multiple: false, directory: false,
    });
    if (!path) return;
    const json = await invoke("read_text_file", { path });
    const ok = await window.__TAURI__.dialog.confirm(
      "Import this backup? It will merge into your current library (existing papers with the same ID are updated).",
      { title: "Import backup", kind: "warning" });
    if (!ok) return;
    await invoke("import_backup", { json });
    await loadLibrary();
    toast("Backup imported");
  } catch (err) { toast("Import failed: " + err); }
}

function buildDoiText(papers, label) {
  const lines = [`# ${label} — ${papers.length} paper(s)`, ""];
  for (const p of papers) {
    lines.push(p.title);
    lines.push(`  arXiv: https://arxiv.org/abs/${p.arxiv_id}`);
    if (p.doi) lines.push(`  DOI:   https://doi.org/${p.doi}`);
    lines.push("");
  }
  return lines.join("\n");
}

async function exportDois(papers, label) {
  if (!papers.length) { toast("Nothing to export"); return; }
  const safe = label.replace(/[^a-z0-9\-_ ]/gi, "_").trim() || "library";
  let path;
  try {
    path = await dialogSave({
      title: "Save DOI list",
      defaultPath: `${safe}-dois.txt`,
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
  } catch (err) { toast("Dialog error: " + err); return; }
  if (!path) return; // user cancelled — this is the "ask before saving"
  try {
    await invoke("write_text_file", { path, contents: buildDoiText(papers, label) });
    toast(`Saved ${papers.length} entries`);
  } catch (err) {
    toast("Could not save: " + err);
  }
}

// ---------- Email share ----------
function shareByEmail(papers, label) {
  if (!papers.length) { toast("Nothing to share"); return; }
  const subject = `arXiv papers: ${label}`;
  const bodyLines = [`Papers in "${label}":`, ""];
  for (const p of papers) {
    bodyLines.push(`• ${p.title}`);
    bodyLines.push(`  https://arxiv.org/abs/${p.arxiv_id}`);
    if (p.doi) bodyLines.push(`  https://doi.org/${p.doi}`);
    bodyLines.push("");
  }
  const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(bodyLines.join("\n"))}`;
  openUrl(mailto);
}

// ---------- PDF reader with search ----------
// ---------- PDF viewer (multi-document) ----------
// Open documents keyed by path. Each record holds its own pdf handle, scale,
// rendered DOM (detached when inactive), search state, and lazy-render observer.
const openDocs = new Map();   // path -> docRecord
let activeDocPath = null;
const OVERSAMPLE = 1;        // rely on device DPR (already 2x on Retina); oversampling beyond that wastes memory for no visible gain
let pdfZoomTimer = null;

function activeDoc() { return activeDocPath ? openDocs.get(activeDocPath) : null; }

// Release a document's heavy rendering resources without losing the fact that
// it's "open". Setting canvas width/height to 0 frees the backing store (this
// is the real memory; a rendered page is ~12MB). The doc can be re-rendered
// later via renderDoc(). Keeps the lightweight record + container shell.
function freeDocCanvases(rec) {
  if (rec.observer) { rec.observer.disconnect(); rec.observer = null; }
  if (rec.container) {
    rec.container.querySelectorAll("canvas").forEach((cv) => {
      cv.width = 0; cv.height = 0;
    });
    rec.container.innerHTML = "";
  }
  rec.loaded = false;
  rec.matches = [];
  rec.current = -1;
}

// Fully tear down a document: free canvases AND destroy the pdf.js instance
// (which releases its worker-side memory and decoded image cache).
async function destroyDoc(rec) {
  freeDocCanvases(rec);
  if (rec.pdf) {
    try { await rec.pdf.cleanup(); } catch {}
    try { await rec.pdf.destroy(); } catch {}
    rec.pdf = null;
  }
  rec.lib = null;
  rec.container = null;
}

async function openPdf(path, title) {
  const overlay = $("#pdf-overlay");
  overlay.classList.remove("hidden");

  // Already open → just switch to it (may re-render if its canvases were freed).
  if (openDocs.has(path)) { await switchDoc(path); return; }

  // Create a fresh record with its own detached viewer container.
  const container = el("div", "pdf-doc-viewer");
  container.innerHTML = '<div class="loading">Loading PDF…</div>';
  const rec = {
    path, title, pdf: null, lib: null,
    scale: 1.4, baseScale: 1.4, displayScale: 1,
    matches: [], current: -1, observer: null,
    container, loaded: false,
  };
  openDocs.set(path, rec);
  renderDocList();
  await switchDoc(path); // shows the loading container immediately

  try {
    const lib = await ensurePdfjs();
    const bytes = await invoke("read_pdf_bytes", { path });
    const data = new Uint8Array(bytes);
    const pdf = await lib.getDocument({
      data,
      // Bound memory: cap the largest decoded image pdf.js will hold, and don't
      // keep extra eval/font caches around longer than needed.
      maxImageSize: 4_000_000,
      disableFontFace: false,
    }).promise;
    rec.pdf = pdf;
    rec.lib = lib;
    await renderDoc(rec);
    rec.loaded = true;
    if (activeDocPath === path) updateZoomLabel();
  } catch (err) {
    rec.container.innerHTML = `<div class="loading">Could not load PDF: ${esc(String(err))}</div>`;
  }
}

// Rasterize one page's canvas at OVERSAMPLE × DPR for sharpness. Idempotent.
async function rasterizePage(rec, wrap) {
  if (wrap.dataset.rendered === "1" || wrap.dataset.rendering === "1") return;
  wrap.dataset.rendering = "1";
  const n = parseInt(wrap.dataset.page, 10);
  try {
    const page = await rec.pdf.getPage(n);
    const viewport = page.getViewport({ scale: rec.scale });
    const canvas = wrap.querySelector("canvas");
    if (!canvas) { wrap.dataset.rendering = "0"; return; }

    // Oversample for sharpness, but clamp so we never exceed the WebKit canvas
    // limits (~4096px/side and a total-area budget) — past those a canvas
    // silently renders black, which is the bug we're fixing.
    const baseDpr = window.devicePixelRatio || 1;
    const cssW = viewport.width, cssH = viewport.height;
    let dpr = baseDpr * OVERSAMPLE;
    const MAX_SIDE = 3000;      // hard per-dimension ceiling
    const MAX_AREA = 6_000_000; // ~6M device px (~24MB) max per page canvas
    // Clamp by longest side.
    dpr = Math.min(dpr, MAX_SIDE / Math.max(cssW, cssH));
    // Clamp by area.
    const areaDpr = Math.sqrt(MAX_AREA / (cssW * cssH));
    dpr = Math.min(dpr, areaDpr);
    // Never go below crisp 1×-device.
    dpr = Math.max(1, dpr);

    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    const ctx = canvas.getContext("2d");
    // Paint white first: if rendering fails or the canvas is huge, we get a
    // blank white page instead of an opaque black rectangle.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.scale(dpr, dpr);
    await page.render({ canvasContext: ctx, viewport, intent: "display" }).promise;
    wrap.dataset.rendered = "1";
  } catch (e) {
    // Leave unrendered; scroll-in or re-render will retry.
  }
  wrap.dataset.rendering = "0";
}

// Build the full page DOM for a document at its current scale.
async function renderDoc(rec) {
  // Prevent overlapping rebuilds (e.g. rapid zoom commits) from corrupting DOM.
  if (rec.rendering) { rec.renderQueued = true; return; }
  rec.rendering = true;
  if (rec.observer) { rec.observer.disconnect(); rec.observer = null; }
  const viewer = rec.container;
  viewer.innerHTML = "";
  rec.matches = [];
  rec.current = -1;

  const wraps = [];
  rec.displayScale = 1;
  for (let n = 1; n <= rec.pdf.numPages; n++) {
    const page = await rec.pdf.getPage(n);
    const viewport = page.getViewport({ scale: rec.scale });
    const wrap = el("div", "pdf-page-wrap");
    wrap.style.width = viewport.width + "px";
    wrap.style.height = viewport.height + "px";
    wrap.dataset.page = n;
    wrap.dataset.rendered = "0";
    wrap.dataset.cssw = viewport.width;
    wrap.dataset.cssh = viewport.height;
    const canvas = el("canvas");
    canvas.style.width = viewport.width + "px";
    canvas.style.height = viewport.height + "px";
    wrap.appendChild(canvas);
    const textLayer = el("div", "pdf-text-layer");
    textLayer.dataset.page = n;
    wrap.appendChild(textLayer);
    viewer.appendChild(wrap);
    const textContent = await page.getTextContent();
    renderTextLayer(textLayer, textContent, viewport, rec.lib);
    wraps.push(wrap);
  }

  for (let i = 0; i < Math.min(3, wraps.length); i++) await rasterizePage(rec, wraps[i]);

  if (wraps.length > 3) {
    // Render pages as they approach the viewport; evict (free the canvas) when
    // they scroll well away. This caps live canvas memory to the pages near the
    // viewport instead of accumulating every page ever scrolled past.
    rec.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const wrap = entry.target;
        if (entry.isIntersecting) {
          rasterizePage(rec, wrap);
        } else if (wrap.dataset.rendered === "1") {
          // Free this page's canvas AND its pdf.js per-page cache (decoded
          // images, operator lists, fonts) — the latter is a big hidden cost.
          const cv = wrap.querySelector("canvas");
          if (cv) { cv.width = 0; cv.height = 0; }
          wrap.dataset.rendered = "0";
          const pn = parseInt(wrap.dataset.page, 10);
          rec.pdf.getPage(pn).then((pg) => { try { pg.cleanup(); } catch {} }).catch(() => {});
        }
      }
    }, { root: viewer, rootMargin: "400px 0px" });
    for (let i = 0; i < wraps.length; i++) rec.observer.observe(wraps[i]);
  }

  rec.rendering = false;
  if (rec.renderQueued) { rec.renderQueued = false; await renderDoc(rec); }
}

// Switch the visible document. Detaches the current one (preserving its DOM and
// scroll) and attaches the target — no re-rasterization needed.
async function switchDoc(path) {
  const rec = openDocs.get(path);
  if (!rec) return;
  const viewer = $("#pdf-viewer");
  // Save scroll position of the outgoing doc and free its canvases to cap memory.
  const prev = activeDoc();
  if (prev && prev !== rec) {
    prev.scrollTop = viewer.scrollTop;
    freeDocCanvases(prev);
  }
  viewer.innerHTML = "";
  activeDocPath = path;
  $("#pdf-title").textContent = rec.title;
  $("#pdf-search-input").value = "";
  $("#pdf-search-count").textContent = "";
  // If this doc's canvases were freed (or never rendered), rebuild them.
  if (rec.pdf && !rec.loaded) {
    viewer.appendChild(rec.container);
    await renderDoc(rec);
    rec.loaded = true;
  } else {
    viewer.appendChild(rec.container);
  }
  viewer.scrollTop = rec.scrollTop || 0;
  updateZoomLabel();
  renderDocList();
}

async function closeDoc(path) {
  const rec = openDocs.get(path);
  if (!rec) return;
  openDocs.delete(path);
  if (activeDocPath === path) {
    activeDocPath = null;
    $("#pdf-viewer").innerHTML = "";
    const next = openDocs.keys().next();
    if (!next.done) {
      await switchDoc(next.value);
    } else {
      $("#pdf-overlay").classList.add("hidden");
    }
  }
  renderDocList();
  await destroyDoc(rec);
}

function renderDocList() {
  const listEl = $("#pdf-doc-list");
  listEl.innerHTML = "";
  for (const [path, rec] of openDocs) {
    const item = el("div", "pdf-doc-item" + (path === activeDocPath ? " active" : ""));
    item.innerHTML =
      `<span class="pdf-doc-name" title="${esc(rec.title)}">${esc(rec.title)}</span>` +
      `<button class="pdf-doc-close" title="Close">&times;</button>`;
    item.querySelector(".pdf-doc-name").onclick = () => switchDoc(path);
    item.querySelector(".pdf-doc-close").onclick = (e) => { e.stopPropagation(); closeDoc(path); };
    listEl.appendChild(item);
  }
}

function updateZoomLabel() {
  const rec = activeDoc();
  if (!rec) return;
  $("#pdf-zoom-level").textContent = Math.round((rec.scale / rec.baseScale) * 100 * rec.displayScale) + "%";
}

// Smooth zoom: apply an instant CSS transform for responsiveness, then debounce
// a sharp re-rasterization at the new scale.
function zoomActive(factor) {
  const rec = activeDoc();
  if (!rec || !rec.loaded) return;
  const ratio = rec.scale / rec.baseScale;
  rec.displayScale = Math.max(0.5 / ratio, Math.min(3 / ratio, rec.displayScale * factor));
  // Instant feedback: rescale the *displayed* size of each page (CSS width/height),
  // which reflows correctly so stacked pages never overlap. The existing bitmap is
  // scaled by the browser until the sharp re-render lands.
  rec.container.querySelectorAll(".pdf-page-wrap").forEach((w) => {
    const cw = parseFloat(w.dataset.cssw || "0");
    const ch = parseFloat(w.dataset.cssh || "0");
    if (cw && ch) {
      const dw = cw * rec.displayScale, dh = ch * rec.displayScale;
      w.style.width = dw + "px";
      w.style.height = dh + "px";
      const cv = w.querySelector("canvas");
      if (cv) { cv.style.width = dw + "px"; cv.style.height = dh + "px"; }
      const tl = w.querySelector(".pdf-text-layer");
      if (tl) { tl.style.transform = `scale(${rec.displayScale})`; tl.style.transformOrigin = "0 0"; }
    }
  });
  updateZoomLabel();
  clearTimeout(pdfZoomTimer);
  pdfZoomTimer = setTimeout(() => commitZoom(rec), 240);
}

async function commitZoom(rec) {
  // Fold the transient displayScale into the real render scale, then re-raster.
  // Cap at 3x base so the resulting canvas never approaches WebKit's size limit.
  const target = rec.scale * rec.displayScale;
  rec.scale = Math.max(rec.baseScale * 0.5, Math.min(rec.baseScale * 3, target));
  rec.displayScale = 1;
  await renderDoc(rec);
  updateZoomLabel();
}

async function fitWidth() {
  const rec = activeDoc();
  if (!rec || !rec.loaded) return;
  const page = await rec.pdf.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const avail = $("#pdf-viewer").clientWidth - 56; // padding allowance
  rec.scale = Math.max(0.5, Math.min(5, avail / base.width));
  rec.displayScale = 1;
  await renderDoc(rec);
  updateZoomLabel();
}

function renderTextLayer(layer, textContent, viewport, lib) {
  for (const item of textContent.items) {
    if (!item.str) continue;
    const tx = lib.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]);
    const span = document.createElement("span");
    span.textContent = item.str;
    span.style.position = "absolute";
    span.style.left = tx[4] + "px";
    span.style.top = (tx[5] - fontHeight) + "px";
    span.style.fontSize = fontHeight + "px";
    span.style.whiteSpace = "pre";
    span.style.transformOrigin = "0% 0%";
    layer.appendChild(span);
  }
}

function pdfSearch(query) {
  const rec = activeDoc();
  if (!rec) return;
  const viewer = rec.container;
  viewer.querySelectorAll(".pdf-text-layer span").forEach((s) => {
    if (s.dataset.orig !== undefined) { s.innerHTML = esc(s.dataset.orig); }
  });
  rec.matches = [];
  rec.current = -1;
  if (!query) { $("#pdf-search-count").textContent = ""; return; }
  const q = query.toLowerCase();
  viewer.querySelectorAll(".pdf-text-layer span").forEach((s) => {
    const orig = s.dataset.orig !== undefined ? s.dataset.orig : s.textContent;
    s.dataset.orig = orig;
    const lower = orig.toLowerCase();
    if (lower.includes(q)) {
      let html = "", idx = 0, pos;
      while ((pos = lower.indexOf(q, idx)) !== -1) {
        html += esc(orig.slice(idx, pos)) + "<mark>" + esc(orig.slice(pos, pos + q.length)) + "</mark>";
        idx = pos + q.length;
      }
      html += esc(orig.slice(idx));
      s.innerHTML = html;
      s.querySelectorAll("mark").forEach((m) => rec.matches.push(m));
    }
  });
  $("#pdf-search-count").textContent = rec.matches.length ? `0/${rec.matches.length}` : "0/0";
  if (rec.matches.length) pdfJump(0);
}

function pdfJump(i) {
  const rec = activeDoc();
  if (!rec || !rec.matches.length) return;
  rec.current = (i + rec.matches.length) % rec.matches.length;
  const m = rec.matches[rec.current];
  m.scrollIntoView({ block: "center", behavior: "smooth" });
  $("#pdf-search-count").textContent = `${rec.current + 1}/${rec.matches.length}`;
}

$("#pdf-search-input").addEventListener("input", (e) => pdfSearch(e.target.value));
$("#pdf-search-next").onclick = () => { const r = activeDoc(); pdfJump(r ? r.current + 1 : 0); };
$("#pdf-search-prev").onclick = () => { const r = activeDoc(); pdfJump(r ? r.current - 1 : 0); };
$("#pdf-zoom-in").onclick = () => zoomActive(1.15);
$("#pdf-zoom-out").onclick = () => zoomActive(1 / 1.15);
$("#pdf-fit-width").onclick = () => fitWidth();
$("#pdf-sidebar-toggle").onclick = () => $("#pdf-doc-list").classList.toggle("hidden");
$("#pdf-viewer").addEventListener("wheel", (e) => {
  if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomActive(e.deltaY < 0 ? 1.08 : 1 / 1.08); }
}, { passive: false });
$("#pdf-close").onclick = async () => {
  // Fully release all PDF memory: destroy every pdf.js instance and free all
  // canvases. Reopen any paper from the library to view it again.
  $("#pdf-overlay").classList.add("hidden");
  $("#pdf-viewer").innerHTML = "";
  const docs = [...openDocs.values()];
  openDocs.clear();
  activeDocPath = null;
  renderDocList();
  for (const rec of docs) await destroyDoc(rec);
};


// ---------- Advanced search ----------
// Build a plain all-fields query. Space-separated words are AND-combined so
// each must appear *somewhere* (title, abstract, or authors) — this lets
// "title words + author surname" match, which a single quoted phrase cannot.
// Explicit "double quotes" in the input are kept as exact phrases.
// Split a search term into quoted phrases and bare words.
function splitTerms(term) {
  const phrases = [];
  const rest = term.replace(/"([^"]+)"/g, (_, p) => { phrases.push(p.trim()); return " "; });
  const words = rest.split(/\s+/).filter(Boolean);
  return { phrases, words };
}

// Build a fielded query where EACH term (word or quoted phrase) is matched in
// the chosen field and ANDed together. This makes "Bernevig Sharma" in the
// Author field become au:Bernevig AND au:Sharma (two authors), not a single
// phrase that never matches.
function fieldedQuery(term, prefix) {
  const { phrases, words } = splitTerms(term);
  const parts = [
    ...phrases.map((p) => `${prefix}:"${p}"`),
    ...words.map((w) => `${prefix}:${w}`),
  ];
  return parts.join(" AND ");
}

function plainQuery(term) {
  // All-fields search: each term must appear somewhere, ANDed together.
  return fieldedQuery(term, "all");
}

// Build a category clause that mirrors how arXiv's site filters by archive.
// For an archive like "cond-mat", the site matches the bare archive AND all its
// subcategories (cond-mat.mes-hall, etc.). A single cat:cond-mat* wildcard can
// behave inconsistently on the API, so we OR the bare archive with the wildcard.
function categoryClause(subject) {
  // If the subject already has a subcategory (a dot), match it exactly.
  if (subject.includes(".")) return `cat:${subject}`;
  // Archive-level: match the bare archive OR any subcategory under it.
  return `(cat:${subject} OR cat:${subject}.*)`;
}

function buildQuery() {
  const term = $("#search-input").value.trim();
  const advOpen = !$("#adv-panel").classList.contains("hidden");

  // When Advanced is closed, do a plain all-fields search.
  if (!advOpen) {
    if (!term) return "";
    return plainQuery(term);
  }

  const field = $("#adv-field").value;
  const subject = $("#adv-subject").value;
  const dateMode = $("#adv-date").value;

  const parts = [];
  if (term) {
    const prefix = { all: "all", ti: "ti", au: "au", abs: "abs", co: "co",
                     jr: "jr", cat: "cat", rn: "rn", id: "id" }[field] || "all";
    // Each word/phrase ANDed within the chosen field (handles multiple authors,
    // multiple title words, etc.) — mirrors how arXiv's advanced search behaves.
    const fq = fieldedQuery(term, prefix);
    if (fq) parts.push(`(${fq})`);
  }
  if (subject) parts.push(categoryClause(subject));

  if (dateMode === "year") {
    const y = $("#adv-year").value.trim();
    if (/^\d{4}$/.test(y)) parts.push(`submittedDate:[${y}01010000 TO ${y}12312359]`);
  } else if (dateMode === "12m") {
    const now = new Date();
    const past = new Date(now.getTime() - 365 * 864e5);
    const f = (d) => `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
    parts.push(`submittedDate:[${f(past)}0000 TO ${f(now)}2359]`);
  } else if (dateMode === "range") {
    const from = $("#adv-from").value.replace(/-/g, "").trim();
    const to = $("#adv-to").value.replace(/-/g, "").trim();
    if (from && to) {
      const fp = (from + "00000000").slice(0, 8);
      const tp = (to + "12312359").slice(0, 8);
      parts.push(`submittedDate:[${fp}0000 TO ${tp}2359]`);
    }
  }
  return parts.join(" AND ");
}

// Paging state for the arXiv search view and, separately, the open saved search.
let searchPaging = { query: "", sort: "relevance", start: 0, pageSize: 50, total: 0, done: false, loading: false };
let savedPaging = { query: "", sort: "relevance", start: 0, pageSize: 50, total: 0, done: true, loading: false, savedId: null };

function effectiveSort() {
  // If advanced panel is open, its sort wins; else use quick-sort.
  const advOpen = !$("#adv-panel").classList.contains("hidden");
  return advOpen ? $("#adv-sort").value : $("#quick-sort").value;
}

// ---------- Search history ----------
const SEARCH_HISTORY_KEY = "searchHistory";
const SEARCH_HISTORY_MAX = 50;
function searchHistoryEnabled() {
  try { return localStorage.getItem("saveSearchHistory") !== "0"; } catch { return true; }
}
function searchSuggestionsEnabled() {
  try { return localStorage.getItem("searchSuggestions") !== "0"; } catch { return true; }
}
function getSearchHistory() {
  try { return JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || "[]"); } catch { return []; }
}
function recordSearchHistory(term) {
  if (!term || !searchHistoryEnabled()) return;
  let hist = getSearchHistory().filter((h) => h.toLowerCase() !== term.toLowerCase());
  hist.unshift(term);
  if (hist.length > SEARCH_HISTORY_MAX) hist = hist.slice(0, SEARCH_HISTORY_MAX);
  try { localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(hist)); } catch {}
}
function clearSearchHistory() {
  try { localStorage.removeItem(SEARCH_HISTORY_KEY); } catch {}
}
function hideSearchSuggestions() {
  document.querySelector("#search-suggest")?.remove();
}
function showSearchSuggestions() {
  hideSearchSuggestions();
  if (!searchSuggestionsEnabled()) return;
  const inp = $("#search-input");
  const val = inp.value.trim().toLowerCase();
  let hist = getSearchHistory();
  if (val) hist = hist.filter((h) => h.toLowerCase().includes(val) && h.toLowerCase() !== val);
  hist = hist.slice(0, 8);
  if (!hist.length) return;
  const box = el("div", "search-suggest");
  box.id = "search-suggest";
  for (const h of hist) {
    const row = el("div", "search-suggest-row");
    row.innerHTML = `<span class="ss-icon">↻</span><span class="ss-text">${esc(h)}</span><span class="ss-del" title="Remove">✕</span>`;
    row.querySelector(".ss-text").onclick = () => { inp.value = h; hideSearchSuggestions(); runSearch(); };
    row.querySelector(".ss-icon").onclick = () => { inp.value = h; hideSearchSuggestions(); runSearch(); };
    row.querySelector(".ss-del").onclick = (e) => {
      e.stopPropagation();
      const next = getSearchHistory().filter((x) => x !== h);
      try { localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next)); } catch {}
      showSearchSuggestions();
    };
    box.appendChild(row);
  }
  const wrap = inp.closest(".search-input-wrap") || inp.parentElement;
  wrap.style.position = "relative";
  wrap.appendChild(box);
}

// Pasting an arXiv id or link ("2401.01234", "arXiv:2401.01234v2",
// "https://arxiv.org/abs/…", several separated by spaces/commas) fetches those
// exact papers instead of running a keyword search. Returns true if handled.
async function tryIdLookup(term) {
  if (!/\d{4}\.\d{4,5}|\/\d{7}/.test(term)) return false; // cheap pre-check, no IPC for normal queries
  const list = $("#paper-list");
  list.innerHTML = '<div class="loading">Looking up arXiv id…</div>';
  const papers = await invoke("lookup_arxiv_ids", { input: term });
  if (!papers) return false; // not purely ids → normal search
  searchPaging = { query: "", sort: "relevance", start: papers.length, pageSize: papers.length, total: papers.length, done: true, loading: false };
  state.searchResults = papers;
  renderList();
  if (!papers.length) {
    list.innerHTML = `<div class="empty-list"><div class="empty-icon">&#9888;</div><p>No arXiv paper found for “${esc(term)}”.</p></div>`;
  } else if (papers.length === 1) {
    state.lastClickedId = papers[0].arxiv_id;
    selectPaper(papers[0]);
  }
  return true;
}

async function runSearch() {
  const term = $("#search-input").value.trim();
  const query = buildQuery();
  if (!query) { toast("Enter a search term"); return; }
  recordSearchHistory(term);
  hideSearchSuggestions();
  state.selectedIds.clear();
  $("#list-title").textContent = "Search Results";
  const advOpen = !$("#adv-panel").classList.contains("hidden");
  try {
    if (!advOpen && await tryIdLookup(term)) return;
  } catch (err) {
    $("#paper-list").innerHTML = `<div class="empty-list"><div class="empty-icon">&#9888;</div><p>${esc(String(err))}</p></div>`;
    return;
  }
  const count = advOpen ? (parseInt($("#adv-count").value) || 50) : 50;
  searchPaging = { query, sort: effectiveSort(), start: 0, pageSize: count, total: 0, done: false, loading: true };
  state.searchResults = [];
  const list = $("#paper-list");
  list.innerHTML = '<div class="loading">Querying arXiv…</div>';
  list.scrollTop = 0;
  const mine = searchPaging;
  try {
    const { papers: res, total } = await invoke("search_arxiv", { query, sortBy: searchPaging.sort, maxResults: count, start: 0 });
    if (searchPaging !== mine) return; // a newer search replaced this one
    state.searchResults = res;
    searchPaging.start = res.length;
    searchPaging.total = total;
    searchPaging.done = res.length < count || res.length >= total;
    searchPaging.loading = false;
    if (state.view.type === "search") renderList();
  } catch (err) {
    searchPaging.loading = false;
    list.innerHTML = `<div class="empty-list"><div class="empty-icon">&#9888;</div><p>${esc(String(err))}</p></div>`;
  }
}

// Next page for the arXiv search or the open saved search.
async function loadMoreSearch() {
  const isSaved = state.view.type === "saved";
  if (state.view.type !== "search" && !isSaved) return;
  const paging = isSaved ? savedPaging : searchPaging;
  if (isSaved && paging.savedId !== state.view.id) return;
  if (paging.loading || paging.done || !paging.query) return;
  paging.loading = true;
  const moreEl = el("div", "loading", "Loading more…");
  $("#paper-list").appendChild(moreEl);
  try {
    const { papers: res, total } = await invoke("search_arxiv", {
      query: paging.query, sortBy: paging.sort,
      maxResults: paging.pageSize, start: paging.start,
    });
    if ((isSaved ? savedPaging : searchPaging) !== paging) return; // a new search started meanwhile
    const target = isSaved ? state.savedResults : state.searchResults;
    // Dedupe by arxiv_id in case of overlap.
    const seen = new Set(target.map((p) => p.arxiv_id));
    target.push(...res.filter((p) => !seen.has(p.arxiv_id)));
    paging.start += res.length;
    paging.total = total || paging.total;
    paging.done = res.length < paging.pageSize || paging.start >= paging.total;
    if (isSaved) state.savedSearchCache[paging.savedId] = { results: target, paging };
    if (state.view.type === (isSaved ? "saved" : "search")) renderList();
  } catch (err) {
    moreEl.remove();
    toast("Could not load more: " + err);
  } finally {
    paging.loading = false;
  }
}

// Infinite scroll for fetched result lists (wired once at startup).
$("#paper-list").addEventListener("scroll", () => {
  const list = $("#paper-list");
  if (list.scrollTop + list.clientHeight >= list.scrollHeight - 120) loadMoreSearch();
}, { passive: true });

// ---------- Modal ----------
function openModal(title, value, okLabel, onOk) {
  $("#modal-title").textContent = title;
  $("#modal-input").value = value || "";
  $("#modal-ok").textContent = okLabel || "OK";
  $("#modal").classList.remove("hidden");
  $("#modal-input").focus();
  const ok = $("#modal-ok"), cancel = $("#modal-cancel");
  const close = () => $("#modal").classList.add("hidden");
  ok.onclick = async () => {
    const v = $("#modal-input").value.trim();
    if (v) await onOk(v);
    close();
  };
  cancel.onclick = close;
  $("#modal-input").onkeydown = (e) => { if (e.key === "Enter") ok.click(); if (e.key === "Escape") close(); };
}

// ---------- Color picker ----------
const PRESET_COLORS = [
  "#b3261e","#e0524a","#e8833a","#e3b341","#3fb950","#2da44e",
  "#1f9ed1","#2f81f7","#6f6fef","#8957e5","#bf4bce","#db61a2",
  "#6e7681","#57606a","#8b949e","#d2a8ff",
];

// --- color math helpers ---
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbToHex(r, g, b) {
  const h = (x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0");
  return "#" + h(r) + h(g) + h(b);
}
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}
function hsvToRgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

function openColorPicker(item, kindOrCb = "collection") {
  const onApply = typeof kindOrCb === "function" ? kindOrCb : null;
  const kind = typeof kindOrCb === "string" ? kindOrCb : "collection";
  const modal = $("#color-modal");
  $("#color-modal-title").textContent = `Color: ${item.name}`;
  const swatches = $("#color-swatches");
  swatches.innerHTML = "";

  const svCanvas = $("#sv-canvas"), hueCanvas = $("#hue-canvas");
  const svCtx = svCanvas.getContext("2d"), hueCtx = hueCanvas.getContext("2d");

  // Current HSV state
  let hsv = { h: 0, s: 0.8, v: 0.7 };
  let chosen = item.color || null;
  if (chosen) {
    const rgb = hexToRgb(chosen);
    if (rgb) hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
  }

  const drawHue = () => {
    for (let y = 0; y < hueCanvas.height; y++) {
      const h = (y / hueCanvas.height) * 360;
      const { r, g, b } = hsvToRgb(h, 1, 1);
      hueCtx.fillStyle = `rgb(${r|0},${g|0},${b|0})`;
      hueCtx.fillRect(0, y, hueCanvas.width, 1);
    }
    // marker
    const my = (hsv.h / 360) * hueCanvas.height;
    hueCtx.strokeStyle = "#fff"; hueCtx.lineWidth = 2;
    hueCtx.strokeRect(0, my - 2, hueCanvas.width, 4);
  };
  const drawSV = () => {
    const { r, g, b } = hsvToRgb(hsv.h, 1, 1);
    svCtx.fillStyle = `rgb(${r|0},${g|0},${b|0})`;
    svCtx.fillRect(0, 0, svCanvas.width, svCanvas.height);
    const wg = svCtx.createLinearGradient(0, 0, svCanvas.width, 0);
    wg.addColorStop(0, "#fff"); wg.addColorStop(1, "rgba(255,255,255,0)");
    svCtx.fillStyle = wg; svCtx.fillRect(0, 0, svCanvas.width, svCanvas.height);
    const bg = svCtx.createLinearGradient(0, 0, 0, svCanvas.height);
    bg.addColorStop(0, "rgba(0,0,0,0)"); bg.addColorStop(1, "#000");
    svCtx.fillStyle = bg; svCtx.fillRect(0, 0, svCanvas.width, svCanvas.height);
    // marker
    const mx = hsv.s * svCanvas.width, my = (1 - hsv.v) * svCanvas.height;
    svCtx.strokeStyle = "#fff"; svCtx.lineWidth = 2;
    svCtx.beginPath(); svCtx.arc(mx, my, 6, 0, Math.PI * 2); svCtx.stroke();
    svCtx.strokeStyle = "rgba(0,0,0,0.5)"; svCtx.lineWidth = 1;
    svCtx.beginPath(); svCtx.arc(mx, my, 7, 0, Math.PI * 2); svCtx.stroke();
  };
  const syncInputs = () => {
    const { r, g, b } = hsvToRgb(hsv.h, hsv.s, hsv.v);
    chosen = rgbToHex(r, g, b);
    $("#hex-input").value = chosen;
    $("#r-input").value = Math.round(r);
    $("#g-input").value = Math.round(g);
    $("#b-input").value = Math.round(b);
    $("#color-preview").style.background = chosen;
  };
  const redraw = () => { drawHue(); drawSV(); syncInputs(); };
  redraw();

  // SV canvas interaction
  let svDrag = false;
  const setSV = (e) => {
    const rect = svCanvas.getBoundingClientRect();
    let x = (e.clientX - rect.left) / rect.width;
    let y = (e.clientY - rect.top) / rect.height;
    hsv.s = Math.max(0, Math.min(1, x));
    hsv.v = Math.max(0, Math.min(1, 1 - y));
    redraw();
  };
  svCanvas.onmousedown = (e) => { svDrag = true; setSV(e); };
  // Hue canvas interaction
  let hueDrag = false;
  const setHue = (e) => {
    const rect = hueCanvas.getBoundingClientRect();
    let y = (e.clientY - rect.top) / rect.height;
    hsv.h = Math.max(0, Math.min(359.9, y * 360));
    redraw();
  };
  hueCanvas.onmousedown = (e) => { hueDrag = true; setHue(e); };
  const moveHandler = (e) => { if (svDrag) setSV(e); else if (hueDrag) setHue(e); };
  const upHandler = () => { svDrag = false; hueDrag = false; };
  window.addEventListener("mousemove", moveHandler);
  window.addEventListener("mouseup", upHandler);

  // Hex/RGB inputs
  $("#hex-input").oninput = (e) => {
    const rgb = hexToRgb(e.target.value.trim());
    if (rgb) { hsv = rgbToHsv(rgb.r, rgb.g, rgb.b); redraw(); }
  };
  const rgbInput = () => {
    const r = +$("#r-input").value, g = +$("#g-input").value, b = +$("#b-input").value;
    if ([r, g, b].every((x) => x >= 0 && x <= 255)) { hsv = rgbToHsv(r, g, b); redraw(); }
  };
  $("#r-input").oninput = rgbInput;
  $("#g-input").oninput = rgbInput;
  $("#b-input").oninput = rgbInput;

  // Preset quick-picks
  for (const col of PRESET_COLORS) {
    const sw = el("div", "swatch");
    sw.style.background = col;
    sw.onclick = () => {
      const rgb = hexToRgb(col);
      if (rgb) { hsv = rgbToHsv(rgb.r, rgb.g, rgb.b); redraw(); }
    };
    swatches.appendChild(sw);
  }

  const cleanup = () => {
    window.removeEventListener("mousemove", moveHandler);
    window.removeEventListener("mouseup", upHandler);
    modal.classList.add("hidden");
  };

  modal.classList.remove("hidden");
  $("#color-clear").onclick = () => { chosen = null; cleanup(); applyColor(); };
  $("#color-cancel").onclick = cleanup;
  $("#color-ok").onclick = () => { cleanup(); applyColor(); };

  async function applyColor() {
    if (onApply) { await onApply(chosen); return; }
    if (kind === "tag") await invoke("set_tag_color", { id: item.id, color: chosen });
    else await invoke("set_collection_color", { id: item.id, color: chosen });
    await loadLibrary();
  }
}

// ---------- Edge editor ----------
let edgeCtx = null; // { source, target, existing? }

function openEdgeEditor(sourceId, targetId, existing) {
  if (sourceId === targetId) { toast("Can't connect a paper to itself"); return; }
  edgeCtx = { source: sourceId, target: targetId, existing };
  const sp = state.papers.find((p) => p.arxiv_id === sourceId);
  const tp = state.papers.find((p) => p.arxiv_id === targetId);
  $("#edge-modal-title").textContent = existing ? "Edit Connection" : "Connect Papers";
  $("#edge-papers").innerHTML = `
    <div class="ep-row"><span class="ep-tag">A</span><span>${esc(sp?.title || sourceId)}</span></div>
    <div class="ep-row"><span class="ep-tag">B</span><span>${esc(tp?.title || targetId)}</span></div>`;
  $("#edge-label").value = existing?.label || "";
  const dir = existing?.direction || "none";
  $("#edge-dir").querySelectorAll(".dir-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.dir === dir));
  $("#edge-delete").classList.toggle("hidden", !existing);
  $("#edge-ok").textContent = existing ? "Save" : "Connect";
  $("#edge-modal").classList.remove("hidden");
}

$("#edge-dir").querySelectorAll(".dir-btn").forEach((b) => {
  b.onclick = () => {
    $("#edge-dir").querySelectorAll(".dir-btn").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
  };
});
$("#edge-cancel").onclick = () => { $("#edge-modal").classList.add("hidden"); edgeCtx = null; };
$("#edge-delete").onclick = async () => {
  if (edgeCtx?.existing) {
    await invoke("delete_edge", { id: edgeCtx.existing.id });
    $("#edge-modal").classList.add("hidden");
    edgeCtx = null;
    await loadLibrary();
    buildGraphData();
  }
};
$("#edge-ok").onclick = async () => {
  if (!edgeCtx) return;
  const label = $("#edge-label").value.trim();
  const dir = $("#edge-dir").querySelector(".dir-btn.active")?.dataset.dir || "none";
  if (edgeCtx.existing) {
    await invoke("update_edge", { id: edgeCtx.existing.id, label, direction: dir });
  } else {
    await invoke("add_edge", { source: edgeCtx.source, target: edgeCtx.target, label, direction: dir });
  }
  $("#edge-modal").classList.add("hidden");
  edgeCtx = null;
  await loadLibrary();
  buildGraphData();
};

// Connect via right-click menu: pick target from a list.
function startConnectFromMenu(p) {
  const others = state.papers.filter((x) => x.arxiv_id !== p.arxiv_id);
  const items = others.slice(0, 40).map((o) => ({
    label: o.title.length > 50 ? o.title.slice(0, 50) + "…" : o.title,
    action: () => openEdgeEditor(p.arxiv_id, o.arxiv_id, null),
  }));
  // Show a centered menu near the cursor's last position via a simple modal-like list.
  showContextMenu(window.innerWidth / 2 - 100, 120, items.length ? items : [{ label: "No other papers", action: () => {} }]);
}

// ---------- Graph ----------
let graph = {
  nodes: [], links: [], running: false, raf: null,
  scale: 1, ox: 0, oy: 0, // pan/zoom
  dragNode: null, connectFrom: null, hoverEdge: null,
  panning: false, panStart: null,
};

function renderGraphScope() {
  const sel = $("#graph-scope-select");
  const cur = sel.value;
  sel.innerHTML = `<option value="all">Whole library</option>` +
    state.collections.map((c) => `<option value="col:${c.id}">${esc(c.name)}</option>`).join("");
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

function graphPapers() {
  const scope = $("#graph-scope-select").value;
  if (scope.startsWith("col:")) {
    const cid = scope.slice(4);
    return state.papers.filter((p) => state.membership[p.arxiv_id]?.has(cid));
  }
  return state.papers;
}

function buildGraphData() {
  const papers = graphPapers();
  const ids = new Set(papers.map((p) => p.arxiv_id));
  const prev = {};
  for (const n of graph.nodes) prev[n.id] = n;

  const cx = ($("#graph-canvas").width || 800) / 2;
  const cy = ($("#graph-canvas").height || 600) / 2;
  graph.nodes = papers.map((p, i) => {
    const old = prev[p.arxiv_id];
    return {
      id: p.arxiv_id,
      title: p.title,
      color: nodeColor(p.arxiv_id),
      x: old?.x ?? cx + Math.cos(i) * 150 + (Math.random() - 0.5) * 40,
      y: old?.y ?? cy + Math.sin(i) * 150 + (Math.random() - 0.5) * 40,
      vx: 0, vy: 0,
    };
  });
  const nodeById = {};
  for (const n of graph.nodes) nodeById[n.id] = n;
  graph.links = state.edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e) => ({ ...e, s: nodeById[e.source], t: nodeById[e.target] }));

  const empty = $("#graph-empty");
  empty.classList.toggle("hidden", graph.nodes.length > 0);
}

function nodeColor(paperId) {
  // Color a node by its first colored collection, else accent.
  const cols = state.membership[paperId];
  if (cols) {
    for (const c of state.collections) {
      if (cols.has(c.id) && c.color) return c.color;
    }
  }
  return getComputedStyle(document.documentElement).getPropertyValue("--accent-soft").trim() || "#e0524a";
}

function startGraph() {
  const canvas = $("#graph-canvas");
  resizeGraphCanvas();
  buildGraphData();
  graph.running = true;
  if (!graph._wired) wireGraphCanvas();
  loopGraph();
}

function stopGraph() {
  graph.running = false;
  if (graph.raf) cancelAnimationFrame(graph.raf);
}

function resizeGraphCanvas() {
  const canvas = $("#graph-canvas");
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  graph._dpr = dpr;
}

function loopGraph() {
  if (!graph.running) return;
  simulateGraph();
  drawGraph();
  graph.raf = requestAnimationFrame(loopGraph);
}

function simulateGraph() {
  const nodes = graph.nodes, links = graph.links;
  const k = 0.012;        // spring
  const rest = 130;       // rest length
  const repel = 5200;     // repulsion
  const center = 0.008;
  const cw = $("#graph-canvas").width, ch = $("#graph-canvas").height;
  const cx = cw / 2, cy = ch / 2;

  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    if (a === graph.dragNode) continue;
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      let d2 = dx * dx + dy * dy + 0.01;
      let f = repel / d2;
      let d = Math.sqrt(d2);
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }
    a.vx += (cx - a.x) * center;
    a.vy += (cy - a.y) * center;
  }
  for (const l of links) {
    const dx = l.t.x - l.s.x, dy = l.t.y - l.s.y;
    const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
    const f = (d - rest) * k;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    if (l.s !== graph.dragNode) { l.s.vx += fx; l.s.vy += fy; }
    if (l.t !== graph.dragNode) { l.t.vx -= fx; l.t.vy -= fy; }
  }
  for (const n of nodes) {
    if (n === graph.dragNode) continue;
    n.vx *= 0.85; n.vy *= 0.85;
    n.x += n.vx; n.y += n.vy;
  }
}

function toScreen(x, y) {
  return [x * graph.scale + graph.ox, y * graph.scale + graph.oy];
}
function toWorld(sx, sy) {
  return [(sx - graph.ox) / graph.scale, (sy - graph.oy) / graph.scale];
}

function drawGraph() {
  const canvas = $("#graph-canvas");
  const ctx = canvas.getContext("2d");
  const css = getComputedStyle(document.documentElement);
  const dim = css.getPropertyValue("--text-dim").trim() || "#888";
  const textCol = css.getPropertyValue("--text").trim() || "#fff";
  const border = css.getPropertyValue("--border").trim() || "#444";

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Edges
  ctx.lineWidth = 1.5 * graph.scale;
  for (const l of graph.links) {
    const [sx, sy] = toScreen(l.s.x, l.s.y);
    const [tx, ty] = toScreen(l.t.x, l.t.y);
    ctx.strokeStyle = (graph.hoverEdge === l) ? css.getPropertyValue("--accent-soft").trim() : border;
    ctx.beginPath();
    ctx.moveTo(sx, sy); ctx.lineTo(tx, ty); ctx.stroke();
    // arrows
    if (l.direction === "forward" || l.direction === "both") drawArrow(ctx, sx, sy, tx, ty);
    if (l.direction === "both") drawArrow(ctx, tx, ty, sx, sy);
    // label
    if (l.label) {
      ctx.fillStyle = dim;
      ctx.font = `${11 * graph.scale}px -apple-system, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(l.label, (sx + tx) / 2, (sy + ty) / 2 - 4);
    }
  }

  // Pending connect line
  if (graph.connectFrom && graph._pointer) {
    const [sx, sy] = toScreen(graph.connectFrom.x, graph.connectFrom.y);
    ctx.strokeStyle = css.getPropertyValue("--accent-soft").trim();
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(graph._pointer[0], graph._pointer[1]); ctx.stroke();
    ctx.setLineDash([]);
  }

  // Nodes
  const r = 7 * graph.scale;
  for (const n of graph.nodes) {
    const [x, y] = toScreen(n.x, n.y);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = n.color;
    ctx.fill();
    ctx.lineWidth = 1.5 * graph.scale;
    ctx.strokeStyle = (n === graph.selectedNode) ? textCol : "rgba(0,0,0,0.3)";
    ctx.stroke();
    // label
    ctx.fillStyle = textCol;
    ctx.font = `${11 * graph.scale}px -apple-system, sans-serif`;
    ctx.textAlign = "center";
    const short = n.title.length > 28 ? n.title.slice(0, 28) + "…" : n.title;
    ctx.fillText(short, x, y + r + 13 * graph.scale);
  }
}

function drawArrow(ctx, fromX, fromY, toX, toY) {
  const angle = Math.atan2(toY - fromY, toX - fromX);
  const r = 9 * graph.scale;
  const ax = toX - Math.cos(angle) * r;
  const ay = toY - Math.sin(angle) * r;
  const size = 7 * graph.scale;
  ctx.fillStyle = ctx.strokeStyle;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(ax - size * Math.cos(angle - 0.4), ay - size * Math.sin(angle - 0.4));
  ctx.lineTo(ax - size * Math.cos(angle + 0.4), ay - size * Math.sin(angle + 0.4));
  ctx.closePath();
  ctx.fill();
}

function nodeAt(sx, sy, exclude) {
  const r = 12 * graph.scale;
  for (let i = graph.nodes.length - 1; i >= 0; i--) {
    const n = graph.nodes[i];
    if (n === exclude) continue;
    const [x, y] = toScreen(n.x, n.y);
    if ((x - sx) ** 2 + (y - sy) ** 2 <= r * r) return n;
  }
  return null;
}
function edgeAt(sx, sy) {
  for (const l of graph.links) {
    const [x1, y1] = toScreen(l.s.x, l.s.y);
    const [x2, y2] = toScreen(l.t.x, l.t.y);
    const d = distToSegment(sx, sy, x1, y1, x2, y2);
    if (d < 6) return l;
  }
  return null;
}
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function wireGraphCanvas() {
  const canvas = $("#graph-canvas");
  graph._wired = true;

  const getPos = (e) => {
    const rect = canvas.getBoundingClientRect();
    const dpr = graph._dpr || 1;
    return [(e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr];
  };

  canvas.addEventListener("mousedown", (e) => {
    const [sx, sy] = getPos(e);
    const n = nodeAt(sx, sy);
    if (n) {
      if (e.shiftKey) { graph.connectFrom = n; graph._pointer = [sx, sy]; }
      else { graph.dragNode = n; graph._moved = false; }
    } else {
      graph.panning = true;
      graph.panStart = [sx - graph.ox, sy - graph.oy];
    }
  });
  canvas.addEventListener("mousemove", (e) => {
    const [sx, sy] = getPos(e);
    graph._pointer = [sx, sy];
    if (graph.dragNode) {
      const [wx, wy] = toWorld(sx, sy);
      graph.dragNode.x = wx; graph.dragNode.y = wy;
      graph.dragNode.vx = 0; graph.dragNode.vy = 0;
      graph._moved = true;
    } else if (graph.panning) {
      graph.ox = sx - graph.panStart[0];
      graph.oy = sy - graph.panStart[1];
    } else {
      graph.hoverEdge = edgeAt(sx, sy);
      canvas.style.cursor = nodeAt(sx, sy) ? "pointer" : (graph.hoverEdge ? "pointer" : "grab");
    }
  });
  canvas.addEventListener("mouseup", (e) => {
    const [sx, sy] = getPos(e);
    if (graph.connectFrom) {
      const target = nodeAt(sx, sy, graph.connectFrom);
      if (target) {
        openEdgeEditor(graph.connectFrom.id, target.id, null);
      }
      graph.connectFrom = null;
    } else if (graph.dragNode) {
      const dragged = graph.dragNode;
      graph.dragNode = null; // clear first so simulation resumes
      if (!graph._moved) {
        // Click without drag → open the paper.
        openPaperFromGraph(dragged.id);
      } else {
        // Dropped on another node → connect.
        const onNode = nodeAt(sx, sy, dragged);
        if (onNode) openEdgeEditor(dragged.id, onNode.id, null);
      }
    } else if (!graph.panning || !graphMovedPan(sx, sy)) {
      const l = edgeAt(sx, sy);
      if (l) openEdgeEditor(l.source, l.target, l);
    }
    graph.panning = false;
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const [sx, sy] = getPos(e);
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const [wx, wy] = toWorld(sx, sy);
    graph.scale = Math.max(0.2, Math.min(4, graph.scale * factor));
    // keep cursor point stable
    graph.ox = sx - wx * graph.scale;
    graph.oy = sy - wy * graph.scale;
  }, { passive: false });

  window.addEventListener("resize", () => {
    if (state.view.type === "graph") { resizeGraphCanvas(); }
  });
}
function graphMovedPan() { return false; }

function openPaperFromGraph(id) {
  const p = state.papers.find((x) => x.arxiv_id === id);
  if (!p) return;
  // Switch to All Papers and open the paper detail.
  selectView({ type: "smart", smart: "all" });
  selectPaper(p);
}

$("#graph-scope-select").addEventListener("change", () => { buildGraphData(); });
$("#graph-zoom-in").onclick = () => { graph.scale = Math.min(4, graph.scale * 1.2); };
$("#graph-zoom-out").onclick = () => { graph.scale = Math.max(0.2, graph.scale * 0.8); };
$("#graph-zoom-reset").onclick = () => { graph.scale = 1; graph.ox = 0; graph.oy = 0; };

// ---------- Context menu ----------
// Platform-aware modifier symbol for display.
const IS_MAC = navigator.platform.toUpperCase().includes("MAC") || navigator.userAgent.includes("Mac");
const MOD = IS_MAC ? "⌘" : "Ctrl";
const SHORTCUTS = [
  { keys: [MOD, "K"], desc: "Quick search arXiv" },
  { keys: [MOD, "F"], desc: "Focus search / library filter" },
  { keys: [MOD, "N"], desc: "New collection" },
  { keys: [MOD, ","], desc: "Open settings" },
  { keys: [MOD, "/"], desc: "Show this shortcuts list" },
  { keys: [MOD, "+"], desc: "Increase font size" },
  { keys: [MOD, "−"], desc: "Decrease font size" },
  { keys: [MOD, "0"], desc: "Reset font size" },
  { keys: ["/"], desc: "Focus search / library filter" },
  { keys: ["↑", "↓"], desc: "Navigate papers in the list (also J / K)" },
  { keys: ["S"], desc: "Save the selected search result to your library" },
  { keys: ["O"], desc: "Open the selected paper's PDF" },
  { keys: ["A"], desc: "Open the selected paper's arXiv page" },
  { keys: [MOD, "A"], desc: "Select all papers in the list" },
  { keys: ["⌫"], desc: "Move selected paper(s) to Trash" },
  { keys: ["Esc"], desc: "Close popups / overlays" },
  { keys: [MOD, "click"], desc: "Multi-select papers, collections, tags" },
  { keys: ["Shift", "click"], desc: "Range-select papers" },
];

function showShortcutsViewer() {
  document.querySelector("#shortcuts-overlay")?.remove();
  const overlay = el("div", "");
  overlay.id = "shortcuts-overlay";
  const rows = SHORTCUTS.map((s) =>
    `<div class="sc-row"><span class="sc-desc">${esc(s.desc)}</span><span class="sc-keys">${s.keys.map((k) => `<kbd>${esc(k)}</kbd>`).join("")}</span></div>`
  ).join("");
  overlay.innerHTML = `
    <div class="sc-box">
      <div class="sc-head"><strong>Keyboard shortcuts</strong><button class="sc-close">✕</button></div>
      <div class="sc-list">${rows}</div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector(".sc-close").onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
}

function openQuickSearch() {
  const ov = $("#quick-search-overlay");
  ov.classList.remove("hidden");
  const inp = $("#quick-search-input");
  inp.value = "";
  setTimeout(() => inp.focus(), 0);
}
function closeQuickSearch() {
  $("#quick-search-overlay").classList.add("hidden");
}
function runQuickSearch() {
  const term = $("#quick-search-input").value.trim();
  if (!term) { closeQuickSearch(); return; }
  closeQuickSearch();
  // Go to the arXiv search panel and run the query there.
  selectView({ type: "search" });
  // Ensure advanced panel is closed so the plain query path is used.
  $("#adv-panel")?.classList.add("hidden");
  $("#search-input").value = term;
  $("#search-clear")?.classList.toggle("hidden", !term);
  runSearch();
}
$("#quick-search-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); runQuickSearch(); }
  if (e.key === "Escape") { e.preventDefault(); closeQuickSearch(); }
});
$("#quick-search-overlay")?.addEventListener("click", (e) => {
  if (e.target.id === "quick-search-overlay") closeQuickSearch();
});

function closeAllCtxMenus() {
  document.querySelectorAll(".ctx-menu, .ctx-submenu").forEach((m) => m.remove());
}

function showContextMenu(x, y, items) {
  closeAllCtxMenus();
  const menu = buildCtxMenu(items);
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - 220)) + "px";
  menu.style.top = "8px"; // temp, corrected after measuring
  document.body.appendChild(menu);
  // Now that it's in the DOM we know its real (possibly capped) height.
  const h = menu.offsetHeight;
  let top = y;
  if (y + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);
  menu.style.top = Math.max(8, top) + "px";
  setTimeout(() => {
    document.addEventListener("click", function close() {
      closeAllCtxMenus();
      document.removeEventListener("click", close);
    });
  }, 0);
}

function buildCtxMenu(items) {
  const menu = el("div", "ctx-menu");
  for (const it of items) {
    if (it.sep) { menu.appendChild(el("div", "sep")); continue; }
    if (it.sub) {
      // Hover-expanding submenu. Positioned as a fixed flyout on hover so it
      // escapes the parent menu's vertical scroll clipping.
      const wrap = el("div", "ctx-sub-wrap");
      const b = el("button", "ctx-has-sub", esc(it.label));
      wrap.appendChild(b);
      const panel = buildCtxMenu(it.sub);
      panel.classList.add("ctx-submenu");
      document.body.appendChild(panel); // attach to body, not inside scroll area
      const show = () => {
        const r = b.getBoundingClientRect();
        panel.style.display = "block";
        // Measure then place; flip left if it would overflow the right edge.
        const pw = panel.offsetWidth || 200;
        let left = r.right + 2;
        if (left + pw > window.innerWidth - 8) left = r.left - pw - 2;
        let top = r.top - 5;
        const ph = panel.offsetHeight;
        if (top + ph > window.innerHeight - 8) top = Math.max(8, window.innerHeight - ph - 8);
        panel.style.left = Math.max(8, left) + "px";
        panel.style.top = top + "px";
      };
      const hide = () => { panel.style.display = "none"; };
      wrap.addEventListener("mouseenter", show);
      wrap.addEventListener("mouseleave", (e) => {
        // Keep open if moving into the panel itself.
        if (!panel.contains(e.relatedTarget)) hide();
      });
      panel.addEventListener("mouseleave", (e) => {
        if (!wrap.contains(e.relatedTarget)) hide();
      });
      menu.appendChild(wrap);
      continue;
    }
    const b = el("button", it.danger ? "danger" : "", esc(it.label));
    if (it.disabled) {
      b.classList.add("ctx-disabled");
      b.disabled = true;
    } else {
      b.onclick = () => {
        closeAllCtxMenus();
        it.action();
      };
    }
    menu.appendChild(b);
  }
  return menu;
}

// ---------- Wire up ----------
document.querySelectorAll('[data-view="smart"]').forEach((btn) => {
  btn.onclick = () => selectView({ type: "smart", smart: btn.dataset.smart });
  if (btn.dataset.smart === "all") {
    btn.ondragover = (e) => {
      e.preventDefault();
      btn.classList.toggle("drop-hover", inDropBand(e, btn));
    };
    btn.ondragleave = () => btn.classList.remove("drop-hover");
    btn.ondrop = async (e) => {
      e.preventDefault();
      const hit = inDropBand(e, btn);
      btn.classList.remove("drop-hover");
      if (!hit) return;
      await handleDropToLibrary();
    };
  }
});
document.querySelector('[data-view="search"]').onclick = () => selectView({ type: "search" });
document.querySelector('[data-view="feed"]').onclick = () => selectView({ type: "feed" });
document.querySelector('[data-view="history"]').onclick = () => selectView({ type: "history" });
document.querySelector('[data-view="bibliography"]').onclick = () => selectView({ type: "bibliography" });
document.querySelector('[data-view="graph"]').onclick = () => selectView({ type: "graph" });
$("#feed-refresh").onclick = () => loadFeed();
$("#nav-back").onclick = navBack;
$("#nav-forward").onclick = navForward;
$("#add-saved-search").onclick = () => openSavedSearchModal(null);
$("#ss-refresh").onclick = () => { if (state.view.type === "saved") { delete state.savedSearchCache[state.view.id]; loadSavedSearch(state.view.id); } };
$("#ss-edit").onclick = () => { if (state.view.type === "saved") { const s = state.savedSearches.find((x) => x.id === state.view.id); if (s) openSavedSearchModal(s); } };
$("#bib-add").onclick = addBibByDoi;
$("#bib-doi-input").addEventListener("keydown", (e) => { if (e.key === "Enter") addBibByDoi(); });
$("#bib-export").onclick = (e) => {
  e.stopPropagation();
  showContextMenu(e.clientX, e.clientY, [
    { label: "Export BibTeX (.bib)", action: () => exportBibliography("bibtex") },
    { label: "Export RIS (.ris)", action: () => exportBibliography("ris") },
  ]);
};
$("#bib-import").onclick = (e) => {
  e.stopPropagation();
  showContextMenu(e.clientX, e.clientY, [
    { label: "Import .bib / .ris file…", action: () => importBibliography() },
  ]);
};
$("#feed-add-cat").onclick = () => openCategoryPicker();
$("#search-btn").onclick = runSearch;
$("#search-input").addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); if (e.key === "Escape") hideSearchSuggestions(); });
$("#search-input").addEventListener("input", (e) => {
  $("#search-clear").classList.toggle("hidden", !e.target.value);
  showSearchSuggestions();
});
$("#search-input").addEventListener("focus", () => showSearchSuggestions());
document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-input-wrap") && !e.target.closest("#search-suggest")) hideSearchSuggestions();
});
$("#search-clear").onclick = () => {
  const inp = $("#search-input");
  inp.value = ""; inp.focus();
  $("#search-clear").classList.add("hidden");
};
$("#quick-sort").addEventListener("change", () => { if (state.searchResults.length || $("#search-input").value.trim()) runSearch(); });
$("#adv-toggle").onclick = () => {
  const panel = $("#adv-panel");
  panel.classList.toggle("hidden");
  $("#adv-toggle").classList.toggle("open", !panel.classList.contains("hidden"));
};
$("#adv-date").addEventListener("change", (e) => {
  $("#adv-year-row").classList.toggle("hidden", e.target.value !== "year");
  $("#adv-range-row").classList.toggle("hidden", e.target.value !== "range");
});
$("#add-collection").onclick = () =>
  openModal("New Collection", "", "Create", async (name) => {
    await invoke("add_collection", { name, parentId: null });
    await loadLibrary();
  });
$("#add-tag").onclick = () =>
  openModal("New Tag", "", "Create", async (name) => {
    await invoke("add_tag", { name, color: null });
    await loadLibrary();
  });
$("#export-library").onclick = () => exportDois(state.papers, "Full Library");
$("#backup-library").onclick = backupLibrary;

// Library filter / sort / status / density
let filterTimer;
$("#lib-filter").addEventListener("input", (e) => {
  clearTimeout(filterTimer);
  $("#lib-filter-clear").classList.toggle("hidden", !e.target.value);
  filterTimer = setTimeout(() => { state.libFilter = e.target.value; renderList(); }, 200);
});
$("#lib-filter-clear").onclick = () => {
  const inp = $("#lib-filter");
  inp.value = "";
  state.libFilter = "";
  $("#lib-filter-clear").classList.add("hidden");
  renderList();
  inp.focus();
};
$("#lib-sort").addEventListener("change", (e) => { state.libSort = e.target.value; renderList(); });
$("#lib-status").addEventListener("change", (e) => { state.libStatus = e.target.value; renderList(); });
$("#density-toggle").onclick = () => {
  state.density = state.density === "compact" ? "normal" : "compact";
  try { localStorage.setItem("density", state.density); } catch {}
  renderList();
};

// Open markdown-note external links in the system browser instead of navigating.
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-ext]");
  if (a) { e.preventDefault(); openUrl(a.getAttribute("href")); }
});

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);

  // While the PDF reader is open, it owns the keyboard. Don't let library
  // shortcuts (arrows, Backspace/Delete, etc.) act on the hidden background.
  if (!$("#pdf-overlay").classList.contains("hidden")) {
    if (e.key === "Escape" && !typing) { $("#pdf-close").click(); e.preventDefault(); }
    if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+")) { e.preventDefault(); zoomActive(1.15); }
    if ((e.metaKey || e.ctrlKey) && e.key === "-") { e.preventDefault(); zoomActive(1 / 1.15); }
    if ((e.metaKey || e.ctrlKey) && e.key === "f") { e.preventDefault(); $("#pdf-search-input").focus(); }
    return;
  }

  // Escape closes whichever dialog is open, even while typing inside it.
  if (e.key === "Escape") {
    const dialogs = [
      ["#modal", () => $("#modal").classList.add("hidden")],
      ["#saved-search-modal", () => $("#saved-search-modal").classList.add("hidden")],
      ["#category-modal", () => $("#category-modal").classList.add("hidden")],
      ["#edge-modal", () => $("#edge-cancel").click()],
      ["#color-modal", () => $("#color-cancel").click()],
    ];
    for (const [sel, close] of dialogs) {
      if (!$(sel).classList.contains("hidden")) { e.preventDefault(); close(); return; }
    }
    if (document.querySelector(".ctx-menu")) { closeAllCtxMenus(); return; }
  }

  // Quick search: Cmd+K (Mac) / Ctrl+K (Linux/Win). Opens a small popup that
  // jumps to the arXiv search panel and runs the query.
  if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    if ($("#quick-search-overlay").classList.contains("hidden")) openQuickSearch();
    else closeQuickSearch();
    return;
  }

  if ((e.metaKey || e.ctrlKey) && e.key === "f") {
    e.preventDefault();
    if (state.view.type === "search") $("#search-input").focus();
    else { $("#lib-filter").focus(); }
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "n") {
    e.preventDefault();
    openModal("New Collection", "", "Create", async (name) => {
      await invoke("add_collection", { name, parentId: null }); await loadLibrary();
    });
    return;
  }
  // Open Settings (Cmd+,) — standard macOS convention.
  if ((e.metaKey || e.ctrlKey) && e.key === ",") {
    e.preventDefault();
    if ($("#settings-overlay").classList.contains("hidden")) openSettings();
    else $("#settings-close").click();
    return;
  }
  // Show keyboard shortcuts (Cmd+/).
  if ((e.metaKey || e.ctrlKey) && e.key === "/") {
    e.preventDefault();
    showShortcutsViewer();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+")) {
    e.preventDefault();
    setFontScale(fontScale + FONT_STEP);
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "-") {
    e.preventDefault();
    setFontScale(fontScale - FONT_STEP);
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "0") {
    e.preventDefault();
    setFontScale(100);
    return;
  }
  if (typing) return;
  // Single-key shortcuts must not fire behind an open dialog.
  const anyDialog = ["#modal", "#saved-search-modal", "#category-modal", "#edge-modal", "#color-modal",
    "#settings-overlay", "#name-modal", "#onboarding-overlay", "#quick-search-overlay"]
    .some((sel) => !$(sel).classList.contains("hidden"));
  if (anyDialog && e.key !== "Escape") return;
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
  const listView = !["graph", "history", "bibliography"].includes(state.view.type);

  if (plain && e.key === "/") {
    e.preventDefault();
    if (state.view.type === "search") $("#search-input").focus();
    else if (!$("#library-controls").classList.contains("hidden")) $("#lib-filter").focus();
    else { selectView({ type: "search" }); $("#search-input").focus(); }
    return;
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A") && listView) {
    e.preventDefault();
    for (const p of currentPapers()) state.selectedIds.add(p.arxiv_id);
    refreshListHighlight();
    return;
  }
  const cur = state.selectedPaper;
  if (plain && cur && listView) {
    const k = e.key.toLowerCase();
    if (k === "s" && !isInLibrary(cur.arxiv_id)) {
      e.preventDefault();
      saveWithDupCheck(cur).then((did) => {
        if (did) selectPaper(state.papers.find((x) => x.arxiv_id === cur.arxiv_id) || cur);
      });
      return;
    }
    if (k === "o") {
      e.preventDefault();
      ($("#read-pdf") || $("#open-preview"))?.click();
      return;
    }
    if (k === "a") {
      e.preventDefault();
      openUrl(cur.abs_url || `https://arxiv.org/abs/${cur.arxiv_id}`);
      return;
    }
  }
  // Trash: Backspace/Delete on selected papers (or the open one). Library views only.
  if ((e.key === "Backspace" || e.key === "Delete")) {
    const inLibraryView = state.view.type === "collection" ||
      (state.view.type === "smart" && state.view.smart !== "trash") ||
      state.view.type === "tag";
    const inTrashView = state.view.type === "smart" && state.view.smart === "trash";
    if (inLibraryView) {
      const ids = state.selectedIds.size ? [...state.selectedIds]
        : (state.selectedPaper ? [state.selectedPaper.arxiv_id] : []);
      if (ids.length) {
        e.preventDefault();
        trashPapers(ids);
      }
      return;
    }
    if (inTrashView) {
      const ids = state.selectedIds.size ? [...state.selectedIds]
        : (state.selectedPaper ? [state.selectedPaper.arxiv_id] : []);
      if (ids.length) {
        e.preventDefault();
        deletePapersForever(ids);
      }
      return;
    }
  }
  // Arrow (or j/k) navigation through the current list
  const down = e.key === "ArrowDown" || (plain && e.key === "j");
  const up = e.key === "ArrowUp" || (plain && e.key === "k");
  if ((down || up) && listView) {
    const papers = currentPapers();
    if (!papers.length) return;
    const idx = papers.findIndex((p) => p.arxiv_id === state.selectedPaper?.arxiv_id);
    let next = down ? idx + 1 : idx - 1;
    next = Math.max(0, Math.min(papers.length - 1, next));
    selectPaper(papers[next]);
    document.querySelectorAll(".paper-card")[next]?.scrollIntoView({ block: "nearest" });
    e.preventDefault();
  }
  if (e.key === "Escape") {
    if (document.querySelector("#shortcuts-overlay")) { document.querySelector("#shortcuts-overlay").remove(); return; }
    if (!$("#quick-search-overlay").classList.contains("hidden")) { closeQuickSearch(); return; }
    if (!$("#settings-overlay").classList.contains("hidden")) { $("#settings-close").click(); }
  }
});

// ---------- Settings & usage ----------
function fmtDuration(seconds) {
  seconds = Math.floor(seconds || 0);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}
function fmtBytes(b) {
  if (!b) return "0 MB";
  const mb = b / (1024 * 1024);
  if (mb >= 1024) return (mb / 1024).toFixed(2) + " GB";
  return mb.toFixed(1) + " MB";
}

let appSettings = null;

// ---------- Appearance (font size + family) ----------
const FONT_MIN = 70, FONT_MAX = 160, FONT_STEP = 10;
let fontScale = 100;
let fontFamily = "system";

function applyAppearance() {
  document.documentElement.style.setProperty("--font-scale", (fontScale / 100).toString());
  document.documentElement.setAttribute("data-font", fontFamily);
  // Only apply the scaling transform when actually zoomed, so the default 100%
  // view renders pixel-perfect crisp (no compositing-layer softening).
  const app = document.getElementById("app");
  if (app) app.classList.toggle("zoomed", fontScale !== 100);
  const valEl = document.getElementById("font-scale-value");
  if (valEl) valEl.textContent = fontScale + "%";
  const sel = document.getElementById("font-family-select");
  if (sel) sel.value = fontFamily;
}

async function persistAppearance() {
  try { await invoke("set_appearance", { fontScale, fontFamily }); } catch {}
}

function setFontScale(next) {
  fontScale = Math.max(FONT_MIN, Math.min(FONT_MAX, next));
  applyAppearance();
  persistAppearance();
}

async function checkFirstRun() {
  appSettings = await invoke("get_settings");
  state.historyEnabled = appSettings.history_enabled !== false;
  applyHistoryVisibility(state.historyEnabled);
  fontScale = appSettings.font_scale || 100;
  fontFamily = appSettings.font_family || "system";
  applyAppearance();
  state.savedSearches = appSettings.saved_searches || [];
  renderSavedSearches();
  if (!appSettings.name) {
    const modal = $("#name-modal");
    modal.classList.remove("hidden");
    const input = $("#name-input");
    input.focus();
    const submit = async () => {
      const v = input.value.trim() || "Researcher";
      await invoke("set_name", { name: v });
      appSettings = await invoke("get_settings");
      modal.classList.add("hidden");
      showOnboarding();
    };
    $("#name-ok").onclick = submit;
    input.onkeydown = (e) => { if (e.key === "Enter") submit(); };
  } else {
    // Show onboarding once for existing users who haven't seen it.
    let seen = true;
    try { seen = localStorage.getItem("onboarded") === "1"; } catch {}
    if (!seen) showOnboarding();
  }
}

function showOnboarding() {
  $("#onboarding-overlay").classList.remove("hidden");
}
$("#onboard-done").onclick = () => {
  $("#onboarding-overlay").classList.add("hidden");
  try { localStorage.setItem("onboarded", "1"); } catch {}
};
$("#show-tour").onclick = () => { $("#settings-overlay").classList.add("hidden"); showOnboarding(); };

async function openSettings() {
  await flushUsage(); // capture current session time before showing stats
  appSettings = await invoke("get_settings");
  $("#settings-name").textContent = appSettings.name || "—";
  refreshThemeUI();
  // Sync graph toggle from saved preference.
  let showGraph = false;
  try { showGraph = localStorage.getItem("showGraph") === "1"; } catch {}
  $("#graph-toggle-setting").checked = showGraph;
  let showFeed = true;
  try { showFeed = localStorage.getItem("showFeed") !== "0"; } catch {}
  $("#feed-toggle-setting").checked = showFeed;
  let showArchived = true;
  try { showArchived = localStorage.getItem("showArchived") !== "0"; } catch {}
  $("#archived-toggle-setting").checked = showArchived;
  let swapPanels = false;
  try { swapPanels = localStorage.getItem("swapPanels") === "1"; } catch {}
  $("#swap-panels-setting").checked = swapPanels;
  $("#search-history-setting").checked = searchHistoryEnabled();
  $("#search-suggest-setting").checked = searchSuggestionsEnabled();
  // History toggle reflects the persisted setting.
  $("#history-toggle-setting").checked = appSettings.history_enabled !== false;
  state.historyEnabled = appSettings.history_enabled !== false;
  // Reflect persisted appearance in the controls.
  fontScale = appSettings.font_scale || fontScale;
  fontFamily = appSettings.font_family || fontFamily;
  applyAppearance();

  // Time stats
  const usage = appSettings.usage || {};
  const total = Object.values(usage).reduce((a, b) => a + b, 0);
  const todayKey = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD
  $("#time-total").textContent = fmtDuration(total);
  $("#time-today").textContent = fmtDuration(usage[todayKey] || 0);

  // This week (last 7 days)
  let weekTotal = 0;
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toLocaleDateString("en-CA");
    const secs = usage[key] || 0;
    weekTotal += secs;
    days.push({ key, secs, label: d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) });
  }
  $("#time-week").textContent = fmtDuration(weekTotal);

  // Scale each bar against a full 24-hour day so the bar length reflects
  // absolute time spent (a full-width bar = 24h), capped at 100%.
  const DAY_SECS = 24 * 3600;
  $("#time-breakdown").innerHTML = days.map((d) => {
    const pct = d.secs > 0 ? Math.max(2, Math.min(100, (d.secs / DAY_SECS) * 100)) : 0;
    return `
    <div class="time-bar-row${d.secs > 0 ? "" : " is-empty"}">
      <span class="tb-day">${esc(d.label)}</span>
      <span class="tb-track"><span class="tb-fill" style="width:${pct.toFixed(1)}%"></span></span>
      <span class="tb-val">${esc(fmtDuration(d.secs))}</span>
    </div>`;
  }).join("");

  // PDF storage
  try {
    const used = await invoke("pdf_storage_used");
    $("#pdf-storage").textContent = fmtBytes(used);
  } catch { $("#pdf-storage").textContent = "—"; }

  // Collection dropdown for per-collection PDF deletion
  const sel = $("#pdf-del-collection");
  sel.innerHTML = state.collections.length
    ? state.collections.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")
    : `<option value="">(no collections)</option>`;

  $("#settings-overlay").classList.remove("hidden");
}

$("#open-settings").onclick = openSettings;
$("#settings-close").onclick = () => $("#settings-overlay").classList.add("hidden");
$("#settings-overlay").addEventListener("click", (e) => {
  if (e.target.id === "settings-overlay") $("#settings-overlay").classList.add("hidden");
});

$("#rename-user").onclick = () =>
  openModal("Rename", appSettings?.name || "", "Save", async (name) => {
    await invoke("set_name", { name });
    appSettings = await invoke("get_settings");
    $("#settings-name").textContent = name;
  });

// Feedback → opens email to developer
$("#send-feedback").onclick = () => {
  openUrl("https://github.com/Pankajsharma05/ArXiv-Library-releases/issues");
};

// Graph sidebar visibility toggle
$("#graph-toggle-setting").onchange = (e) => {
  const show = e.target.checked;
  try { localStorage.setItem("showGraph", show ? "1" : "0"); } catch {}
  applyGraphVisibility(show);
};
function applyGraphVisibility(show) {
  const btn = document.querySelector('[data-view="graph"]');
  if (btn) btn.style.display = show ? "" : "none";
  // If currently in graph view and hiding it, bounce to search.
  if (!show && state.view.type === "graph") selectView({ type: "search" });
}

// Daily Feed sidebar visibility toggle
$("#feed-toggle-setting").onchange = (e) => {
  const show = e.target.checked;
  try { localStorage.setItem("showFeed", show ? "1" : "0"); } catch {}
  applyFeedVisibility(show);
};
$("#archived-toggle-setting").onchange = (e) => {
  const show = e.target.checked;
  try { localStorage.setItem("showArchived", show ? "1" : "0"); } catch {}
  renderCollections();
};
function applyPanelSwap(on) {
  $("#app").classList.toggle("panels-swapped", on);
}
$("#search-history-setting").onchange = (e) => {
  try { localStorage.setItem("saveSearchHistory", e.target.checked ? "1" : "0"); } catch {}
};
$("#search-suggest-setting").onchange = (e) => {
  try { localStorage.setItem("searchSuggestions", e.target.checked ? "1" : "0"); } catch {}
  if (!e.target.checked) hideSearchSuggestions();
};
$("#clear-search-history").onclick = () => { clearSearchHistory(); hideSearchSuggestions(); toast("Search history cleared"); };
$("#view-search-history").onclick = () => showSearchHistoryViewer();
$("#view-shortcuts").onclick = () => showShortcutsViewer();

function refreshThemeSelect() {
  const sel = $("#theme-select");
  if (!sel) return;
  const custom = getCustomThemes();
  sel.innerHTML =
    `<option value="dark">Dark (default)</option>` +
    `<option value="light">Light (default)</option>` +
    custom.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("");
  sel.value = getActiveTheme();
  // Delete button only enabled for custom themes.
  const delBtn = $("#delete-theme-btn");
  if (delBtn) delBtn.disabled = (sel.value === "light" || sel.value === "dark");
}
function refreshAccentSwatches() {
  const d = getCustomAccent("dark") || DEFAULT_ACCENT.dark;
  const l = getCustomAccent("light") || DEFAULT_ACCENT.light;
  const ds = $("#accent-dark-swatch"), ls = $("#accent-light-swatch");
  if (ds) ds.style.background = d;
  if (ls) ls.style.background = l;
}
function refreshThemeUI() { refreshThemeSelect(); refreshAccentSwatches(); }

$("#theme-select").onchange = (e) => { setActiveTheme(e.target.value); applyActiveTheme(); refreshThemeUI(); };

// Create a custom theme: pick base color, then accent, then name.
$("#new-theme-btn").onclick = () => {
  openColorPicker({ name: "base / background color", color: "#1b1d24" }, (base) => {
    if (!base) return;
    openColorPicker({ name: "accent color", color: "#5b8def" }, (accent) => {
      if (!accent) return;
      openModal("Name this theme", "", "Create", (name) => {
        const nm = (name || "").trim() || "Custom";
        const id = "theme_" + Date.now().toString(36);
        const themes = getCustomThemes();
        themes.push({ id, name: nm, base, accent });
        saveCustomThemes(themes);
        setActiveTheme(id);
        applyActiveTheme();
        refreshThemeUI();
        toast(`Theme "${nm}" created`);
      });
    });
  });
};
$("#delete-theme-btn").onclick = async () => {
  const id = getActiveTheme();
  if (id === "light" || id === "dark") return;
  const t = getCustomThemes().find((x) => x.id === id);
  const ok = await window.__TAURI__.dialog.confirm(`Delete theme "${t?.name || "this"}"?`, { title: "Delete theme", kind: "warning" });
  if (!ok) return;
  saveCustomThemes(getCustomThemes().filter((x) => x.id !== id));
  setActiveTheme("dark");
  applyActiveTheme();
  refreshThemeUI();
};

function pickAccent(mode) {
  const current = getCustomAccent(mode) || DEFAULT_ACCENT[mode];
  openColorPicker({ name: `${mode} mode accent`, color: current }, (color) => {
    setCustomAccent(mode, color || null);
    if (getActiveTheme() === mode) applyActiveTheme();
    refreshAccentSwatches();
  });
}
$("#accent-dark-btn").onclick = () => pickAccent("dark");
$("#accent-light-btn").onclick = () => pickAccent("light");
$("#accent-reset").onclick = () => {
  setCustomAccent("dark", null);
  setCustomAccent("light", null);
  if (getActiveTheme() === "dark" || getActiveTheme() === "light") applyActiveTheme();
  refreshAccentSwatches();
  toast("Accent colors reset to default");
};

function showSearchHistoryViewer() {
  document.querySelector("#history-viewer-overlay")?.remove();
  const hist = getSearchHistory();
  const overlay = el("div", "modal-overlay");
  overlay.id = "history-viewer-overlay";
  const rows = hist.length
    ? hist.map((h) => `<div class="hv-row"><span class="hv-text">${esc(h)}</span><span class="hv-del" data-q="${esc(h)}" title="Remove">✕</span></div>`).join("")
    : `<div class="hv-empty">No search history yet.</div>`;
  overlay.innerHTML = `
    <div class="modal-box hv-box">
      <div class="hv-head"><strong>Search history</strong><button class="hv-close">✕</button></div>
      <div class="hv-list">${rows}</div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector(".hv-close").onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.querySelectorAll(".hv-text").forEach((t) => {
    t.onclick = () => {
      close();
      $("#settings-overlay").classList.add("hidden");
      selectView({ type: "search" });
      $("#search-input").value = t.textContent;
      runSearch();
    };
  });
  overlay.querySelectorAll(".hv-del").forEach((d) => {
    d.onclick = (e) => {
      e.stopPropagation();
      const next = getSearchHistory().filter((x) => x !== d.dataset.q);
      try { localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next)); } catch {}
      showSearchHistoryViewer(); // refresh
    };
  });
}
$("#swap-panels-setting").onchange = (e) => {
  const on = e.target.checked;
  try { localStorage.setItem("swapPanels", on ? "1" : "0"); } catch {}
  applyPanelSwap(on);
};
function applyFeedVisibility(show) {
  const btn = document.querySelector('[data-view="feed"]');
  if (btn) btn.style.display = show ? "" : "none";
  if (!show && state.view.type === "feed") selectView({ type: "search" });
}

$("#history-toggle-setting").onchange = async (e) => {
  const on = e.target.checked;
  state.historyEnabled = on;
  try { await invoke("set_history_enabled", { enabled: on }); } catch {}
  applyHistoryVisibility(on);
};

// Font size + family controls
$("#font-smaller").onclick = () => setFontScale(fontScale - FONT_STEP);
$("#font-larger").onclick = () => setFontScale(fontScale + FONT_STEP);
$("#font-family-select").onchange = (e) => {
  fontFamily = e.target.value;
  applyAppearance();
  persistAppearance();
};
function applyHistoryVisibility(show) {
  const btn = document.querySelector('[data-view="history"]');
  if (btn) btn.style.display = show ? "" : "none";
  if (!show && state.view.type === "history") selectView({ type: "search" });
}

$("#del-collection-pdfs").onclick = async () => {
  const cid = $("#pdf-del-collection").value;
  if (!cid) { toast("No collection selected"); return; }
  const name = state.collections.find((c) => c.id === cid)?.name || "collection";
  const ok = await window.__TAURI__.dialog.confirm(
    `Delete downloaded PDFs for all papers in "${name}"? Library entries stay; only the PDF files are removed.`,
    { title: "Delete PDFs", kind: "warning" });
  if (!ok) return;
  const n = await invoke("delete_pdfs_in_collection", { collectionId: cid });
  await loadLibrary();
  const used = await invoke("pdf_storage_used");
  $("#pdf-storage").textContent = fmtBytes(used);
  toast(`Deleted ${n} PDF${n === 1 ? "" : "s"}`);
};

$("#del-all-pdfs").onclick = async () => {
  const ok = await window.__TAURI__.dialog.confirm(
    "Delete ALL downloaded PDFs from the library? This removes only the PDF files — your saved papers, notes, and collections remain, and you can re-download anytime.",
    { title: "Delete all PDFs", kind: "warning" });
  if (!ok) return;
  const n = await invoke("delete_all_pdfs");
  await loadLibrary();
  $("#pdf-storage").textContent = fmtBytes(0);
  toast(`Deleted ${n} PDF${n === 1 ? "" : "s"}`);
};

// Usage timer: count active time, flush every 30s and on blur/unload.
let usageAccum = 0;
let lastTick = Date.now();
let windowActive = true;
window.addEventListener("focus", () => { windowActive = true; lastTick = Date.now(); });
window.addEventListener("blur", () => { flushUsage(); windowActive = false; });
function tickUsage() {
  if (windowActive) {
    const now = Date.now();
    usageAccum += (now - lastTick) / 1000;
    lastTick = now;
  }
}
async function flushUsage() {
  tickUsage();
  const secs = Math.floor(usageAccum);
  if (secs > 0) {
    usageAccum -= secs;
    try { await invoke("record_usage", { seconds: secs }); } catch {}
  }
}
setInterval(flushUsage, 30000);
window.addEventListener("beforeunload", flushUsage);

// ---------- Collapsible detail pane ----------
function setDetailCollapsed(collapsed) {
  $("#detail-pane").classList.toggle("collapsed", collapsed);
  $("#resizer-2").classList.toggle("hidden", collapsed);
  try { localStorage.setItem("detailCollapsed", collapsed ? "1" : "0"); } catch {}
}
$("#collapse-detail").onclick = () => {
  const collapsed = $("#detail-pane").classList.contains("collapsed");
  setDetailCollapsed(!collapsed);
};

try {
  if (localStorage.getItem("detailCollapsed") === "1") setDetailCollapsed(true);
} catch {}

// ---------- Init ----------
initTheme();
initResizers();
try { state.density = localStorage.getItem("density") || "normal"; } catch {}
try { applyGraphVisibility(localStorage.getItem("showGraph") === "1"); } catch {}
try { applyFeedVisibility(localStorage.getItem("showFeed") !== "0"); } catch {}
try { applyPanelSwap(localStorage.getItem("swapPanels") === "1"); } catch {}
initFeedCategories();
selectView({ type: "search" });
checkFirstRun();
loadLibrary().catch((e) => toast("Failed to load library: " + e));
