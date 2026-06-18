// fastmd-explorer — vanilla JS, no build step

// ---- Mermaid init --------------------------------------------------------
const MERMAID_BASE = { startOnLoad: false, securityLevel: 'loose', maxEdges: 2000, maxTextSize: 200000 };
mermaid.initialize({ ...MERMAID_BASE, theme: 'default' });

// 画面表示用の Mermaid テーマ (ダークテーマ時は dark)。
// 印刷/PDF は常に default (白地・濃い文字) で描き直すため別管理する。
function mermaidTheme() { return state.theme === 'dark' ? 'dark' : 'default'; }

// ---- State ---------------------------------------------------------------
const state = {
  currentRoot:    null,
  mode:           'folder',  // 'folder' | 'url' — 2 つの独立ワークスペース
  currentUrl:     null,      // URLモードで現在開いている md の URL
  folderHistory:  [],        // フォルダ履歴 (モード切替時に <select> を入替える元データ)
  urlHistory:     [],        // URL履歴 (同上)
  tags:           {},    // { [relativePath]: { tags, flagged, note } }
  theme:          'light',
  searchQuery:    '',
  expandedDirs:   new Set(),
  filterTags:     new Set(),  // active tag filters
  filterFlagged:  false,

  // Tabs
  tabs:           [],    // [{ id, path, relativePath, name }]
  activeTabPath:  null,
  tabDirty:       {},    // { [path]: boolean }
  tabEditorText:  {},    // { [path]: string } — saved when switching away in edit mode
  tabNavStacks:   {},    // { [tab.id]: { stack: [{path,name,relativePath},...], idx: number } }
  isEditing:      false,
  showImages:     localStorage.getItem('showImages') === '1',
  // 印刷時に改ページする見出しレベル ('0'=しない, '1'..'6'=見出しN)。既定は見出し1
  printPageBreak: localStorage.getItem('printPageBreak') ?? '1',
};

// ---- DOM refs ------------------------------------------------------------
const $ = (id) => document.getElementById(id);

const folderInput    = $('folder-input');
const btnBrowse      = $('btn-browse');
const btnOpen        = $('btn-open');
const historySelect  = $('history-select');
const btnFontDown    = $('btn-font-down');
const btnFontUp      = $('btn-font-up');
const fontSizeLabel  = $('font-size-label');
const btnRefresh     = $('btn-refresh');
const btnTreeRefresh = $('btn-tree-refresh');
const btnLinkgraph   = $('btn-linkgraph');
const btnCombinedPdf = $('btn-combined-pdf');
const linkgraphOverlay = $('linkgraph-overlay');
const lgGraph        = $('lg-graph');
const lgStats        = $('lg-stats');
const lgClose        = $('lg-close');
const lgZoomSlider   = $('lg-zoom-slider');
const lgZoomIn       = $('lg-zoom-in');
const lgZoomOut      = $('lg-zoom-out');
const lgZoomFit      = $('lg-zoom-fit');
const lgSavePng      = $('lg-save-png');
const combinedOverlay = $('combined-overlay');
const combinedContent = $('combined-content');
const cbStats        = $('cb-stats');
const cbPrint        = $('cb-print');
const cbClose        = $('cb-close');
const btnTheme       = $('btn-theme');
const btnSettings    = $('btn-settings');
const settingsPanel  = $('settings-panel');
const btnSettingsClose = $('btn-settings-close');
const settingPrintPb = $('setting-print-pb');
const statusPort     = $('status-port');
const statusFolder   = $('status-folder');
const statusPid      = $('status-pid');
const statusUptime   = $('status-uptime');
const tagFilterBar   = $('tag-filter-bar');
const warningBar     = $('warning-bar');
const fileTree       = $('file-tree');
const sidebarFooter  = $('sidebar-footer');
const recentPanel    = $('recent-files-panel');
const searchInput    = $('search-input');
const btnFulltext    = $('btn-fulltext');
const btnShowImages  = $('btn-show-images');
const fulltextPanel  = $('fulltext-panel');
const fulltextInput  = $('fulltext-input');
const fulltextResults = $('fulltext-results');
const emptyState     = $('empty-state');
const fileView       = $('file-view');
const imageView      = $('image-view');
const imageBreadcrumb = $('image-breadcrumb');
const imageDisplay   = $('image-display');
const imageStage     = $('image-stage');
const tabBar         = $('tab-bar');
const fileBreadcrumb = $('file-breadcrumb');
const btnFlag        = $('btn-flag');
const btnPrint       = $('btn-print');
const btnEdit        = $('btn-edit');
const btnSave        = $('btn-save');
const btnDiscard     = $('btn-discard');
const tagsList       = $('tags-list');
const tagInput       = $('tag-input');
const noteInput      = $('note-input');
const fileInfoBar    = $('file-info-bar');
const backlinksBar   = $('backlinks-bar');
const findBar        = $('find-bar');
const findInput      = $('find-input');
const findCount      = $('find-count');
const findPrev       = $('find-prev');
const findNext       = $('find-next');
const findClose      = $('find-close');
const previewPanel   = $('preview-panel');
const previewContent = $('preview-content');
const outlinePanel   = $('outline-panel');
const editArea       = $('edit-area');
const editorPanel    = $('editor-panel');
const editor         = $('editor');
const hljsTheme      = $('hljs-theme');
const sidebar        = $('sidebar');
const resizeHandle   = $('resize-handle');
const outlineResize  = $('outline-resize-handle');
const btnFullview    = $('btn-fullview');
const btnNavBack     = $('btn-nav-back');
const btnNavFwd      = $('btn-nav-fwd');
const modeToggle     = $('mode-toggle');
const urlHistoryWrap = $('url-history-wrap');
const urlHistoryList = $('url-history-list');

// ---- API helpers ---------------------------------------------------------
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  let json;
  try { json = await res.json(); } catch { json = {}; }
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}
const get   = (p)    => api('GET',    p);
const post  = (p, b) => api('POST',   p, b);
const put   = (p, b) => api('PUT',    p, b);
const patch = (p, b) => api('PATCH',  p, b);
const del   = (p, b) => api('DELETE', p, b);

// ---- Init ----------------------------------------------------------------
async function init() {
  try {
    const config = await get('/api/config');
    // localStorage のユーザー選択を最優先、無ければ config の既定値
    state.theme = localStorage.getItem('theme') ?? config.theme ?? 'light';
    applyTheme(state.theme);
    initFontSize();
    state.folderHistory = config.history ?? [];
    state.urlHistory    = config.urlHistory ?? [];

    if (config.lastMode === 'url' && config.lastUrl) {
      // 前回 URLモードだった → URLモードで起動し、最後の URL を開く
      applyModeUI('url');
      populateHistory(state.urlHistory);
      renderUrlHistory(state.urlHistory);
      folderInput.value = config.lastUrl;
      await openUrl(config.lastUrl);
    } else {
      applyModeUI('folder');
      populateHistory(state.folderHistory);
      if (config.currentRoot) {
        state.currentRoot = config.currentRoot;
        folderInput.value = config.currentRoot;
        await refreshTree();
      }
    }
  } catch (err) {
    showWarning(`初期化エラー: ${err.message}`, 'error');
  }

  bindEvents();
}

// ---- Font size -----------------------------------------------------------
const FONT_MIN = 12, FONT_MAX = 24, FONT_DEFAULT = 16, FONT_STEP = 1;

function applyFontSize(size) {
  document.documentElement.style.setProperty('--preview-font-size', `${size}px`);
  fontSizeLabel.textContent = `${size}px`;
  fontSizeLabel.classList.toggle('modified', size !== FONT_DEFAULT);
  localStorage.setItem('previewFontSize', size);
}

function initFontSize() {
  const saved = parseInt(localStorage.getItem('previewFontSize'), 10);
  applyFontSize(saved >= FONT_MIN && saved <= FONT_MAX ? saved : FONT_DEFAULT);
}

// ---- Theme ---------------------------------------------------------------
function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  hljsTheme.href = theme === 'dark' ? '/vendor/hljs-dark.css' : '/vendor/hljs-light.css';
  mermaid.initialize({ ...MERMAID_BASE, theme: theme === 'dark' ? 'dark' : 'default' });
  localStorage.setItem('theme', theme); // ユーザーの選択を永続化 (再起動後も維持)
}

// ---- Full view mode -------------------------------------------------------
function toggleFullview() {
  const on = document.body.classList.toggle('fullview');
  btnFullview.textContent = on ? '⤡' : '⤢';
  btnFullview.title = on ? 'フル表示を終了 (Ctrl+Shift+F)' : 'フル表示 (Ctrl+Shift+F)';
}

// ---- Folder selection ----------------------------------------------------
async function browseFolder() {
  btnBrowse.disabled = true;
  btnBrowse.textContent = '⏳';
  try {
    const { path } = await post('/api/folder/pick');
    if (path) {
      folderInput.value = path;
      await openFolder(path);
    }
  } catch (err) {
    showWarning(`フォルダ選択エラー: ${err.message}`, 'error');
  } finally {
    btnBrowse.disabled = false;
    btnBrowse.textContent = '📂';
  }
}

async function openFolder(rawPath) {
  const path = rawPath.trim();
  if (!path) return;
  showWarning('', '');
  try {
    // Save current workspace (folder or url) before switching
    saveTabState(workspaceKey());
    applyModeUI('folder'); // URLモードから来た場合は表示をフォルダへ戻す

    const res = await post('/api/folder', { path });
    state.currentRoot = res.path;
    state.currentUrl = null;
    state.tags = {};
    state.tabDirty = {};
    state.tabEditorText = {};
    state.isEditing = false;
    state.filterTags.clear();
    state.filterFlagged = false;
    state.searchQuery = '';
    searchInput.value = '';
    folderInput.value = res.path;
    state.folderHistory = res.config.history ?? state.folderHistory;
    state.urlHistory    = res.config.urlHistory ?? state.urlHistory;
    populateHistory(state.folderHistory);

    // Restore saved tab state for this folder
    const saved = loadTabState(res.path);
    state.tabNavStacks = {};
    state.tabs = (saved?.tabs ?? []).map((t) => {
      const tab = { id: ++_tabIdSeq, ...t };
      state.tabNavStacks[tab.id] = { stack: [_navEntry(tab)], idx: 0 };
      return tab;
    });
    state.activeTabPath = saved?.activeTabPath ?? null;
    renderTabBar();

    if (res.warnings?.length) showWarning(res.warnings.join('<br>'), 'warn');

    await refreshTree();

    if (state.activeTabPath) {
      const tab = activeTab();
      if (tab) await renderFileContent(tab);
      else showEmptyState();
    } else {
      showEmptyState();
    }
  } catch (err) {
    showWarning(`エラー: ${err.message}`, 'error');
  }
}

// ---- URL mode ------------------------------------------------------------
// フォルダモードと URLモードを 2 つの独立ワークスペースとして扱う。
// 入力欄・履歴 <select>・サイドバー・開いているタブがモードごとに切替わる。

/** 現ワークスペースの保存キー (フォルダ=ルートパス / URL='__url__')。 */
function workspaceKey() {
  if (state.mode === 'url') return '__url__';
  return state.currentRoot || null;
}

/** モードに応じた UI (body クラス・トグル・placeholder) を適用。状態のみで再オープンはしない。 */
function applyModeUI(mode) {
  state.mode = mode;
  document.body.classList.toggle('mode-url', mode === 'url');
  modeToggle.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  folderInput.placeholder = mode === 'url'
    ? 'md ファイルの URL を入力 (Enter で開く)...'
    : 'フォルダパスを入力 (Enter で開く)...';
}

/** 退避済みワークスペースのタブ群を復元する (openFolder のタブ復元と同型)。 */
function restoreWorkspaceTabs(saved) {
  state.tabDirty = {};
  state.tabEditorText = {};
  state.tabNavStacks = {};
  state.isEditing = false;
  state.tabs = (saved?.tabs ?? []).map((t) => {
    const tab = { id: ++_tabIdSeq, ...t };
    state.tabNavStacks[tab.id] = { stack: [_navEntry(tab)], idx: 0 };
    return tab;
  });
  state.activeTabPath = saved?.activeTabPath ?? null;
  renderTabBar();
}

/** トグルボタン: 現ワークスペースを退避し、もう一方を復元する (再オープンはしない)。 */
async function switchMode(newMode) {
  if (newMode === state.mode) return;
  saveTabState(workspaceKey());
  applyModeUI(newMode);

  if (newMode === 'url') {
    populateHistory(state.urlHistory);
    renderUrlHistory(state.urlHistory);
    folderInput.value = state.currentUrl ?? '';
    restoreWorkspaceTabs(loadTabState('__url__'));
  } else {
    populateHistory(state.folderHistory);
    folderInput.value = state.currentRoot ?? '';
    restoreWorkspaceTabs(loadTabState(state.currentRoot || null));
    if (state.currentRoot) await refreshTree();
    else fileTree.innerHTML = '';
  }

  updateTreeActiveState();
  if (state.activeTabPath && activeTab()) await renderFileContent(activeTab());
  else showEmptyState();
}

