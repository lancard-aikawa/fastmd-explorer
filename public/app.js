// fastmd-explorer — vanilla JS, no build step

// ---- Mermaid init --------------------------------------------------------
mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'loose' });

// ---- State ---------------------------------------------------------------
const state = {
  currentRoot:    null,
  tags:           {},    // { [relativePath]: { tags, flagged, note } }
  theme:          'light',
  searchQuery:    '',
  expandedDirs:   new Set(),
  filterTags:     new Set(),  // active tag filters
  filterFlagged:  false,

  // Tabs
  tabs:           [],    // [{ path, relativePath, name }]
  activeTabPath:  null,
  tabDirty:       {},    // { [path]: boolean }
  tabEditorText:  {},    // { [path]: string } — saved when switching away in edit mode
  isEditing:      false,
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
const btnTheme       = $('btn-theme');
const tagFilterBar   = $('tag-filter-bar');
const warningBar     = $('warning-bar');
const fileTree       = $('file-tree');
const sidebarFooter  = $('sidebar-footer');
const searchInput    = $('search-input');
const btnFulltext    = $('btn-fulltext');
const fulltextPanel  = $('fulltext-panel');
const fulltextInput  = $('fulltext-input');
const fulltextResults = $('fulltext-results');
const emptyState     = $('empty-state');
const fileView       = $('file-view');
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
const previewPanel   = $('preview-panel');
const previewContent = $('preview-content');
const outlinePanel   = $('outline-panel');
const editorPanel    = $('editor-panel');
const editor         = $('editor');
const hljsTheme      = $('hljs-theme');
const sidebar        = $('sidebar');
const resizeHandle   = $('resize-handle');

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
    state.theme = config.theme ?? 'light';
    applyTheme(state.theme);
    initFontSize();
    populateHistory(config.history ?? []);

    if (config.currentRoot) {
      state.currentRoot = config.currentRoot;
      folderInput.value = config.currentRoot;
      await refreshTree();
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
  mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: theme === 'dark' ? 'dark' : 'default' });
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
    // Save current tab state before switching folder
    if (state.currentRoot) saveTabState(state.currentRoot);

    const res = await post('/api/folder', { path });
    state.currentRoot = res.path;
    state.tags = {};
    state.tabDirty = {};
    state.tabEditorText = {};
    state.isEditing = false;
    state.filterTags.clear();
    state.filterFlagged = false;
    state.searchQuery = '';
    searchInput.value = '';
    folderInput.value = res.path;
    populateHistory(res.config.history ?? []);

    // Restore saved tab state for this folder
    const saved = loadTabState(res.path);
    state.tabs = saved?.tabs ?? [];
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

// ---- Tab state persistence -----------------------------------------------

function saveTabState(folderPath) {
  if (!folderPath) return;
  const data = {
    tabs: state.tabs.map(({ path, relativePath, name }) => ({ path, relativePath, name })),
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

// ---- File tree -----------------------------------------------------------
async function refreshTree() {
  fileTree.innerHTML = '<div class="loading">読み込み中...</div>';
  sidebarFooter.textContent = 'スキャン中...';
  try {
    const data = await get('/api/files');
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

    renderTreeNode(data.tree, fileTree, false);
    renderTagFilterBar();
    applySearch(state.searchQuery);
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
    } else {
      li.appendChild(makeFileEl(child));
    }
    ul.appendChild(li);
  });
}

function makeDirEl(dir, forceExpand = false) {
  const id = dir.path;
  const expanded = forceExpand || state.expandedDirs.has(id);

  const frag = document.createDocumentFragment();

  const row = document.createElement('div');
  row.className = 'tree-dir';
  row.innerHTML = `<span class="dir-arrow">${expanded ? '▾' : '▸'}</span><span class="dir-name">${escHtml(dir.name)}</span>`;

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
  const tab = { path: file.path, relativePath: file.relativePath, name: file.name };
  state.tabs.push(tab);
  state.activeTabPath = file.path;
  state.isEditing = false;

  renderTabBar();
  updateTreeActiveState();
  await renderFileContent(tab, file.highlight ?? null);
}