/** 入力値を判定して URL/フォルダのどちらで開くか振り分ける。 */
function openInput(value) {
  const v = (value ?? '').trim();
  if (!v) return;
  if (/^https?:\/\//i.test(v)) openUrl(v);
  else openFolder(v);
}

/** URL からファイル名相当 (末尾セグメント or ホスト名) を取り出す。 */
function urlFileName(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return decodeURIComponent(last || u.hostname);
  } catch {
    return url.split(/[?#]/)[0].split('/').filter(Boolean).pop() || url;
  }
}

/** リモート md を開く (openFolder と対称)。フォルダモードからの遷移も処理する。 */
async function openUrl(rawUrl) {
  const url = (rawUrl ?? '').trim();
  if (!url) return;
  showWarning('', '');

  // フォルダモードから来たら現ワークスペースを退避し URLワークスペースへ
  if (state.mode !== 'url') {
    saveTabState(workspaceKey());
    applyModeUI('url');
    restoreWorkspaceTabs(loadTabState('__url__'));
  }

  try {
    const res = await post('/api/url', { url });
    state.currentUrl = res.url;
    state.folderHistory = res.config.history ?? state.folderHistory;
    state.urlHistory    = res.config.urlHistory ?? state.urlHistory;
    populateHistory(state.urlHistory);
    renderUrlHistory(state.urlHistory);
    folderInput.value = res.url;

    // 既に開いていれば切替、無ければ新規タブ
    const existing = state.tabs.find((t) => t.path === res.url);
    if (existing) { await switchToTab(res.url); return; }

    const tab = { id: ++_tabIdSeq, path: res.url, relativePath: res.url, name: urlFileName(res.url), isUrl: true };
    state.tabNavStacks[tab.id] = { stack: [_navEntry(tab)], idx: 0 };
    state.tabs.push(tab);
    state.activeTabPath = res.url;
    state.isEditing = false;
    renderTabBar();
    await renderFileContent(tab);
  } catch (err) {
    showWarning(`エラー: ${err.message}`, 'error');
  }
}

/** URLモードのサイドバー: URL履歴をクリック可能な一覧で表示する。 */
function renderUrlHistory(list) {
  urlHistoryList.innerHTML = '';
  if (!list || !list.length) {
    const empty = document.createElement('div');
    empty.className = 'url-history-empty';
    empty.textContent = 'URL履歴はまだありません';
    urlHistoryList.appendChild(empty);
    return;
  }
  list.forEach((u) => {
    const item = document.createElement('div');
    item.className = 'url-history-item' + (u === state.currentUrl ? ' active' : '');
    item.textContent = urlFileName(u);
    item.title = u;
    item.addEventListener('click', () => openUrl(u));
    urlHistoryList.appendChild(item);
  });
}

/** URLモードのプレビュー内リンク処理 (サーバで絶対URL化済み)。 */
function fixRemoteLinks() {
  previewContent.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#')) return;          // ページ内アンカーは既定動作
    if (!/^https?:\/\//i.test(href)) return;            // 解決不能な相対は触らない
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (/\.(md|markdown|mdown|mkd)(?:[?#].*)?$/i.test(href)) {
        navigateInTab({ path: href, relativePath: href, name: urlFileName(href), isUrl: true });
      } else {
        window.open(href, '_blank', 'noreferrer'); // 外部リンクは別タブ (アプリを離脱させない)
      }
    });
  });
}

/** URLモードのファイル情報バー (Last-Modified / 文字数 / 見出し数)。 */
function updateUrlFileInfo(lastModified, charCount) {
  const headings = previewContent.querySelectorAll('h1,h2,h3,h4').length;
  let datePart = '';
  if (lastModified) {
    const d = new Date(lastModified);
    if (!isNaN(d.getTime())) {
      datePart = `更新: ${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ` +
                 `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}　`;
    }
  }
  fileInfoBar.textContent = `${datePart}文字数: ${charCount ?? '—'}　見出し: ${headings}`;
}

// ---- Tab state persistence -----------------------------------------------

function saveTabState(folderPath) {
  if (!folderPath) return;
  const data = {
    tabs: state.tabs.map(({ path, relativePath, name, isUrl }) =>
      ({ path, relativePath, name, ...(isUrl ? { isUrl: true } : {}) })),
    activeTabPath: state.activeTabPath,
  };
  try { localStorage.setItem('tabState:' + folderPath, JSON.stringify(data)); } catch { /* quota */ }
}

function loadTabState(folderPath) {
  try {
    const raw = localStorage.getItem('tabState:' + folderPath);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function populateHistory(history) {
  historySelect.innerHTML = '<option value="">履歴 ▾</option>';
  history.forEach((h) => {
    const opt = document.createElement('option');
    opt.value = h;
    opt.textContent = h.length > 60 ? '…' + h.slice(-57) : h;
    opt.title = h;
    historySelect.appendChild(opt);
  });
}

// ---- Recent files --------------------------------------------------------
const RECENT_KEY = 'recentFiles';
const RECENT_MAX = 10;

function loadRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY)) ?? []; } catch { return []; }
}

function pushRecent(file) {
  if (state.mode === 'url' || file.isUrl) return; // URLモードは最近ファイルを記録しない
  const list = loadRecent().filter((r) => r.path !== file.path);
  list.unshift({ path: file.path, relativePath: file.relativePath, name: file.name, root: state.currentRoot });
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  renderRecentPanel();
}

function renderRecentPanel() {
  const list = loadRecent().filter((r) => r.root === state.currentRoot);
  recentPanel.innerHTML = '';
  if (!list.length) return;

  const header = document.createElement('div');
  header.className = 'recent-header';
  const collapsed = localStorage.getItem('recentCollapsed') === '1';
  header.innerHTML = `<span>最近開いたファイル</span><span class="recent-toggle">${collapsed ? '▶' : '▼'}</span>`;
  header.addEventListener('click', () => {
    const isNowCollapsed = localStorage.getItem('recentCollapsed') === '1';
    localStorage.setItem('recentCollapsed', isNowCollapsed ? '0' : '1');
    renderRecentPanel();
  });
  recentPanel.appendChild(header);

  if (!collapsed) {
    const ul = document.createElement('div');
    ul.className = 'recent-list';
    list.forEach((r) => {
      const item = document.createElement('div');
      item.className = 'recent-item';
      item.textContent = r.relativePath ?? r.name;
      item.title = r.relativePath ?? r.name;
      item.addEventListener('click', () => openFile(r));
      ul.appendChild(item);
    });
    recentPanel.appendChild(ul);
  }
}

// ---- File tree -----------------------------------------------------------
async function refreshTree() {
  fileTree.innerHTML = '<div class="loading">読み込み中...</div>';
  sidebarFooter.textContent = 'スキャン中...';
  const t0 = performance.now();
  try {
    const t1 = performance.now();
    const data = await get('/api/files');
    const t2 = performance.now();
    console.log(`[perf] /api/files: ${(t2 - t1).toFixed(0)}ms  mdFiles=${data.fileCount}`);

    state.tags = data.tags ?? {};

    if (data.warnings?.length) {
      const extra = data.warnings.join('<br>');
      showWarning(warningBar.innerHTML ? warningBar.innerHTML + '<br>' + extra : extra, 'warn');
    }

    if (!data.tree) {
      fileTree.innerHTML = '<div class="no-files">Markdownファイルが見つかりません</div>';
      sidebarFooter.textContent = '';
      return;
    }

    // Reconstruct absolute `path` from currentRoot + name (stripped server-side to reduce JSON size)
    const sep = state.currentRoot?.includes('\\') ? '\\' : '/';
    function restorePaths(node) {
      const rel = node.relativePath ?? node.name;
      node.path = (rel === '.' || rel === '') ? state.currentRoot : state.currentRoot + sep + rel.replace(/\//g, sep);
      if (node.children) node.children.forEach(restorePaths);
    }
    restorePaths(data.tree);

    renderTreeNode(data.tree, fileTree, false);
    const t3 = performance.now();
    console.log(`[perf] renderTree: ${(t3 - t2).toFixed(0)}ms`);

    renderTagFilterBar();
    applySearch(state.searchQuery);
    console.log(`[perf] refreshTree total: ${(performance.now() - t0).toFixed(0)}ms`);
  } catch (err) {
    fileTree.innerHTML = `<div class="error-msg">エラー: ${err.message}</div>`;
  }
}

function countFiles(node) {
  if (node.type === 'file') return 1;
  return (node.children ?? []).reduce((s, c) => s + countFiles(c), 0);
}

function renderTreeNode(node, container, isRoot = false) {
  container.innerHTML = '';
  if (node.type === 'file') { container.appendChild(makeFileEl(node)); return; }

  // Root folder row
  if (state.currentRoot) {
    const rootName = state.currentRoot.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
    const rootRow = document.createElement('div');
    rootRow.className = 'tree-dir tree-root-row';
    rootRow.innerHTML = `<span class="dir-arrow">📂</span><span class="dir-name">${escHtml(rootName)}</span>`;
    rootRow.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e, [
        { label: '新規ファイル', action: () => fsCreateFile(state.currentRoot) },
        { label: '新規フォルダ', action: () => fsCreateFolder(state.currentRoot) },
      ]);
    });
    container.appendChild(rootRow);
  }

  const ul = document.createElement('ul');
  ul.className = 'tree-list';
  renderChildren(node.children ?? [], ul, isRoot);
  container.appendChild(ul);
}

function renderChildren(children, ul, forceExpand = false) {
  children.forEach((child) => {
    const li = document.createElement('li');
    if (child.type === 'dir') {
      li.appendChild(makeDirEl(child, forceExpand));
    } else if (child.type === 'image') {
      if (state.showImages) li.appendChild(makeImageEl(child));
      else return; // skip
    } else {
      li.appendChild(makeFileEl(child));
    }
    ul.appendChild(li);
  });
}

function makeImageEl(file) {
  const div = document.createElement('div');
  div.className = 'tree-image';
  div.dataset.path = file.path;

  const thumb = document.createElement('img');
  thumb.className = 'tree-image-thumb';
  thumb.src = `/api/image?path=${encodeURIComponent(file.path)}`;
  thumb.alt = file.name;
  thumb.loading = 'lazy';
  thumb.addEventListener('click', () => openImageView(file));

  const label = document.createElement('span');
  label.className = 'tree-image-name';
  label.textContent = file.name;
  label.title = file.name;

  label.addEventListener('click', () => openImageView(file));
  div.appendChild(thumb);
  div.appendChild(label);
  return div;
}

function makeDirEl(dir, forceExpand = false) {
  const id = dir.path;
  const expanded = forceExpand || state.expandedDirs.has(id);

  const frag = document.createDocumentFragment();

  const row = document.createElement('div');
  row.className = 'tree-dir';
  const badges = (dir.hasMd ? '<span class="dir-badge dir-badge-md">md</span>' : '')
               + (dir.hasImages ? '<span class="dir-badge dir-badge-img">img</span>' : '');
  row.innerHTML = `<span class="dir-arrow">${expanded ? '▾' : '▸'}</span><span class="dir-name">${escHtml(dir.name)}</span>${badges}`;

  const childUl = document.createElement('ul');
  childUl.className = 'tree-list tree-children';
  childUl.dataset.dirId = id;
  childUl._dirChildren = dir.children ?? [];
  childUl.style.display = expanded ? '' : 'none';
  if (expanded) renderChildren(dir.children ?? [], childUl);

  row.addEventListener('click', () => {
    const open = childUl.style.display !== 'none';
    if (open) {
      childUl.style.display = 'none';
      row.querySelector('.dir-arrow').textContent = '▸';
      state.expandedDirs.delete(id);
    } else {
      childUl.style.display = '';
      row.querySelector('.dir-arrow').textContent = '▾';
      state.expandedDirs.add(id);
      if (childUl.childElementCount === 0) renderChildren(dir.children ?? [], childUl);
    }
  });

  row.addEventListener('contextmenu', (e) => {
    e.stopPropagation();
    showContextMenu(e, [
      { label: '新規ファイル',   action: () => fsCreateFile(dir.path) },
      { label: '新規フォルダ',   action: () => fsCreateFolder(dir.path) },
      { label: 'リネーム',       action: () => fsRename(dir.path, false, row.querySelector('.dir-name')) },
      { label: '削除',           action: () => fsDelete(dir.path, false), danger: true },
    ]);
  });

  frag.appendChild(row);
  frag.appendChild(childUl);
  return frag;
}

function makeFileEl(file) {
  const meta = state.tags[file.relativePath] ?? {};
  const isActive = state.activeTabPath === file.path;

  const div = document.createElement('div');
  div.className = 'tree-file' + (isActive ? ' active' : '');
  div.dataset.path = file.path;
  div.dataset.rel  = file.relativePath;

  const name = document.createElement('span');
  name.className = 'file-name';
  name.textContent = file.name;

  const right = document.createElement('span');
  right.className = 'file-meta';
  if (meta.flagged) {
    const s = document.createElement('span');
    s.className = 'flag-star flagged';
    s.textContent = '★';
    right.appendChild(s);
  }
  (meta.tags ?? []).forEach((tag) => right.appendChild(miniChip(tag)));

  div.appendChild(name);
  div.appendChild(right);
  div.addEventListener('click', () => openFile(file));
  div.addEventListener('contextmenu', (e) => {
    e.stopPropagation();
    showContextMenu(e, [
      { label: 'リネーム', action: () => fsRename(file.path, true, div.querySelector('.file-name')) },
      { label: '削除',     action: () => fsDelete(file.path, true), danger: true },
    ]);
  });
  return div;
}

function miniChip(tag) {
  const s = document.createElement('span');
  s.className = 'tag-chip';
  s.style.setProperty('--tag-hue', tagHue(tag));
  s.textContent = tag;
  return s;
}

// ---- Tabs ----------------------------------------------------------------

let _tabIdSeq = 0;

function _navEntry(file) {
  return { path: file.path, name: file.name, relativePath: file.relativePath };
}

function _initTabNav(tab) {
  if (!tab.id) tab.id = ++_tabIdSeq;
  if (!state.tabNavStacks[tab.id]) {
    state.tabNavStacks[tab.id] = { stack: [_navEntry(tab)], idx: 0 };
  }
}

function updateNavButtons() {
  const tab = activeTab();
  const nav = tab ? state.tabNavStacks[tab.id] : null;
  btnNavBack.disabled = !nav || nav.idx <= 0;
  btnNavFwd.disabled  = !nav || nav.idx >= nav.stack.length - 1;
}

function activeTab() {
  return state.tabs.find((t) => t.path === state.activeTabPath) ?? null;
}

function renderTabBar() {
  if (state.tabs.length === 0) {
    tabBar.classList.add('hidden');
    tabBar.innerHTML = '';
    return;
  }
  tabBar.classList.remove('hidden');
  tabBar.innerHTML = '';

  state.tabs.forEach((tab) => {
    const el = document.createElement('div');
    el.className = 'tab-item' +
      (tab.path === state.activeTabPath ? ' active' : '') +
      (state.tabDirty[tab.path] ? ' dirty' : '');
    el.title = tab.relativePath;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'tab-name';
    nameSpan.textContent = tab.name;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.textContent = '×';
    closeBtn.title = '閉じる';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab.path);
    });

    el.appendChild(nameSpan);
    el.appendChild(closeBtn);
    el.addEventListener('click', () => switchToTab(tab.path));
    tabBar.appendChild(el);
  });

  // Close-all button (pinned to right)
  const closeAll = document.createElement('button');
  closeAll.className = 'tab-close-all';
  closeAll.textContent = '全て閉じる';
  closeAll.title = '全タブを閉じる';
  closeAll.addEventListener('click', closeAllTabs);
  tabBar.appendChild(closeAll);

  // Scroll active tab into view
  const activeEl = tabBar.querySelector('.tab-item.active');
  activeEl?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

async function switchToTab(path, highlight = null) {
  if (path === state.activeTabPath && !highlight) return;

  // If currently editing and dirty, save editor text before switching
  if (state.isEditing && state.activeTabPath) {
    state.tabEditorText[state.activeTabPath] = editor.value;
  }

  state.activeTabPath = path;
  state.isEditing = false;

  renderTabBar();
  updateTreeActiveState();
  updateNavButtons();

  const tab = state.tabs.find((t) => t.path === path);
  if (!tab) return;
  await renderFileContent(tab, highlight);
}

async function closeTab(path) {
  const idx = state.tabs.findIndex((t) => t.path === path);
  if (idx === -1) return;

  if (state.tabDirty[path]) {
    if (!confirm(`"${state.tabs[idx].name}" に未保存の変更があります。閉じますか？`)) return;
  }

  const closedTab = state.tabs[idx];
  if (closedTab?.id) delete state.tabNavStacks[closedTab.id];
  state.tabs.splice(idx, 1);
  delete state.tabDirty[path];
  delete state.tabEditorText[path];

  if (state.activeTabPath === path) {
    state.isEditing = false;
    // Switch to adjacent tab
    const next = state.tabs[idx] ?? state.tabs[idx - 1] ?? null;
    state.activeTabPath = next?.path ?? null;
  }

  renderTabBar();
  updateTreeActiveState();

  if (state.activeTabPath) {
    const tab = state.tabs.find((t) => t.path === state.activeTabPath);
    if (tab) await renderFileContent(tab);
  } else {
    showEmptyState();
  }
}

function closeAllTabs() {
  const hasDirty = state.tabs.some((t) => state.tabDirty[t.path]);
  if (hasDirty && !confirm('未保存の変更があるタブがあります。全て閉じますか？')) return;
  state.tabs = [];
  state.activeTabPath = null;
  state.tabDirty = {};
  state.tabEditorText = {};
  state.tabNavStacks = {};
  state.isEditing = false;
  renderTabBar();
  updateTreeActiveState();
  showEmptyState();
}

// ---- Open file -----------------------------------------------------------
async function openFile(file) {
  // Already open in a tab?
  const existing = state.tabs.find((t) => t.path === file.path);
  if (existing) {
    await switchToTab(file.path, file.highlight ?? null);
    return;
  }

  // If currently editing and dirty, offer to stay
  if (state.isEditing && state.activeTabPath && state.tabDirty[state.activeTabPath]) {
    state.tabEditorText[state.activeTabPath] = editor.value;
  }

  // Add new tab
  const tab = { id: ++_tabIdSeq, path: file.path, relativePath: file.relativePath, name: file.name };
  state.tabNavStacks[tab.id] = { stack: [_navEntry(file)], idx: 0 };
  state.tabs.push(tab);
  state.activeTabPath = file.path;
  state.isEditing = false;
  pushRecent(file);

  renderTabBar();
  updateTreeActiveState();
  await renderFileContent(tab, file.highlight ?? null);
}

async function renderFileContent(tab, highlight = null) {
  showFileView();
  exitEditModeUI(); // reset edit buttons

  updateFileHeader(tab);

  // URLモード: 読み取り専用。タグ/メモ/被参照は使わず /api/url/preview で取得する。
  if (tab.isUrl) {
    backlinksBar.innerHTML = '';
    backlinksBar.classList.add('hidden');
    outlinePanel.innerHTML = '';
    closeFindBar();
    previewContent.innerHTML = '<div class="loading">取得中...</div>';
    fileInfoBar.textContent = '';
    try {
      const { html, charCount, lastModified } = await get(`/api/url/preview?url=${encodeURIComponent(tab.path)}`);
      previewContent.innerHTML = html;
      previewPanel.scrollTop = 0;
      await renderMermaid();
      fixRemoteLinks();
      addCopyButtons();
      addTableSort();
      if (highlight) highlightInPreview(highlight);
      updateUrlFileInfo(lastModified, charCount);
      updateOutline();
      updateNavButtons();
    } catch (err) {
      previewContent.innerHTML = `<div class="error-msg">エラー: ${escHtml(err.message)}</div>`;
    }
    return;
  }

  updateTagsBar(tab);
  updateNoteBar(tab);

  previewContent.innerHTML = '<div class="loading">レンダリング中...</div>';
  fileInfoBar.textContent = '';
  backlinksBar.innerHTML = '';
  backlinksBar.classList.add('hidden');
  outlinePanel.innerHTML = '';
  closeFindBar();

  try {
    const { html, mtime, charCount } = await get(`/api/preview?path=${encodeURIComponent(tab.path)}`);
    previewContent.innerHTML = html;
    previewPanel.scrollTop = 0;
    await renderMermaid();
    fixLocalLinks();
    addCopyButtons();
    addTableSort();
    if (highlight) highlightInPreview(highlight);
    updateFileInfo(mtime, charCount);
    updateOutline();
    updateBacklinks(tab.path);
    updateNavButtons();
  } catch (err) {
    previewContent.innerHTML = `<div class="error-msg">エラー: ${escHtml(err.message)}</div>`;
  }
}