async function renderFileContent(tab, highlight = null) {
  showFileView();
  exitEditModeUI(); // reset edit buttons

  updateFileHeader(tab);
  updateTagsBar(tab);
  updateNoteBar(tab);

  previewContent.innerHTML = '<div class="loading">レンダリング中...</div>';
  fileInfoBar.textContent = '';
  outlinePanel.innerHTML = '';

  try {
    const { html, mtime, charCount } = await get(`/api/preview?path=${encodeURIComponent(tab.path)}`);
    previewContent.innerHTML = html;
    previewPanel.scrollTop = 0;
    await renderMermaid();
    fixLocalLinks();
    if (highlight) highlightInPreview(highlight);
    updateFileInfo(mtime, charCount);
    updateOutline();
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

function updateOutline() {
  outlinePanel.innerHTML = '';

  // 折り畳みストリップ（常に表示）
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

  const headings = [...previewContent.querySelectorAll('h1,h2,h3,h4')];
  if (!headings.length) return;

  headings.forEach((h) => {
    const level = parseInt(h.tagName[1]);
    const a = document.createElement('a');
    a.className = `outline-item outline-h${level}`;
    a.textContent = h.textContent;
    a.href = '#';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      h.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    outlinePanel.appendChild(a);
  });
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
  nodes.forEach((el) => {
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
  initMermaidZoom();
}

function initMermaidZoom() {
  previewContent.querySelectorAll('.mermaid').forEach((container) => {
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
        openFile({ path: resolvedNative, relativePath: rel, name: href.split('/').pop() });
      } else {
        window.open(href, '_blank', 'noreferrer');
      }
    });
  });
}

// ---- Edit mode -----------------------------------------------------------
async function enterEditMode() {
  if (!state.activeTabPath) return;
  state.isEditing = true;

  previewPanel.classList.add('hidden');
  editorPanel.classList.remove('hidden');
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
      } catch { /* ignore */ }
    }
  }
}

function exitEditModeUI() {
  state.isEditing = false;
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

  // Show/hide dirs based on matching files; restore collapsed state when cleared
  fileTree.querySelectorAll('.tree-children').forEach((ul) => {
    const dirRow = ul.previousElementSibling;
    if (isFiltering) {
      const hasVisible = [...ul.querySelectorAll('.tree-file')].some((el) => el.style.display !== 'none');
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
  fileView.classList.remove('hidden');
}

function showEmptyState() {
  fileView.classList.add('hidden');
  emptyState.classList.remove('hidden');
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

// ---- Keyboard shortcuts --------------------------------------------------
function handleKey(e) {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) {
    if (e.key === 'Escape') {
      if (state.isEditing) exitEditMode(false);
      else if (searchInput.value) { searchInput.value = ''; applySearch(''); }
    }
    return;
  }
  if (e.key === 'r') { e.preventDefault(); btnRefresh.click(); }
  if (e.key === 'f') { e.preventDefault(); searchInput.focus(); searchInput.select(); }
  if (e.key === 'g') { e.preventDefault(); toggleFulltextPanel(); }
  if (e.key === 's' && state.isEditing) { e.preventDefault(); saveFile(); }
  if (e.key === 'e' && !state.isEditing && state.activeTabPath) { e.preventDefault(); enterEditMode(); }
  if (e.key === 'i' && state.activeTabPath) { e.preventDefault(); toggleFlag(); }
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
  btnOpen.addEventListener('click', () => openFolder(folderInput.value));
  folderInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') openFolder(folderInput.value); });

  historySelect.addEventListener('change', () => {
    const val = historySelect.value;
    if (val) { folderInput.value = val; openFolder(val); historySelect.value = ''; }
  });

  btnRefresh.addEventListener('click', async () => {
    if (!state.currentRoot) return;
    await post('/api/refresh');
    await refreshTree();
  });

  btnTheme.addEventListener('click', () => applyTheme(state.theme === 'light' ? 'dark' : 'light'));

  btnFontDown.addEventListener('click', () => {
    const cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--preview-font-size'), 10) || FONT_DEFAULT;
    applyFontSize(Math.max(cur - FONT_STEP, FONT_MIN));
  });
  btnFontUp.addEventListener('click', () => {
    const cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--preview-font-size'), 10) || FONT_DEFAULT;
    applyFontSize(Math.min(cur + FONT_STEP, FONT_MAX));
  });
  fontSizeLabel.addEventListener('click', () => applyFontSize(FONT_DEFAULT));

  btnFlag.addEventListener('click',    toggleFlag);
  btnPrint.addEventListener('click', () => window.print());
  btnEdit.addEventListener('click',    enterEditMode);
  btnSave.addEventListener('click',    saveFile);
  btnDiscard.addEventListener('click', () => { state.tabDirty[state.activeTabPath] = false; delete state.tabEditorText[state.activeTabPath]; renderTabBar(); exitEditMode(false); });

  editor.addEventListener('input', () => {
    if (state.activeTabPath) {
      state.tabDirty[state.activeTabPath] = true;
      renderTabBar(); // show dirty dot
    }
  });

  tagInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') { await addTag(tagInput.value); tagInput.value = ''; }
  });

  noteInput.addEventListener('change', () => saveNote(noteInput.value));

  searchInput.addEventListener('input', () => applySearch(searchInput.value));
  btnFulltext.addEventListener('click', toggleFulltextPanel);
  fulltextInput.addEventListener('input', scheduleFulltextSearch);

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
  initDragDrop();
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
      'パスを取得できませんでした。📂ボタンかパス入力欄をご利用ください。',
      'warn'
    );
  });
}

// ---- Bootstrap -----------------------------------------------------------
init();