function updateFileInfo(mtime, charCount) {
  if (!mtime) { fileInfoBar.textContent = ''; return; }
  const d = new Date(mtime);
  const date = `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  const headings = previewContent.querySelectorAll('h1,h2,h3,h4').length;
  fileInfoBar.textContent = `更新: ${date}　文字数: ${charCount ?? '—'}　見出し: ${headings}`;
}

async function updateBacklinks(filePath) {
  backlinksBar.innerHTML = '';
  backlinksBar.classList.add('hidden');
  if (!filePath) return;
  try {
    const { links } = await get(`/api/backlinks?path=${encodeURIComponent(filePath)}`);
    if (!links.length) return;
    backlinksBar.classList.remove('hidden');
    const header = document.createElement('span');
    header.className = 'bl-header';
    header.textContent = `被参照: ${links.length}件 → `;
    backlinksBar.appendChild(header);
    links.forEach((l, i) => {
      if (i > 0) { const sep = document.createElement('span'); sep.textContent = ' · '; backlinksBar.appendChild(sep); }
      const a = document.createElement('span');
      a.className = 'bl-link';
      a.textContent = l.name.replace(/\.md$/i, '');
      a.title = `${l.relativePath}  (行 ${l.lineNum}): ${l.text}`;
      a.addEventListener('click', () => openFile({ path: l.path, relativePath: l.relativePath, name: l.name }));
      backlinksBar.appendChild(a);
    });
  } catch { /* ignore */ }
}

function updateOutline() {
  outlinePanel.innerHTML = '';
  outlinePanel.classList.remove('collapsed');

  const headings = [...previewContent.querySelectorAll('h1,h2,h3,h4')];
  if (!headings.length) return;  // :empty CSS で自動的に非表示

  // 折り畳みストリップ（パネル全体の開閉）
  const strip = document.createElement('div');
  strip.className = 'outline-strip';
  const collapsed = localStorage.getItem('outlineCollapsed') === '1';
  outlinePanel.classList.toggle('collapsed', collapsed);
  strip.textContent = collapsed ? '▶' : '◀';
  strip.title = collapsed ? 'アウトラインを開く' : 'アウトラインを閉じる';
  strip.addEventListener('click', () => {
    outlinePanel.classList.toggle('collapsed');
    localStorage.setItem('outlineCollapsed', outlinePanel.classList.contains('collapsed') ? '1' : '0');
    strip.textContent = outlinePanel.classList.contains('collapsed') ? '▶' : '◀';
    strip.title = outlinePanel.classList.contains('collapsed') ? 'アウトラインを開く' : 'アウトラインを閉じる';
  });
  outlinePanel.appendChild(strip);

  // 見出し階層メタ情報
  const items = headings.map((h) => ({
    el: h,
    level: parseInt(h.tagName[1]),
  }));
  items.forEach((item, i) => {
    const next = items[i + 1];
    item.hasChildren = !!(next && next.level > item.level);
  });

  // 折り畳み状態（ファイルを開き直すたびにリセット）
  const foldedSet = new Set();

  const listWrap = document.createElement('div');
  listWrap.className = 'outline-list';
  outlinePanel.appendChild(listWrap);

  function render() {
    listWrap.innerHTML = '';
    let hideUntilLevel = null;
    items.forEach((item, i) => {
      if (hideUntilLevel !== null && item.level <= hideUntilLevel) {
        hideUntilLevel = null;
      }
      if (hideUntilLevel !== null) return;

      if (foldedSet.has(i) && item.hasChildren) {
        hideUntilLevel = item.level;
      }

      const row = document.createElement('div');
      row.className = `outline-item-row outline-h${item.level}`;

      const toggle = document.createElement('span');
      toggle.className = 'outline-toggle';
      if (item.hasChildren) {
        const folded = foldedSet.has(i);
        toggle.textContent = folded ? '▶' : '▼';
        toggle.title = folded ? '展開' : '折りたたみ';
        toggle.addEventListener('click', (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          if (foldedSet.has(i)) foldedSet.delete(i);
          else foldedSet.add(i);
          render();
        });
      } else {
        toggle.classList.add('empty');
      }
      row.appendChild(toggle);

      const a = document.createElement('a');
      a.className = 'outline-item';
      a.textContent = item.el.textContent;
      a.href = '#';
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        item.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      row.appendChild(a);

      listWrap.appendChild(row);
    });
  }

  render();
}

function highlightInPreview(q) {
  if (!q) return;
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const SKIP = new Set(['SCRIPT', 'STYLE', 'PRE', 'CODE', 'MARK', 'SVG', 'TEXTAREA']);

  function walk(node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (SKIP.has(node.tagName) || node.classList.contains('mermaid')) return;
      for (const child of Array.from(node.childNodes)) walk(child);
    } else if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent;
      re.lastIndex = 0;
      if (!re.test(text)) return;
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const mark = document.createElement('mark');
        mark.className = 'hl-search';
        mark.textContent = m[0];
        frag.appendChild(mark);
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
  }

  walk(previewContent);

  // Scroll to first match
  const first = previewContent.querySelector('mark.hl-search');
  if (first) first.scrollIntoView({ block: 'center' });
}

async function renderMermaid() {
  const nodes = Array.from(previewContent.querySelectorAll('.mermaid'));
  if (!nodes.length) return;
  mermaid.initialize({ ...MERMAID_BASE, theme: mermaidTheme() });
  nodes.forEach((el) => {
    // 元のグラフ定義を保持しておく (印刷時に配色を変えて描き直すため)
    if (!el.dataset.mermaidSrc) el.dataset.mermaidSrc = el.textContent;
    el.removeAttribute('data-processed');
    el.removeAttribute('data-mermaid-chart');
  });
  try {
    await mermaid.run({ nodes });
  } catch (e) {
    // エラーを図の場所に表示
    nodes.forEach((el) => {
      if (!el.querySelector('svg')) {
        el.innerHTML = `<pre style="color:red;font-size:12px">[mermaid error] ${escHtml(String(e))}</pre>`;
      }
    });
  }
  // 描画済み SVG をテーマ別にキャッシュ (印刷時の配色差し替えを再描画なしで行うため)
  const theme = mermaidTheme();
  nodes.forEach((el) => { if (el.querySelector('svg')) (el._svgCache ??= {})[theme] = el.innerHTML; });
  initMermaidZoom();
}

function initMermaidZoom() {
  previewContent.querySelectorAll('.mermaid').forEach(attachMermaidZoom);
}

function attachMermaidZoom(container) {
    const svg = container.querySelector('svg');
    if (!svg || container.dataset.zoomInit) return;
    container.dataset.zoomInit = '1';

    let scale = 1, panX = 0, panY = 0;
    let dragging = false, startX = 0, startY = 0, startPanX = 0, startPanY = 0;

    svg.style.maxWidth = 'none';
    svg.style.transformOrigin = '0 0';
    svg.style.display = 'block';
    container.style.overflow = 'hidden';
    container.style.cursor = 'grab';
    container.style.userSelect = 'none';

    function applyTransform() {
      svg.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    }

    container.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const newScale = Math.min(Math.max(scale * factor, 0.1), 10);
      panX = mx - (mx - panX) * (newScale / scale);
      panY = my - (my - panY) * (newScale / scale);
      scale = newScale;
      applyTransform();
    }, { passive: false });

    container.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      startPanX = panX; startPanY = panY;
      container.style.cursor = 'grabbing';
      e.preventDefault();
    });

    const onMouseMove = (e) => {
      if (!dragging) return;
      panX = startPanX + (e.clientX - startX);
      panY = startPanY + (e.clientY - startY);
      applyTransform();
    };
    const onMouseUp = () => {
      if (!dragging) return;
      dragging = false;
      container.style.cursor = 'grab';
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);

    const controls = document.createElement('div');
    controls.className = 'mermaid-controls';
    controls.innerHTML =
      '<button class="mz-btn" data-action="in" title="拡大">+</button>' +
      '<button class="mz-btn" data-action="out" title="縮小">-</button>' +
      '<button class="mz-btn" data-action="reset" title="リセット">&#x21BA;</button>';
    controls.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'in')         { scale = Math.min(scale * 1.25, 10); }
      else if (action === 'out')   { scale = Math.max(scale / 1.25, 0.1); }
      else if (action === 'reset') { scale = 1; panX = 0; panY = 0; }
      else return;
      applyTransform();
    });
    container.appendChild(controls);
}

// ---- Print title (PDF 既定保存名) ----------------------------------------
// PDF として保存する際の既定ファイル名はブラウザが document.title から決める。
// 印刷直前にアクティブファイル名へ差し替え、afterprint で元 (fastmd-explorer)
// へ戻す。保存名には .pdf が付くため .md/.markdown 拡張子は取り除く。
function setPrintTitle(name) {
  if (!name) return;
  const original = document.title;
  document.title = name;
  const restore = () => {
    window.removeEventListener('afterprint', restore);
    document.title = original;
  };
  window.addEventListener('afterprint', restore);
}

function printTitleFromTab(tab) {
  if (!tab?.name) return null;
  return tab.name.replace(/\.(md|markdown)$/i, '');
}

// ---- Mermaid print handling ----------------------------------------------
// 個別ファイルの印刷/PDF出力。ダークテーマだと図が白地で読めないため、印刷時だけ
// 図を白地 (default) 配色の SVG に描き直す。描き直しは図ごとに初回 1 回のみで、
// 以降はテーマ別にキャッシュした SVG を innerHTML で差し替えるだけ (再描画なし)。
// 図はベクターのまま印刷する (送信先「PDF として保存」なら高速・鮮明・軽量)。
async function printActivePreview() {
  setPrintTitle(printTitleFromTab(activeTab()));

  // ライトテーマは既に白地配色なので描き直し不要 → そのまま印刷
  if (mermaidTheme() === 'default') { window.print(); return; }

  const nodes = Array.from(previewContent.querySelectorAll('.mermaid'));
  if (!nodes.length) { window.print(); return; }

  // 白地配色 SVG が未キャッシュの図だけ 1 度描画してキャッシュ
  const need = nodes.filter((el) => !el._svgCache?.default && el.dataset.mermaidSrc);
  if (need.length) {
    mermaid.initialize({ ...MERMAID_BASE, theme: 'default' });
    need.forEach((el) => {
      el.textContent = el.dataset.mermaidSrc;
      el.removeAttribute('data-processed');
      el.removeAttribute('data-mermaid-chart');
    });
    try { await mermaid.run({ nodes: need }); } catch { /* 図のエラーは無視 */ }
    need.forEach((el) => { if (el.querySelector('svg')) (el._svgCache ??= {}).default = el.innerHTML; });
  }

  // 表示中の図を白地配色へ差し替え (再描画なし)
  nodes.forEach((el) => { if (el._svgCache?.default) el.innerHTML = el._svgCache.default; });

  // 印刷後に元 (ダーク) 配色へ戻し、ズーム操作を再付与
  const restore = () => {
    window.removeEventListener('afterprint', restore);
    nodes.forEach((el) => {
      const svg = el._svgCache?.dark;
      if (svg) { el.innerHTML = svg; delete el.dataset.zoomInit; attachMermaidZoom(el); }
    });
  };
  window.addEventListener('afterprint', restore);
  window.print();
}

// ---- Link graph overlay --------------------------------------------------
// 全 .md の相互リンクを Cytoscape.js の力学レイアウト (cose) で図示する。
// Mermaid フローチャートはリンク網の密なグラフでは破綻するため専用ライブラリを使う。
// ボタン押下時に初めて cytoscape を遅延ロードし /api/linkgraph を叩く (それまで負荷ゼロ)。

let _cy = null;
let _cytoscapeLoading = null;

// リンク図のズーム範囲。スライダーは log スケールでこの範囲を 0..1 に対応させる。
const LG_MIN_ZOOM = 0.05, LG_MAX_ZOOM = 4;

function lgSliderToZoom(t) { return LG_MIN_ZOOM * Math.pow(LG_MAX_ZOOM / LG_MIN_ZOOM, t); }

function lgSyncZoomSlider() {
  if (!_cy) return;
  const z = _cy.zoom();
  const t = (Math.log(z) - Math.log(LG_MIN_ZOOM)) / (Math.log(LG_MAX_ZOOM) - Math.log(LG_MIN_ZOOM));
  lgZoomSlider.value = String(Math.min(1, Math.max(0, t)));
}

// ビューポート中心を保ったままズーム
function lgZoomTo(level) {
  if (!_cy) return;
  const z = Math.min(LG_MAX_ZOOM, Math.max(LG_MIN_ZOOM, level));
  _cy.zoom({ level: z, renderedPosition: { x: lgGraph.clientWidth / 2, y: lgGraph.clientHeight / 2 } });
}

function loadCytoscape() {
  if (window.cytoscape) return Promise.resolve();
  if (_cytoscapeLoading) return _cytoscapeLoading;
  _cytoscapeLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/cytoscape.min.js';
    s.onload = () => resolve();
    s.onerror = () => { _cytoscapeLoading = null; reject(new Error('cytoscape の読み込みに失敗しました')); };
    document.head.appendChild(s);
  });
  return _cytoscapeLoading;
}

async function openLinkGraph() {
  if (!state.currentRoot) { showWarning('フォルダが未選択です', 'warn'); return; }
  linkgraphOverlay.classList.remove('hidden');
  lgGraph.innerHTML = '<div class="lg-loading">リンクを解析中...</div>';
  lgStats.textContent = '';
  try {
    await loadCytoscape();
    const data = await get('/api/linkgraph');
    if (!data.nodes.length) {
      lgGraph.innerHTML = '<div class="lg-empty">mdファイル間のリンクが見つかりませんでした</div>';
      lgStats.textContent = `0 / ${data.total} ファイル`;
      return;
    }

    const sep = state.currentRoot.includes('\\') ? '\\' : '/';

    // 同名ファイルはフォルダ名が無いと区別できないため、basename が重複する
    // ノードのみ相対パス (拡張子なし) をラベルにして曖昧さを解消する。
    const baseCount = new Map();
    data.nodes.forEach((n) => baseCount.set(n.name, (baseCount.get(n.name) ?? 0) + 1));
    const labelOf = (n) => (baseCount.get(n.name) > 1
      ? n.rel.replace(/\.(md|markdown|mdown|mkd)$/i, '')
      : n.name);

    const elements = [];
    data.nodes.forEach((n) => elements.push({ data: {
      id: n.rel,
      label: labelOf(n),
      path: state.currentRoot + sep + n.rel.replace(/\//g, sep),
      rel: n.rel,
      name: n.rel.split('/').pop(),
    } }));
    data.edges.forEach((e, i) => elements.push({ data: { id: 'e' + i, source: e.from, target: e.to } }));

    lgGraph.innerHTML = '';
    if (_cy) { _cy.destroy(); _cy = null; }

    // テーマの CSS 変数から配色を取得 (ダーク/ライト両対応)
    const css = getComputedStyle(document.documentElement);
    const v = (name, fb) => (css.getPropertyValue(name).trim() || fb);
    const accent = v('--accent', '#0078d4');
    const text   = v('--text', '#1a1a1a');
    const nodeBg = v('--bg-code', '#eef');
    const edgeC  = v('--text-dim', '#888');
    const hl     = '#f5a623';

    _cy = cytoscape({
      container: lgGraph,
      elements,
      minZoom: LG_MIN_ZOOM,
      maxZoom: LG_MAX_ZOOM,
      style: [
        { selector: 'node', style: {
          'background-color': nodeBg, 'border-color': accent, 'border-width': 1.5,
          'label': 'data(label)', 'color': text, 'font-size': 11,
          'text-valign': 'center', 'text-halign': 'center',
          'shape': 'round-rectangle', 'width': 'label', 'height': 'label',
          'padding': '6px', 'text-wrap': 'none',
        } },
        { selector: 'edge', style: {
          'width': 1, 'line-color': edgeC, 'target-arrow-color': edgeC,
          'target-arrow-shape': 'triangle', 'arrow-scale': 0.8, 'curve-style': 'bezier',
        } },
        { selector: '.faded', style: { 'opacity': 0.1 } },
        { selector: 'node.hl', style: { 'border-color': hl, 'border-width': 3 } },
        { selector: 'edge.hl', style: { 'line-color': hl, 'target-arrow-color': hl, 'width': 2 } },
      ],
      layout: {
        name: 'cose', animate: false, randomize: true, fit: true, padding: 30,
        nodeRepulsion: 9000, idealEdgeLength: 90, nodeOverlap: 10,
        gravity: 0.25, componentSpacing: 70,
      },
    });

    // ホバーで近傍 (自身＋隣接ノード＋接続エッジ) を強調し、他を淡色化
    _cy.on('mouseover', 'node', (e) => {
      const nb = e.target.closedNeighborhood();
      _cy.elements().addClass('faded');
      nb.removeClass('faded').addClass('hl');
    });
    _cy.on('mouseout', 'node', () => { _cy.elements().removeClass('faded hl'); });

    // クリックで該当ファイルを開く (ドラッグ移動では発火しない)
    _cy.on('tap', 'node', (e) => {
      const d = e.target.data();
      closeLinkGraph();
      openFile({ path: d.path, relativePath: d.rel, name: d.name });
    });

    // ズーム操作 (ホイール/ボタン/fit) のたびにスライダーを同期
    _cy.on('zoom', lgSyncZoomSlider);
    _cy.one('layoutstop', lgSyncZoomSlider);
    lgSyncZoomSlider();

    lgStats.textContent = data.isolatedCount
      ? `${data.nodes.length} ファイル・${data.edges.length} リンク（リンクなし ${data.isolatedCount} 件は非表示）`
      : `${data.nodes.length} ファイル・${data.edges.length} リンク`;
  } catch (err) {
    lgGraph.innerHTML = `<div class="error-msg">エラー: ${escHtml(err.message)}</div>`;
  }
}

function closeLinkGraph() {
  linkgraphOverlay.classList.add('hidden');
  if (_cy) { _cy.destroy(); _cy = null; }
  lgGraph.innerHTML = '';
}

// グラフ全体を PNG 画像として保存 (md への貼り付け・ドキュメント用)。
// 背景は現在のテーマ色にして、ラベルが必ず読める WYSIWYG な画像にする。
function saveLinkGraphPng() {
  if (!_cy) { showWarning('先にリンク図を表示してください', 'warn'); return; }
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#ffffff';
  const uri = _cy.png({ full: true, scale: 2, bg });
  const root = (state.currentRoot ?? '').replace(/[/\\]+$/, '').split(/[/\\]/).pop() || 'linkgraph';
  const a = document.createElement('a');
  a.href = uri;
  a.download = `${root}-linkgraph.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---- Combined PDF overlay ------------------------------------------------
// フォルダ内の全 .md を 1 つの結合プレビューにまとめ、印刷で PDF 化する。

async function openCombined() {
  if (!state.currentRoot) { showWarning('フォルダが未選択です', 'warn'); return; }
  combinedOverlay.classList.remove('hidden');
  combinedContent.innerHTML = '<div class="cb-loading">全mdを結合中...</div>';
  cbStats.textContent = '';
  try {
    const { html, fileCount } = await get('/api/combined');
    if (!fileCount) {
      combinedContent.innerHTML = '<div class="cb-loading">Markdownファイルが見つかりませんでした</div>';
      return;
    }
    combinedContent.innerHTML = html;
    cbStats.textContent = `${fileCount} ファイル`;

    // Mermaid 図を描画。結合プレビューは PDF 前提のビューなので、テーマに依らず
    // 常にライト配色 (default) で描く → 画面の見た目がそのまま PDF になる。
    const nodes = Array.from(combinedContent.querySelectorAll('.mermaid'));
    if (nodes.length) {
      mermaid.initialize({ ...MERMAID_BASE, theme: 'default' });
      nodes.forEach((el) => {
        if (!el.dataset.mermaidSrc) el.dataset.mermaidSrc = el.textContent;
        el.removeAttribute('data-processed');
      });
      try { await mermaid.run({ nodes }); } catch { /* 図のエラーは無視 */ }
      mermaid.initialize({ ...MERMAID_BASE, theme: mermaidTheme() }); // 本体の描画用に戻す
    }

    // 目次・ファイル間リンク (#file-N / #file-N--slug) を画面内スクロールに
    combinedContent.querySelectorAll('a[href^="#"]').forEach((a) => {
      a.addEventListener('click', (e) => {
        const target = combinedContent.querySelector(`[id="${CSS.escape(a.getAttribute('href').slice(1))}"]`);
        if (target) { e.preventDefault(); target.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      });
    });
    combinedContent.scrollTop = 0;
  } catch (err) {
    combinedContent.innerHTML = `<div class="error-msg">エラー: ${escHtml(err.message)}</div>`;
  }
}

function closeCombined() {
  combinedOverlay.classList.add('hidden');
  combinedContent.innerHTML = '';
}

function printCombined() {
  // 結合印刷はフォルダ全体が対象 → 保存名はルートフォルダ名 (取れなければ既定のまま)
  const root = state.currentRoot?.split(/[\\/]/).filter(Boolean).pop();
  setPrintTitle(root ? `${root}-結合` : null);
  document.body.classList.add('combined-printing');
  const cleanup = () => {
    document.body.classList.remove('combined-printing');
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  window.print();
}

// ---- In-page find (Ctrl+F) -----------------------------------------------
let _findMarks = [];
let _findIdx = -1;

function openFindBar() {
  findBar.classList.remove('hidden');
  findInput.focus();
  findInput.select();
}

function closeFindBar() {
  findBar.classList.add('hidden');
  clearFindMarks();
  findCount.textContent = '';
}

function clearFindMarks() {
  _findMarks.forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(m.textContent), m);
    parent.normalize();
  });
  _findMarks = [];
  _findIdx = -1;
}

function runFind(q) {
  clearFindMarks();
  if (!q) { findCount.textContent = ''; return; }

  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'MARK']);

  function walk(node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (SKIP.has(node.tagName) || node.classList?.contains('mermaid')) return;
      for (const child of Array.from(node.childNodes)) walk(child);
    } else if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent;
      re.lastIndex = 0;
      if (!re.test(text)) return;
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const mark = document.createElement('mark');
        mark.className = 'find-hl';
        mark.textContent = m[0];
        _findMarks.push(mark);
        frag.appendChild(mark);
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
  }
  walk(previewContent);

  if (_findMarks.length) {
    _findIdx = 0;
    scrollToFindMark(0);
  }
  findCount.textContent = _findMarks.length ? `1 / ${_findMarks.length}` : '一致なし';
}

function scrollToFindMark(idx) {
  _findMarks.forEach((m, i) => m.classList.toggle('find-hl-active', i === idx));
  _findMarks[idx]?.scrollIntoView({ block: 'center' });
  findCount.textContent = `${idx + 1} / ${_findMarks.length}`;
}

function findStep(dir) {
  if (!_findMarks.length) return;
  _findIdx = (_findIdx + dir + _findMarks.length) % _findMarks.length;
  scrollToFindMark(_findIdx);
}

// ---- Table sort ----------------------------------------------------------
function addTableSort() {
  previewContent.querySelectorAll('table').forEach((table) => {
    const ths = table.querySelectorAll('thead th');
    if (!ths.length) return;
    ths.forEach((th, colIdx) => {
      th.style.cursor = 'pointer';
      th.dataset.sortDir = '';
      th.addEventListener('click', () => {
        const dir = th.dataset.sortDir === 'asc' ? 'desc' : 'asc';
        ths.forEach((t) => { t.dataset.sortDir = ''; t.classList.remove('sort-asc', 'sort-desc'); });
        th.dataset.sortDir = dir;
        th.classList.add(dir === 'asc' ? 'sort-asc' : 'sort-desc');

        const tbody = table.querySelector('tbody');
        if (!tbody) return;
        const rows = Array.from(tbody.querySelectorAll('tr'));
        rows.sort((a, b) => {
          const aText = a.cells[colIdx]?.textContent.trim() ?? '';
          const bText = b.cells[colIdx]?.textContent.trim() ?? '';
          const aNum = parseFloat(aText);
          const bNum = parseFloat(bText);
          const cmp = (!isNaN(aNum) && !isNaN(bNum))
            ? aNum - bNum
            : aText.localeCompare(bText, 'ja');
          return dir === 'asc' ? cmp : -cmp;
        });
        rows.forEach((r) => tbody.appendChild(r));
      });
    });
  });
}

function addCopyButtons() {
  previewContent.querySelectorAll('pre > code').forEach((code) => {
    const pre = code.parentElement;
    if (pre.querySelector('.copy-btn')) return; // already added
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = 'コピー';
    btn.title = 'コードをコピー';
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(code.innerText).then(() => {
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = 'コピー'; }, 1500);
      });
    });
    pre.style.position = 'relative';
    pre.appendChild(btn);
  });
}

function fixLocalLinks() {
  previewContent.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (!href || /^https?:\/\//.test(href) || href.startsWith('#')) return;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (/\.(md|markdown|mdown|mkd)$/i.test(href)) {
        const baseParts = (state.activeTabPath ?? '').replace(/\\/g, '/').split('/');
        baseParts.pop();
        const resolved = [...baseParts, ...href.split('/')].join('/');
        const sep = state.currentRoot?.includes('\\') ? '\\' : '/';
        const resolvedNative = resolved.replace(/\//g, sep);
        const rel = resolved.replace((state.currentRoot ?? '').replace(/\\/g, '/') + '/', '');
        navigateInTab({ path: resolvedNative, relativePath: rel, name: href.split('/').pop() });
      } else {
        window.open(href, '_blank', 'noreferrer');
      }
    });
  });
}

// ---- In-tab navigation history -------------------------------------------

async function navigateInTab(file) {
  const tab = activeTab();
  // No active tab → open normally
  if (!tab) { await openFile(file); return; }
  // Already showing this file → nothing to do
  if (tab.path === file.path) return;

  _initTabNav(tab);
  const nav = state.tabNavStacks[tab.id];

  // Truncate forward history and push new entry
  nav.stack.splice(nav.idx + 1);
  nav.stack.push(_navEntry(file));
  nav.idx++;

  await _navApply(tab, nav, file);
}

async function navBack() {
  const tab = activeTab();
  if (!tab) return;
  _initTabNav(tab);
  const nav = state.tabNavStacks[tab.id];
  if (nav.idx <= 0) return;
  nav.idx--;
  await _navApply(tab, nav, nav.stack[nav.idx]);
}

async function navForward() {
  const tab = activeTab();
  if (!tab) return;
  _initTabNav(tab);
  const nav = state.tabNavStacks[tab.id];
  if (nav.idx >= nav.stack.length - 1) return;
  nav.idx++;
  await _navApply(tab, nav, nav.stack[nav.idx]);
}

async function _navApply(tab, nav, file) {
  const oldPath = tab.path;

  // Move dirty marker; discard unsaved editor text
  if (state.tabDirty[oldPath]) {
    state.tabDirty[file.path] = state.tabDirty[oldPath];
    delete state.tabDirty[oldPath];
  }
  delete state.tabEditorText[oldPath];

  tab.path = file.path;
  tab.name = file.name;
  tab.relativePath = file.relativePath;
  state.activeTabPath = file.path;
  state.isEditing = false;

  pushRecent(file);
  renderTabBar();
  updateTreeActiveState();
  updateNavButtons();
  await renderFileContent(tab);
}

// ---- Editor toolbar ------------------------------------------------------
function applyEditorCmd(cmd) {
  const ta = editor;
  const start = ta.selectionStart;
  const end   = ta.selectionEnd;
  const sel   = ta.value.slice(start, end);
  const before = ta.value.slice(0, start);
  const after  = ta.value.slice(end);

  let newVal, newStart, newEnd;

  const wrap = (pre, post = pre) => {
    newVal   = before + pre + sel + post + after;
    newStart = start + pre.length;
    newEnd   = end   + pre.length;
  };

  const linePrefix = (prefix) => {
    // Apply prefix to each selected line
    const lineStart = before.lastIndexOf('\n') + 1;
    const fullLine  = ta.value.slice(lineStart, end);
    const lines     = (before.slice(lineStart) + sel).split('\n');
    const prefixed  = lines.map((l, i) => {
      if (cmd === 'ol') return `${i + 1}. ${l}`;
      return prefix + l;
    }).join('\n');
    newVal   = ta.value.slice(0, lineStart) + prefixed + after;
    newStart = lineStart + prefixed.length - (sel.length ? 0 : 0);
    newEnd   = newStart;
  };

  switch (cmd) {
    case 'bold':      wrap('**'); break;
    case 'italic':    wrap('*'); break;
    case 'strike':    wrap('~~'); break;
    case 'h1':        linePrefix('# '); break;
    case 'h2':        linePrefix('## '); break;
    case 'h3':        linePrefix('### '); break;
    case 'ul':        linePrefix('- '); break;
    case 'ol':        linePrefix(''); break;
    case 'check':     linePrefix('- [ ] '); break;
    case 'code':      wrap('`'); break;
    case 'codeblock': wrap('\n```\n', '\n```\n'); break;
    case 'link': {
      const url = sel || 'https://';
      const label = sel ? sel : 'リンクテキスト';
      newVal   = before + `[${label}](${url})` + after;
      newStart = start + 1;
      newEnd   = start + 1 + label.length;
      break;
    }
    case 'table': {
      const tbl = '\n| 列1 | 列2 | 列3 |\n|------|------|------|\n| セル | セル | セル |\n';
      newVal   = before + tbl + after;
      newStart = newEnd = start + tbl.length;
      break;
    }
    default: return;
  }

  ta.focus();
  ta.value = newVal;
  ta.setSelectionRange(newStart, newEnd);
  ta.dispatchEvent(new Event('input'));
}

// ---- Live preview & scroll sync ------------------------------------------
let _liveTimer = null;
let _scrollLock = false;

function scheduleLivePreview() {
  clearTimeout(_liveTimer);
  _liveTimer = setTimeout(runLivePreview, 400);
}

async function runLivePreview() {
  try {
    const { html } = await post('/api/render', { content: editor.value, filePath: state.activeTabPath });
    previewContent.innerHTML = html;
    await renderMermaid();
    fixLocalLinks();
    addCopyButtons();
    addTableSort();
  } catch { /* ignore */ }
}

function syncScrollEditorToPreview() {
  if (_scrollLock) return;
  _scrollLock = true;
  const ratio = editor.scrollTop / Math.max(1, editor.scrollHeight - editor.clientHeight);
  previewContent.scrollTop = ratio * (previewContent.scrollHeight - previewContent.clientHeight);
  requestAnimationFrame(() => { _scrollLock = false; });
}

function syncScrollPreviewToEditor() {
  if (_scrollLock) return;
  _scrollLock = true;
  const ratio = previewContent.scrollTop / Math.max(1, previewContent.scrollHeight - previewContent.clientHeight);
  editor.scrollTop = ratio * (editor.scrollHeight - editor.clientHeight);
  requestAnimationFrame(() => { _scrollLock = false; });
}

// ---- Edit mode -----------------------------------------------------------
async function enterEditMode() {
  if (!state.activeTabPath) return;
  state.isEditing = true;

  editArea.classList.add('split');
  editorPanel.classList.remove('hidden');
  previewPanel.classList.remove('hidden');
  btnEdit.classList.add('hidden');
  btnSave.classList.remove('hidden');
  btnDiscard.classList.remove('hidden');

  // Restore saved editor text if we had it, otherwise fetch from server
  if (state.tabEditorText[state.activeTabPath] !== undefined) {
    editor.value = state.tabEditorText[state.activeTabPath];
    editor.focus();
  } else {
    try {
      const { content } = await get(`/api/file?path=${encodeURIComponent(state.activeTabPath)}`);
      editor.value = content;
      editor.focus();
    } catch (err) {
      showWarning(`読み込みエラー: ${err.message}`, 'error');
    }
  }
  scheduleLivePreview();
}

async function saveFile() {
  const path = state.activeTabPath;
  if (!path) return;
  try {
    await put(`/api/file?path=${encodeURIComponent(path)}`, { content: editor.value });
    state.tabDirty[path] = false;
    delete state.tabEditorText[path];
    renderTabBar();
    await exitEditMode(true);
  } catch (err) {
    showWarning(`保存エラー: ${err.message}`, 'error');
  }
}

async function exitEditMode(reload = false) {
  state.isEditing = false;
  exitEditModeUI();

  if (reload && state.activeTabPath) {
    const tab = activeTab();
    if (tab) {
      previewContent.innerHTML = '<div class="loading">レンダリング中...</div>';
      try {
        const { html } = await get(`/api/preview?path=${encodeURIComponent(tab.path)}`);
        previewContent.innerHTML = html;
        previewPanel.scrollTop = 0;
        await renderMermaid();
        fixLocalLinks();
        addCopyButtons();
        addTableSort();
      } catch { /* ignore */ }
    }
  }
}

function exitEditModeUI() {
  state.isEditing = false;
  editArea.classList.remove('split');
  editorPanel.classList.add('hidden');
  previewPanel.classList.remove('hidden');
  btnEdit.classList.remove('hidden');
  btnSave.classList.add('hidden');
  btnDiscard.classList.add('hidden');
}

// ---- Tags / Flag ---------------------------------------------------------
function currentMeta(tab) {
  const rel = tab?.relativePath ?? activeTab()?.relativePath;
  if (!rel) return { tags: [], flagged: false, note: '' };
  return state.tags[rel] ?? { tags: [], flagged: false, note: '' };
}

function updateTagsBar(tab) {
  tagsList.innerHTML = '';
  (currentMeta(tab).tags ?? []).forEach((tag) => tagsList.appendChild(makeTagChip(tag)));
}

function updateNoteBar(tab) {
  noteInput.value = currentMeta(tab).note ?? '';
}

function updateFileHeader(tab) {
  const t = tab ?? activeTab();
  if (!t) return;
  fileBreadcrumb.textContent = t.relativePath;
  const meta = currentMeta(t);
  btnFlag.textContent = meta.flagged ? '★' : '☆';
  btnFlag.classList.toggle('flagged', !!meta.flagged);
}

function makeTagChip(tag) {
  const span = document.createElement('span');
  span.className = 'tag-chip';
  span.style.setProperty('--tag-hue', tagHue(tag));
  span.title = 'クリックで編集';

  const label = document.createElement('span');
  label.className = 'tag-label';
  label.textContent = tag;
  label.addEventListener('click', async () => {
    await removeTag(tag);
    tagInput.value = tag;
    tagInput.focus();
  });

  const del = document.createElement('button');
  del.className = 'tag-del';
  del.textContent = '×';
  del.title = 'タグを削除';
  del.addEventListener('click', () => removeTag(tag));

  span.appendChild(label);
  span.appendChild(del);
  return span;
}

async function addTag(tag) {
  tag = tag.trim().replace(/\s+/g, '-');
  if (!tag || !state.activeTabPath) return;
  const meta = currentMeta();
  if ((meta.tags ?? []).includes(tag)) return;
  await saveTagMeta({ tags: [...(meta.tags ?? []), tag] });
}

async function removeTag(tag) {
  if (!state.activeTabPath) return;
  const meta = currentMeta();
  await saveTagMeta({ tags: (meta.tags ?? []).filter((t) => t !== tag) });
}

async function toggleFlag() {
  if (!state.activeTabPath) return;
  await saveTagMeta({ flagged: !currentMeta().flagged });
}

async function saveNote(note) {
  if (!state.activeTabPath) return;
  await saveTagMeta({ note });
}

async function saveTagMeta(patch) {
  const tab = activeTab();
  if (!tab) return;
  try {
    const updated = await put('/api/tags', {
      relativePath: tab.relativePath,
      ...currentMeta(tab),
      ...patch,
    });
    state.tags[tab.relativePath] = updated ?? {};
    updateFileHeader(tab);
    updateTagsBar(tab);
    refreshTreeItem(tab);
    renderTagFilterBar();
  } catch (err) {
    showWarning(`タグ保存エラー: ${err.message}`, 'error');
  }
}

function refreshTreeItem(tab) {
  const el = fileTree.querySelector(`.tree-file[data-path="${CSS.escape(tab.path)}"]`);
  if (!el) return;
  const meta = state.tags[tab.relativePath] ?? {};
  const right = el.querySelector('.file-meta');
  if (!right) return;
  right.innerHTML = '';
  if (meta.flagged) { const s = document.createElement('span'); s.className = 'flag-star flagged'; s.textContent = '★'; right.appendChild(s); }
  (meta.tags ?? []).forEach((tag) => right.appendChild(miniChip(tag)));
}

// ---- Tag filter bar ------------------------------------------------------

function renderTagFilterBar() {
  // Collect all unique tags across all files
  const allTags = new Set();
  Object.values(state.tags).forEach(({ tags }) => (tags ?? []).forEach((t) => allTags.add(t)));

  const hasFlagged = Object.values(state.tags).some(({ flagged }) => flagged);

  if (allTags.size === 0 && !hasFlagged) {
    tagFilterBar.classList.add('hidden');
    tagFilterBar.innerHTML = '';
    return;
  }

  tagFilterBar.classList.remove('hidden');
  tagFilterBar.innerHTML = '';

  const activeCount = state.filterTags.size + (state.filterFlagged ? 1 : 0);
  const collapsed = localStorage.getItem('tagFilterCollapsed') === '1';

  // Toggle header
  const header = document.createElement('div');
  header.className = 'tf-header';
  const arrow = collapsed ? '▸' : '▾';
  header.innerHTML = `<span class="tf-title">タグ ${arrow}</span>${activeCount > 0 ? `<span class="tf-badge">${activeCount}</span>` : ''}`;
  header.addEventListener('click', () => {
    const next = localStorage.getItem('tagFilterCollapsed') === '1' ? '0' : '1';
    localStorage.setItem('tagFilterCollapsed', next);
    renderTagFilterBar();
  });
  tagFilterBar.appendChild(header);

  if (collapsed) return;

  // Chips area
  const chips = document.createElement('div');
  chips.className = 'tf-chips';

  // Flagged filter button
  if (hasFlagged) {
    const btn = document.createElement('button');
    btn.className = 'tf-chip tf-flag' + (state.filterFlagged ? ' tf-active' : '');
    btn.textContent = '★';
    btn.title = 'フラグ付きのみ表示';
    btn.addEventListener('click', () => {
      state.filterFlagged = !state.filterFlagged;
      applySearch(state.searchQuery);
      renderTagFilterBar();
    });
    chips.appendChild(btn);
  }

  // Tag chips
  [...allTags].sort().forEach((tag) => {
    const btn = document.createElement('button');
    btn.className = 'tf-chip' + (state.filterTags.has(tag) ? ' tf-active' : '');
    btn.style.setProperty('--tag-hue', tagHue(tag));
    btn.textContent = tag;
    btn.addEventListener('click', () => {
      if (state.filterTags.has(tag)) state.filterTags.delete(tag);
      else state.filterTags.add(tag);
      applySearch(state.searchQuery);
      renderTagFilterBar();
    });
    chips.appendChild(btn);
  });

  // Clear button
  if (activeCount > 0) {
    const clear = document.createElement('button');
    clear.className = 'tf-clear';
    clear.textContent = '✕ クリア';
    clear.addEventListener('click', () => {
      state.filterTags.clear();
      state.filterFlagged = false;
      applySearch(state.searchQuery);
      renderTagFilterBar();
    });
    chips.appendChild(clear);
  }

  tagFilterBar.appendChild(chips);
}

// ---- Full-text search ----------------------------------------------------
let fulltextTimer = null;

function toggleFulltextPanel() {
  const open = !fulltextPanel.classList.contains('hidden');
  if (open) {
    fulltextPanel.classList.add('hidden');
    btnFulltext.classList.remove('active');
  } else {
    fulltextPanel.classList.remove('hidden');
    btnFulltext.classList.add('active');
    setTimeout(() => fulltextInput.focus(), 0);
  }
}

function scheduleFulltextSearch() {
  clearTimeout(fulltextTimer);
  if (_fulltextES) { _fulltextES.close(); _fulltextES = null; }
  const q = fulltextInput.value.trim();
  if (!q) { fulltextResults.innerHTML = ''; return; }
  fulltextTimer = setTimeout(() => runFulltextSearch(q), 400);
}

let _fulltextES = null;

function runFulltextSearch(q) {
  // Close any previous stream
  if (_fulltextES) { _fulltextES.close(); _fulltextES = null; }

  fulltextResults.innerHTML = '';

  const progress = document.createElement('div');
  progress.className = 'ft-progress';
  progress.textContent = 'スキャン中...';
  fulltextResults.appendChild(progress);

  let foundCount = 0;

  const es = new EventSource(`/api/search?q=${encodeURIComponent(q)}`);
  _fulltextES = es;

  const reQ = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  function hlText(el, rawText) {
    let html = '';
    let last = 0;
    let m;
    reQ.lastIndex = 0;
    while ((m = reQ.exec(rawText)) !== null) {
      html += escHtml(rawText.slice(last, m.index));
      html += `<mark class="ft-hl">${escHtml(m[0])}</mark>`;
      last = m.index + m[0].length;
    }
    html += escHtml(rawText.slice(last));
    el.innerHTML = html;
  }

  function appendResult({ path, relativePath, matches }) {
    const item = document.createElement('div');
    item.className = 'ft-item';
    const title = document.createElement('div');
    title.className = 'ft-title';
    title.textContent = relativePath;
    title.title = relativePath;
    item.appendChild(title);
    matches.forEach(({ lineNum, text }) => {
      const ctx = document.createElement('div');
      ctx.className = 'ft-ctx';
      const prefix = document.createElement('span');
      prefix.className = 'ft-linenum';
      prefix.textContent = `${lineNum}: `;
      const body = document.createElement('span');
      hlText(body, text);
      ctx.appendChild(prefix);
      ctx.appendChild(body);
      item.appendChild(ctx);
    });
    item.addEventListener('click', () => {
      openFile({ path, relativePath, name: relativePath.split('/').pop(), highlight: q });
    });
    fulltextResults.appendChild(item);
  }

  es.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'progress') {
      progress.textContent = `スキャン中: ${msg.scanned}件 / ${msg.found}ヒット`;
    } else if (msg.type === 'result') {
      foundCount++;
      appendResult(msg);
    } else if (msg.type === 'done') {
      es.close();
      _fulltextES = null;
      progress.remove();
      if (foundCount === 0) {
        fulltextResults.innerHTML = '<div class="ft-empty">一致なし</div>';
      } else if (msg.truncated) {
        const note = document.createElement('div');
        note.className = 'ft-note';
        note.textContent = `上位${foundCount}件を表示`;
        fulltextResults.insertBefore(note, fulltextResults.firstChild);
      }
    }
  });

  es.addEventListener('error', () => {
    es.close();
    _fulltextES = null;
    progress.remove();
    if (foundCount === 0) {
      fulltextResults.innerHTML = '<div class="ft-empty">検索エラー</div>';
    }
  });
}

// ---- Search filter -------------------------------------------------------
function applySearch(query) {
  state.searchQuery = query.toLowerCase();
  const isFiltering = !!state.searchQuery || state.filterTags.size > 0 || state.filterFlagged;

  // Force-render all unrendered dirs so deep files are searchable
  if (isFiltering) {
    let rendered;
    do {
      rendered = 0;
      fileTree.querySelectorAll('.tree-children').forEach((ul) => {
        if (ul.childElementCount === 0 && ul._dirChildren?.length) {
          renderChildren(ul._dirChildren, ul);
          rendered++;
        }
      });
    } while (rendered > 0);
  }

  const items = fileTree.querySelectorAll('.tree-file');
  let visible = 0;

  items.forEach((el) => {
    const name = (el.querySelector('.file-name')?.textContent ?? '').toLowerCase();
    const rel  = (el.dataset.rel ?? '').toLowerCase();
    const meta = state.tags[el.dataset.rel] ?? {};

    const matchSearch  = !state.searchQuery || name.includes(state.searchQuery) || rel.includes(state.searchQuery);
    const matchFlagged = !state.filterFlagged || !!meta.flagged;
    const matchTags    = state.filterTags.size === 0 ||
      [...state.filterTags].every((t) => (meta.tags ?? []).includes(t));

    const match = matchSearch && matchFlagged && matchTags;
    el.style.display = match ? '' : 'none';
    if (match) visible++;
  });

  // Filter image items by search query
  fileTree.querySelectorAll('.tree-image').forEach((el) => {
    const name = (el.querySelector('.tree-image-name')?.textContent ?? '').toLowerCase();
    el.style.display = (!state.searchQuery || name.includes(state.searchQuery)) ? '' : 'none';
  });

  // Show/hide dirs based on matching files; restore collapsed state when cleared
  fileTree.querySelectorAll('.tree-children').forEach((ul) => {
    const dirRow = ul.previousElementSibling;
    if (isFiltering) {
      const hasVisible = [...ul.querySelectorAll('.tree-file, .tree-image')].some((el) => el.style.display !== 'none');
      ul.style.display = hasVisible ? '' : 'none';
      if (dirRow?.classList.contains('tree-dir')) dirRow.style.display = hasVisible ? '' : 'none';
    } else {
      // Restore to the user's expanded/collapsed state
      const expanded = state.expandedDirs.has(ul.dataset.dirId);
      ul.style.display = expanded ? '' : 'none';
      if (dirRow?.classList.contains('tree-dir')) dirRow.style.display = '';
    }
  });

  const total = items.length;
  sidebarFooter.textContent = isFiltering ? `${visible} / ${total} ファイル` : `${total} ファイル`;
  renderRecentPanel();
}

// ---- File management -----------------------------------------------------

function toRelative(absPath) {
  const root = state.currentRoot ?? '';
  return absPath.startsWith(root) ? absPath.slice(root.length).replace(/^[/\\]/, '') : absPath;
}

function showNewItemInput(parentUl, placeholder) {
  const isFile = placeholder.includes('.md');
  return new Promise((resolve) => {
    const li = document.createElement('li');
    const wrap = document.createElement('span');
    wrap.className = 'inline-input-wrap';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-input';
    input.placeholder = isFile ? 'ファイル名' : placeholder;
    wrap.appendChild(input);
    if (isFile) {
      const ext = document.createElement('span');
      ext.className = 'inline-input-ext';
      ext.textContent = '.md';
      wrap.appendChild(ext);
    }
    li.appendChild(wrap);
    if (!isFile) {
      const hint = document.createElement('span');
      hint.className = 'inline-input-hint';
      hint.textContent = '(同名の .md ファイルが自動作成されます)';
      input.addEventListener('input', () => {
        hint.textContent = input.value.trim()
          ? `(${input.value.trim()}.md が自動作成されます)`
          : '(同名の .md ファイルが自動作成されます)';
      });
      li.appendChild(hint);
    }
    parentUl.prepend(li);
    setTimeout(() => input.focus(), 0);
    let settled = false;
    function finish(value) {
      if (settled) return; settled = true;
      li.remove();
      resolve(value?.trim() || null);
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter')  { e.preventDefault(); finish(input.value); }
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => setTimeout(() => finish(null), 200));
  });
}

function startInlineRename(nameEl, oldName, isFile) {
  const dotIdx = oldName.lastIndexOf('.');
  const baseName = isFile && dotIdx > 0 ? oldName.slice(0, dotIdx) : oldName;
  const ext = isFile && dotIdx > 0 ? oldName.slice(dotIdx) : '';
  return new Promise((resolve) => {
    // タグ・フラグを一時非表示、file-name のクリップも解除
    const metaEl = nameEl.closest('.tree-file')?.querySelector('.file-meta');
    if (metaEl) metaEl.style.visibility = 'hidden';
    nameEl.style.overflow = 'visible';
    nameEl.style.whiteSpace = 'normal';

    nameEl.textContent = '';
    const wrap = document.createElement('span');
    wrap.className = 'inline-input-wrap';
    const input = document.createElement('input');
    input.type = 'text';
    input.value = baseName;
    input.className = 'inline-input';
    wrap.appendChild(input);
    if (ext) {
      const extSpan = document.createElement('span');
      extSpan.className = 'inline-input-ext';
      extSpan.textContent = ext;
      wrap.appendChild(extSpan);
    }
    nameEl.appendChild(wrap);
    setTimeout(() => { input.focus(); input.setSelectionRange(0, baseName.length); }, 0);
    let settled = false;
    function finish(confirmed) {
      if (settled) return; settled = true;
      if (metaEl) metaEl.style.visibility = '';
      nameEl.style.overflow = '';
      nameEl.style.whiteSpace = '';
      wrap.remove();
      nameEl.textContent = oldName;
      const newBase = input.value.trim();
      resolve(confirmed && newBase ? newBase + ext : null);
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter')  { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => setTimeout(() => finish(false), 200));
  });
}

async function fsCreateFile(dirPath) {
  const childUl = fileTree.querySelector(`.tree-children[data-dir-id="${CSS.escape(dirPath)}"]`);
  if (childUl?.style.display === 'none') childUl.previousElementSibling?.click();
  const targetUl = childUl ?? fileTree.querySelector('.tree-list');
  if (!targetUl) return;
  const name = await showNewItemInput(targetUl, 'ファイル名.md');
  if (!name) return;
  try {
    const res = await post('/api/fs/file', { dir: dirPath, name });
    // デフォルトタグ: アクティブなフィルタータグ ＋ 「新規」
    const defaultTags = [...state.filterTags, '新規'];
    const relPath = toRelative(res.path);
    await put('/api/tags', { relativePath: relPath, tags: defaultTags, flagged: false, note: '' });
    await refreshTree();
    const fileName = res.path.split(/[/\\]/).pop();
    openFile({ path: res.path, relativePath: relPath, name: fileName });
  } catch (err) { showWarning(`ファイル作成エラー: ${err.message}`, 'error'); await refreshTree(); }
}

async function fsCreateFolder(dirPath) {
  const childUl = fileTree.querySelector(`.tree-children[data-dir-id="${CSS.escape(dirPath)}"]`);
  if (childUl?.style.display === 'none') childUl.previousElementSibling?.click();
  const targetUl = childUl ?? fileTree.querySelector('.tree-list');
  if (!targetUl) return;
  const name = await showNewItemInput(targetUl, 'フォルダ名');
  if (!name) return;
  try {
    const { path: newFolderPath } = await post('/api/fs/folder', { dir: dirPath, name });
    // フォルダを表示するため同名の空 .md ファイルを自動作成
    const res = await post('/api/fs/file', { dir: newFolderPath, name });
    const relPath = toRelative(res.path);
    const defaultTags = [...state.filterTags, '新規'];
    if (defaultTags.length) {
      await put('/api/tags', { relativePath: relPath, tags: defaultTags, flagged: false, note: '' });
    }
    await refreshTree();
    openFile({ path: res.path, relativePath: relPath, name: name + '.md' });
  } catch (err) { showWarning(`フォルダ作成エラー: ${err.message}`, 'error'); await refreshTree(); }
}

async function fsRename(oldPath, isFile, nameEl) {
  const oldName = oldPath.split(/[/\\]/).pop();
  const newName = await startInlineRename(nameEl, oldName, isFile);
  if (!newName || newName === oldName) return;
  const dir = oldPath.slice(0, oldPath.length - oldName.length);
  const newPath = dir + newName;
  try {
    await patch('/api/fs/rename', { oldPath, newPath });
    // state.tags のキーを旧相対パス→新相対パスに移動（フォルダ配下も含む）
    const oldRel = toRelative(oldPath).replace(/\\/g, '/');
    const newRel = toRelative(newPath).replace(/\\/g, '/');
    for (const key of Object.keys(state.tags)) {
      const normKey = key.replace(/\\/g, '/');
      if (normKey === oldRel) {
        state.tags[newRel] = state.tags[key];
        delete state.tags[key];
      } else if (normKey.startsWith(oldRel + '/')) {
        state.tags[newRel + normKey.slice(oldRel.length)] = state.tags[key];
        delete state.tags[key];
      }
    }
    state.tabs.forEach((t) => {
      if (t.path === oldPath || t.path.startsWith(oldPath + '\\') || t.path.startsWith(oldPath + '/')) {
        const updated = t.path.replace(oldPath, newPath);
        t.path = updated; t.name = updated.split(/[/\\]/).pop(); t.relativePath = toRelative(updated);
      }
    });
    if (state.activeTabPath === oldPath ||
        state.activeTabPath?.startsWith(oldPath + '\\') ||
        state.activeTabPath?.startsWith(oldPath + '/')) {
      state.activeTabPath = state.activeTabPath.replace(oldPath, newPath);
    }
    renderTabBar();
    await refreshTree();
  } catch (err) {
    showWarning(`リネームエラー: ${err.message}`, 'error');
    await refreshTree();
  }
}

async function fsDelete(path, isFile) {
  const name = path.split(/[/\\]/).pop();
  const msg = isFile ? `"${name}" を削除しますか？` : `フォルダ "${name}" とその中身を全て削除しますか？`;
  if (!confirm(msg)) return;
  try {
    await del('/api/fs', { path });
    state.tabs = state.tabs.filter((t) => {
      const affected = t.path === path || t.path.startsWith(path + '\\') || t.path.startsWith(path + '/');
      if (affected) { delete state.tabDirty[t.path]; delete state.tabEditorText[t.path]; }
      return !affected;
    });
    if (!state.tabs.find((t) => t.path === state.activeTabPath)) {
      state.activeTabPath = state.tabs[0]?.path ?? null;
      state.isEditing = false;
    }
    renderTabBar();
    await refreshTree();
    if (state.activeTabPath) { const tab = activeTab(); if (tab) await renderFileContent(tab); else showEmptyState(); }
    else showEmptyState();
  } catch (err) { showWarning(`削除エラー: ${err.message}`, 'error'); }
}

// ---- Context menu --------------------------------------------------------

let ctxMenu = null;

function showContextMenu(e, items) {
  hideContextMenu();
  e.preventDefault();
  ctxMenu = document.createElement('div');
  ctxMenu.className = 'ctx-menu';
  items.forEach(({ label, action, danger }) => {
    const btn = document.createElement('button');
    btn.className = 'ctx-item' + (danger ? ' ctx-danger' : '');
    btn.textContent = label;
    btn.addEventListener('mousedown', (ev) => { ev.preventDefault(); ev.stopPropagation(); hideContextMenu(); action(); });
    ctxMenu.appendChild(btn);
  });
  document.body.appendChild(ctxMenu);
  const r = ctxMenu.getBoundingClientRect();
  let x = e.clientX, y = e.clientY;
  if (x + r.width  > window.innerWidth)  x = window.innerWidth  - r.width  - 4;
  if (y + r.height > window.innerHeight) y = window.innerHeight - r.height - 4;
  ctxMenu.style.left = x + 'px';
  ctxMenu.style.top  = y + 'px';
}

function hideContextMenu() { ctxMenu?.remove(); ctxMenu = null; }

// ---- UI helpers ----------------------------------------------------------
function showFileView() {
  emptyState.classList.add('hidden');
  imageView.classList.add('hidden');
  fileView.classList.remove('hidden');
}

function showEmptyState() {
  fileView.classList.add('hidden');
  imageView.classList.add('hidden');
  emptyState.classList.remove('hidden');
  btnNavBack.disabled = true;
  btnNavFwd.disabled  = true;
}

// ---- Image viewer --------------------------------------------------------
let _imgScale = null; // null = fit mode
let _imgPath  = null;

function openImageView(file) {
  _imgPath = file.path;
  _imgScale = null;

  fileView.classList.add('hidden');
  emptyState.classList.add('hidden');
  imageView.classList.remove('hidden');

  imageBreadcrumb.textContent = file.relativePath ?? file.name;
  imageDisplay.src = `/api/image?path=${encodeURIComponent(file.path)}`;
  applyImgScale();
}

function applyImgScale() {
  if (_imgScale === null) {
    imageDisplay.style.maxWidth  = '100%';
    imageDisplay.style.maxHeight = '100%';
    imageDisplay.style.width     = '';
    imageDisplay.style.height    = '';
  } else {
    imageDisplay.style.maxWidth  = 'none';
    imageDisplay.style.maxHeight = 'none';
    imageDisplay.style.width     = `${_imgScale}%`;
    imageDisplay.style.height    = 'auto';
  }
}

function bindImageViewer() {
  $('img-zoom-in').addEventListener('click', () => {
    _imgScale = (_imgScale ?? 100) * 1.25;
    applyImgScale();
  });
  $('img-zoom-reset').addEventListener('click', () => {
    _imgScale = 100;
    applyImgScale();
  });
  $('img-zoom-fit').addEventListener('click', () => {
    _imgScale = null;
    applyImgScale();
  });
  $('img-open-tab').addEventListener('click', () => {
    if (_imgPath) window.open(`/api/image?path=${encodeURIComponent(_imgPath)}`, '_blank', 'noreferrer');
  });
  $('img-close').addEventListener('click', () => {
    imageView.classList.add('hidden');
    if (state.activeTabPath) showFileView();
    else showEmptyState();
  });

  // Scroll wheel zoom on stage
  imageStage.addEventListener('wheel', (e) => {
    if (!imageView.classList.contains('hidden')) {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      _imgScale = (_imgScale ?? 100) * factor;
      applyImgScale();
    }
  }, { passive: false });
}

function updateTreeActiveState() {
  fileTree.querySelectorAll('.tree-file').forEach((el) => {
    el.classList.toggle('active', el.dataset.path === state.activeTabPath);
  });
}

function showWarning(html, type) {
  if (!html) { warningBar.classList.add('hidden'); warningBar.innerHTML = ''; return; }
  warningBar.className = type === 'error' ? 'bar-error' : 'bar-warn';
  warningBar.innerHTML = html + '<button class="warning-close" title="閉じる">✕</button>';
  warningBar.querySelector('.warning-close').addEventListener('click', () => showWarning(null));
  warningBar.classList.remove('hidden');
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function tagHue(tag) {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) & 0xffff;
  return h % 360;
}

// ---- Sidebar resize ------------------------------------------------------
function initResize() {
  let startX, startW;
  resizeHandle.addEventListener('mousedown', (e) => {
    startX = e.clientX;
    startW = sidebar.getBoundingClientRect().width;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });
  const onMove = (e) => { sidebar.style.width = Math.max(160, Math.min(600, startW + e.clientX - startX)) + 'px'; };
  const onUp   = ()  => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
}

// ---- Outline (ToC) resize -----------------------------------------------
function initOutlineResize() {
  if (!outlineResize) return;

  // Restore saved manual width
  const saved = localStorage.getItem('outlineWidth');
  if (saved) {
    document.documentElement.style.setProperty('--outline-width', saved + 'px');
    document.body.classList.add('outline-manual');
  }

  // しきい値を超えてマウスが動いてから初めて「手動モード」に切替える。
  // こうしないと単純クリック/ダブルクリックでもモードが切替わって幅がスナップしてしまう。
  const DRAG_THRESHOLD = 4;
  let startX = 0, startW = 0, dragging = false;

  const onMove = (e) => {
    if (!dragging) {
      if (Math.abs(e.clientX - startX) < DRAG_THRESHOLD) return;
      dragging = true;
      document.body.classList.add('outline-manual', 'outline-resizing');
    }
    const maxW = Math.floor(window.innerWidth * 0.8);
    const w = Math.max(160, Math.min(maxW, startW - (e.clientX - startX)));
    document.documentElement.style.setProperty('--outline-width', w + 'px');
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (dragging) {
      document.body.classList.remove('outline-resizing');
      const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--outline-width'), 10);
      if (!isNaN(w)) localStorage.setItem('outlineWidth', String(w));
      dragging = false;
    }
  };

  outlineResize.addEventListener('mousedown', (e) => {
    if (outlinePanel.classList.contains('collapsed')) return;
    startX = e.clientX;
    startW = outlinePanel.getBoundingClientRect().width;
    dragging = false;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    e.preventDefault();
  });

  // Double-click → reset to auto-fill mode
  outlineResize.addEventListener('dblclick', () => {
    localStorage.removeItem('outlineWidth');
    document.documentElement.style.removeProperty('--outline-width');
    document.body.classList.remove('outline-manual');
  });
}

// ---- Keyboard shortcuts --------------------------------------------------
function handleKey(e) {
  const mod = e.ctrlKey || e.metaKey;
  // Alt+Arrow for back/forward (must be before !mod early return)
  if (e.altKey && !mod) {
    if (e.key === 'ArrowLeft')  { e.preventDefault(); navBack(); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); navForward(); return; }
  }
  if (!mod) {
    if (e.key === 'Escape') {
      if (!findBar.classList.contains('hidden')) { closeFindBar(); }
      else if (state.isEditing) { exitEditMode(false); }
      else if (searchInput.value) { searchInput.value = ''; applySearch(''); }
    }
    return;
  }
  if (e.key === 'r') { e.preventDefault(); btnRefresh.click(); }
  if (e.key === 'F' && e.shiftKey) { e.preventDefault(); toggleFullview(); return; }
  if (e.key === 'f') {
    e.preventDefault();
    if (state.activeTabPath && !state.isEditing) { openFindBar(); }
    else { searchInput.focus(); searchInput.select(); }
  }
  if (e.key === 'g' && state.mode !== 'url') { e.preventDefault(); toggleFulltextPanel(); }
  if (e.key === 's' && state.isEditing) { e.preventDefault(); saveFile(); }
  if (e.key === 'e' && !state.isEditing && state.activeTabPath && state.mode !== 'url') { e.preventDefault(); enterEditMode(); }
  if (e.key === 'i' && state.activeTabPath && state.mode !== 'url') { e.preventDefault(); toggleFlag(); }
  // Tab navigation: Ctrl+Tab / Ctrl+Shift+Tab
  if (e.key === 'Tab' && state.tabs.length > 1) {
    e.preventDefault();
    const idx = state.tabs.findIndex((t) => t.path === state.activeTabPath);
    const next = e.shiftKey
      ? (idx - 1 + state.tabs.length) % state.tabs.length
      : (idx + 1) % state.tabs.length;
    switchToTab(state.tabs[next].path);
  }
  // Ctrl+W to close current tab
  if (e.key === 'w' && state.activeTabPath) {
    e.preventDefault();
    closeTab(state.activeTabPath);
  }
}

// ---- Event bindings ------------------------------------------------------
function bindEvents() {
  btnBrowse.addEventListener('click', browseFolder);
  btnOpen.addEventListener('click', () => openInput(folderInput.value));
  folderInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') openInput(folderInput.value); });
  modeToggle.addEventListener('click', (e) => {
    const b = e.target.closest('.mode-btn');
    if (b) switchMode(b.dataset.mode);
  });

  historySelect.addEventListener('change', () => {
    const val = historySelect.value;
    if (val) { folderInput.value = val; openInput(val); historySelect.value = ''; }
  });

  const doTreeRefresh = async () => {
    if (state.mode === 'url') {                 // URLモード: 現在の URL を再取得
      const tab = activeTab();
      if (tab?.isUrl) await renderFileContent(tab);
      return;
    }
    if (!state.currentRoot) return;
    await post('/api/refresh');
    await refreshTree();
  };
  btnRefresh.addEventListener('click', doTreeRefresh);
  btnTreeRefresh.addEventListener('click', doTreeRefresh);

  btnTheme.addEventListener('click', () => applyTheme(state.theme === 'light' ? 'dark' : 'light'));

  // Link graph & combined PDF overlays
  btnLinkgraph.addEventListener('click', openLinkGraph);
  lgClose.addEventListener('click', closeLinkGraph);
  lgZoomSlider.addEventListener('input', () => lgZoomTo(lgSliderToZoom(parseFloat(lgZoomSlider.value))));
  lgZoomIn.addEventListener('click',  () => lgZoomTo((_cy?.zoom() ?? 1) * 1.3));
  lgZoomOut.addEventListener('click', () => lgZoomTo((_cy?.zoom() ?? 1) / 1.3));
  lgZoomFit.addEventListener('click', () => { if (_cy) { _cy.fit(undefined, 30); lgSyncZoomSlider(); } });
  lgSavePng.addEventListener('click', saveLinkGraphPng);
  btnCombinedPdf.addEventListener('click', openCombined);
  cbClose.addEventListener('click', closeCombined);
  cbPrint.addEventListener('click', printCombined);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!linkgraphOverlay.classList.contains('hidden')) { closeLinkGraph(); return; }
    if (!combinedOverlay.classList.contains('hidden'))  { closeCombined(); }
  });

  btnFontDown.addEventListener('click', () => {
    const cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--preview-font-size'), 10) || FONT_DEFAULT;
    applyFontSize(Math.max(cur - FONT_STEP, FONT_MIN));
  });
  btnFontUp.addEventListener('click', () => {
    const cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--preview-font-size'), 10) || FONT_DEFAULT;
    applyFontSize(Math.min(cur + FONT_STEP, FONT_MAX));
  });
  fontSizeLabel.addEventListener('click', () => applyFontSize(FONT_DEFAULT));

  btnNavBack.addEventListener('click', navBack);
  btnNavFwd.addEventListener('click',  navForward);
  btnFlag.addEventListener('click',    toggleFlag);
  btnFullview.addEventListener('click', toggleFullview);
  btnPrint.addEventListener('click', printActivePreview);

  // Find bar
  findInput.addEventListener('input', () => runFind(findInput.value.trim()));
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { e.preventDefault(); closeFindBar(); }
  });
  findPrev.addEventListener('click', () => findStep(-1));
  findNext.addEventListener('click', () => findStep(1));
  findClose.addEventListener('click', closeFindBar);
  btnEdit.addEventListener('click',    enterEditMode);
  btnSave.addEventListener('click',    saveFile);
  btnDiscard.addEventListener('click', () => { state.tabDirty[state.activeTabPath] = false; delete state.tabEditorText[state.activeTabPath]; renderTabBar(); exitEditMode(false); });

  editor.addEventListener('input', () => {
    if (state.activeTabPath) {
      state.tabDirty[state.activeTabPath] = true;
      renderTabBar(); // show dirty dot
    }
    scheduleLivePreview();
  });

  document.getElementById('editor-toolbar').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-cmd]');
    if (btn) applyEditorCmd(btn.dataset.cmd);
  });

  editor.addEventListener('scroll', syncScrollEditorToPreview);
  previewContent.addEventListener('scroll', () => { if (state.isEditing) syncScrollPreviewToEditor(); });

  tagInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') { await addTag(tagInput.value); tagInput.value = ''; }
  });

  noteInput.addEventListener('change', () => saveNote(noteInput.value));

  searchInput.addEventListener('input', () => applySearch(searchInput.value));
  btnFulltext.addEventListener('click', toggleFulltextPanel);
  fulltextInput.addEventListener('input', scheduleFulltextSearch);

  // Image toggle
  btnShowImages.classList.toggle('active', state.showImages);
  btnShowImages.addEventListener('click', () => {
    state.showImages = !state.showImages;
    localStorage.setItem('showImages', state.showImages ? '1' : '0');
    btnShowImages.classList.toggle('active', state.showImages);
    refreshTree();
  });

  // Context menu: close on outside click / Escape
  document.addEventListener('click', hideContextMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); }, true);

  // Right-click on empty tree area → create in root
  fileTree.addEventListener('contextmenu', (e) => {
    if (!state.currentRoot) return;
    e.preventDefault();
    showContextMenu(e, [
      { label: '新規ファイル', action: () => fsCreateFile(state.currentRoot) },
      { label: '新規フォルダ', action: () => fsCreateFolder(state.currentRoot) },
    ]);
  });

  document.addEventListener('keydown', handleKey);

  initResize();
  initOutlineResize();
  initDragDrop();
  bindImageViewer();
  initStatusAndSettings();
}

// ---- Status bar & settings panel -----------------------------------------

let _statusCache = null;

function formatUptime(sec) {
  if (sec == null) return '-';
  if (sec < 60)   return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h${m}m`;
}

function shortPath(p, max = 60) {
  if (!p) return '(未選択)';
  if (p.length <= max) return p;
  return '…' + p.slice(p.length - max + 1);
}

async function refreshStatus() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) return;
    _statusCache = await res.json();
  } catch { /* ignore network errors */ }
  renderStatusBar();
  if (!settingsPanel.classList.contains('hidden')) renderSettingsPanel();
}

function renderStatusBar() {
  if (!_statusCache) return;
  const s = _statusCache;
  statusPort.textContent   = `${s.host}:${s.port}${s.mode === 'lan' ? ' (LAN)' : ''}`;
  statusFolder.textContent = s.currentMode === 'url'
    ? `🌐 ${shortPath(s.currentUrl)}`
    : `📂 ${shortPath(s.currentFolder)}`;
  statusPid.textContent    = `PID ${s.pid}`;
  statusUptime.textContent = `稼働 ${formatUptime(s.uptimeSec)}`;
}

function renderSettingsPanel() {
  if (!_statusCache) return;
  const s = _statusCache;
  const dl = (rows) => rows.map(([k, v]) => `<dt>${k}</dt><dd>${v ?? '-'}</dd>`).join('');

  $('settings-server').innerHTML = dl([
    ['アドレス',     `${s.host}:${s.port}`],
    ['ネットワーク', s.mode === 'lan' ? 'LAN 公開' : 'ローカルのみ'],
    ['稼働時間',     formatUptime(s.uptimeSec)],
    ['現在のフォルダ', s.currentFolder ?? '(未選択)'],
  ]);
  $('settings-process').innerHTML = dl([
    ['PID',          s.pid],
    ['Node',         s.nodeVersion],
    ['プラットフォーム', `${s.platform} (${s.arch})`],
    ['配布形式',     s.isPackaged ? 'exe (pkg)' : 'Node.js'],
    ['実行ファイル', s.execPath],
  ]);
  $('settings-paths').innerHTML = dl([
    ['設定ファイル',     s.configPath],
    ['履歴ファイル',     s.globalConfigPath],
  ]);
}

function openSettings() {
  settingsPanel.classList.remove('hidden');
  refreshStatus();
}
function closeSettings() {
  settingsPanel.classList.add('hidden');
}

// 印刷時の見出し改ページ設定を body 属性へ反映する。CSS (@media print) が
// この属性を見て改ページするため、アプリの印刷ボタンでもブラウザの Ctrl+P でも効く。
function applyPrintPageBreak(level) {
  state.printPageBreak = level;
  localStorage.setItem('printPageBreak', level);
  if (level && level !== '0') document.body.dataset.printPb = level;
  else delete document.body.dataset.printPb;
}

// 印刷の ON/OFF トグル設定。チェック状態を localStorage と body 属性へ反映する
// (style.css の @media print が body[data-...] を見て効く)。
// dataset.X ↔ data-x (例: printHeadingKeep ↔ data-print-heading-keep)。
const PRINT_TOGGLES = [
  { id: 'setting-print-hr',           attr: 'printHr',          key: 'printHr',          def: '0' },
  { id: 'setting-print-fm',           attr: 'printFm',          key: 'printFm',          def: '0' },
  { id: 'setting-print-keep',         attr: 'printKeep',        key: 'printKeep',        def: '1' },
  { id: 'setting-print-heading-keep', attr: 'printHeadingKeep', key: 'printHeadingKeep', def: '1' },
  { id: 'setting-print-linkurl',      attr: 'printLinkurl',     key: 'printLinkurl',     def: '0' },
];

function setPrintToggle(t, on) {
  localStorage.setItem(t.key, on ? '1' : '0');
  if (on) document.body.dataset[t.attr] = '1';
  else delete document.body.dataset[t.attr];
}

// 設定パネルのタブ切り替え (印刷 / システム情報)
function initSettingsTabs() {
  const tabs = settingsPanel.querySelectorAll('.settings-tab');
  const panels = settingsPanel.querySelectorAll('.settings-tabpanel');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.toggle('active', t === tab));
      panels.forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab.dataset.tab));
    });
  });
}

function initPrintToggles() {
  for (const t of PRINT_TOGGLES) {
    const el = $(t.id);
    if (!el) continue;
    const on = (localStorage.getItem(t.key) ?? t.def) === '1';
    el.checked = on;
    setPrintToggle(t, on);
    el.addEventListener('change', () => setPrintToggle(t, el.checked));
  }
}

function initStatusAndSettings() {
  btnSettings.addEventListener('click', openSettings);
  btnSettingsClose.addEventListener('click', closeSettings);
  settingsPanel.querySelector('.settings-overlay').addEventListener('click', closeSettings);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !settingsPanel.classList.contains('hidden')) closeSettings();
  });

  initSettingsTabs();
  applyPrintPageBreak(state.printPageBreak);
  settingPrintPb.value = state.printPageBreak;
  settingPrintPb.addEventListener('change', () => applyPrintPageBreak(settingPrintPb.value));
  initPrintToggles();

  refreshStatus();
  setInterval(refreshStatus, 10_000);

  initHeartbeat();
  initWindowBounds();
}

// window モード時、アプリウィンドウの位置・サイズをサーバに保存する。
// 次回起動時に cli.js が --window-size/--window-position で復元する
// (専用プロファイル起動なのでこれらのフラグが確実に効く)。
function initWindowBounds() {
  const report = () => {
    if (!_statusCache?.windowMode) return; // window モードのみ
    const bounds = {
      width:  window.outerWidth,
      height: window.outerHeight,
      x:      window.screenX,
      y:      window.screenY,
    };
    const body = JSON.stringify(bounds);
    // 閉じる瞬間でも確実に送るため sendBeacon を優先
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/window-bounds', new Blob([body], { type: 'application/json' }));
        return;
      }
    } catch { /* fall through */ }
    post('/api/window-bounds', bounds);
  };

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(report, 500);
  });
  window.addEventListener('pagehide', report);
}

// サーバとの生存接続。window モードのサーバはこの接続が全て切れると
// (= ウィンドウを閉じると) 自動終了する。EventSource は切断時に自動再接続
// するため、リロード程度では終了しない。
function initHeartbeat() {
  try {
    const es = new EventSource('/api/heartbeat');
    // onerror 時はブラウザが自動で再接続するので明示処理は不要。
    es.onerror = () => { /* auto-reconnect */ };
  } catch { /* EventSource 非対応環境では何もしない */ }
}

// ---- Drag & drop ---------------------------------------------------------

/** Convert a file:// URI to a native filesystem path */
function fileUriToPath(uri) {
  // file:///C:/foo  → C:/foo  (Windows)
  // file:///home/foo → /home/foo (Unix / macOS)
  const withoutScheme = uri.replace(/^file:\/\//, ''); // → /C:/foo  or  /home/foo
  const decoded = decodeURIComponent(withoutScheme);
  // Windows drive letter: /C:/ pattern
  return /^\/[A-Za-z]:[\\/]/.test(decoded) ? decoded.slice(1) : decoded;
}

function initDragDrop() {
  const overlay = $('drop-overlay');
  let dragDepth = 0; // track enter/leave across child elements

  function hasFiles(dt) {
    return dt && (dt.types.includes('Files') || dt.types.includes('text/uri-list'));
  }

  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    dragDepth++;
    overlay.classList.remove('hidden');
    e.preventDefault();
  });

  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'link';
  });

  document.addEventListener('dragleave', () => {
    dragDepth--;
    if (dragDepth <= 0) { dragDepth = 0; overlay.classList.add('hidden'); }
  });

  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    overlay.classList.add('hidden');

    let path = null;

    // 1. text/uri-list — macOS Finder / Linux ファイルマネージャーはこれを提供する
    const uriList = e.dataTransfer.getData('text/uri-list');
    if (uriList) {
      const first = uriList.split(/\r?\n/).find((l) => l.startsWith('file://'));
      if (first) path = fileUriToPath(first.trim());
    }

    // 2. text/plain — パス文字列をテキストとしてドラッグした場合
    if (!path) {
      const text = (e.dataTransfer.getData('text/plain') ?? '').trim();
      if (text && !text.includes('\n')) path = text;
    }

    if (path) {
      folderInput.value = path;
      await openFolder(path);
      return;
    }

    // 3. Windows Explorer はフォルダドロップ時に URI を渡さない（ブラウザのセキュリティ制限）。
    //    FileSystemEntry API でフォルダ名だけは取得できるので、
    //    履歴とマッチングして補助する。
    const entry = e.dataTransfer.items?.[0]?.webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      const name = entry.name;
      try {
        const config = await get('/api/config');
        const match = (config.history ?? []).find(
          (h) => h === name || h.endsWith('/' + name) || h.endsWith('\\' + name)
        );
        if (match) {
          // 履歴に完全一致パスがあれば自動で開く
          folderInput.value = match;
          await openFolder(match);
          return;
        }
      } catch { /* ignore */ }

      // 一致なし — フォルダ名を入力欄に入れてユーザーに補完してもらう
      folderInput.value = name;
      folderInput.focus();
      folderInput.select();
      showWarning(
        `"${escHtml(name)}" のフルパスが取得できませんでした（ブラウザの制限）。`
        + ` パス入力欄を補完して Enter で開いてください。`,
        'warn'
      );
      return;
    }

    // どの手段でも取得できなかった場合
    showWarning(
      'パスを取得できませんでました。📂ボタンかパス入力欄をご利用ください。',
      'warn'
    );
  });

  // ---- Image drop into editor --------------------------------------------
  function isImageDrag(e) {
    return [...(e.dataTransfer?.items ?? [])].some((i) => i.kind === 'file' && i.type.startsWith('image/'));
  }

  editor.addEventListener('dragenter', (e) => {
    if (isImageDrag(e)) { e.preventDefault(); e.stopPropagation(); }
  });
  editor.addEventListener('dragleave', (e) => {
    if (isImageDrag(e)) { e.stopPropagation(); }
  });
  editor.addEventListener('dragover', (e) => {
    if (isImageDrag(e)) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
    }
  });

  editor.addEventListener('drop', async (e) => {
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();

    if (!state.activeTabPath) return;
    const dir = state.activeTabPath.replace(/[/\\][^/\\]+$/, ''); // folder of current file

    for (const file of files) {
      try {
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        await post('/api/upload-image', { base64, filename: file.name, dir });
        // Image is saved in the same directory as the current file,
        // so use just the filename as the relative path.
        const href = file.name.includes(' ') ? `<${file.name}>` : file.name;
        const ins = `![${file.name.replace(/\.[^.]+$/, '')}](${href})`;
        const pos = editor.selectionStart;
        editor.value = editor.value.slice(0, pos) + ins + editor.value.slice(pos);
        editor.selectionStart = editor.selectionEnd = pos + ins.length;
        editor.dispatchEvent(new Event('input'));
      } catch (err) {
        showWarning(`画像アップロードエラー: ${escHtml(err.message)}`, 'error');
      }
    }
  });
}

// ---- Bootstrap -----------------------------------------------------------
init();
