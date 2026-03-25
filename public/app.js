// MdExplorer — vanilla JS, no build step

// ---- Mermaid init --------------------------------------------------------
mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'loose' });

// ---- State ---------------------------------------------------------------
const state = {
  currentRoot:    null,
  tags:           {},    // { [relativePath]: { tags, flagged, note } }
  theme:          'light',
  searchQuery:    '',
  expandedDirs:   new Set(),

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
const warningBar     = $('warning-bar');
const fileTree       = $('file-tree');
const sidebarFooter  = $('sidebar-footer');
const searchInput    = $('search-input');
const emptyState     = $('empty-state');
const fileView       = $('file-view');
const tabBar         = $('tab-bar');
const fileBreadcrumb = $('file-breadcrumb');
const btnFlag        = $('btn-flag');
const btnEdit        = $('btn-edit');
const btnSave        = $('btn-save');
const btnDiscard     = $('btn-discard');
const tagsList       = $('tags-list');
const tagInput       = $('tag-input');
const noteInput      = $('note-input');
const previewPanel   = $('preview-panel');
const previewContent = $('preview-content');
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
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}
const get  = (p)    => api('GET',  p);
const post = (p, b) => api('POST', p, b);
const put  = (p, b) => api('PUT',  p, b);

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
  fontSizeLabel.style.fontWeight = size === FONT_DEFAULT ? '' : 'bold';
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
    const count = countFiles(data.tree);
    sidebarFooter.textContent = `${count} ファイル`;
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

async function switchToTab(path) {
  if (path === state.activeTabPath) return;

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
  await renderFileContent(tab);
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
    await switchToTab(file.path);
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
  await renderFileContent(tab);
}

async function renderFileContent(tab) {
  showFileView();
  exitEditModeUI(); // reset edit buttons

  updateFileHeader(tab);
  updateTagsBar(tab);
  updateNoteBar(tab);

  previewContent.innerHTML = '<div class="loading">レンダリング中...</div>';

  try {
    const { html } = await get(`/api/preview?path=${encodeURIComponent(tab.path)}`);
    previewContent.innerHTML = html;
    previewPanel.scrollTop = 0;
    await renderMermaid();
    fixLocalLinks();
  } catch (err) {
    previewContent.innerHTML = `<div class="error-msg">エラー: ${escHtml(err.message)}</div>`;
  }
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
  span.textContent = tag;

  const del = document.createElement('button');
  del.className = 'tag-del';
  del.textContent = '×';
  del.title = 'タグを削除';
  del.addEventListener('click', () => removeTag(tag));
  span.appendChild(del);

  return span;
}

async function addTag(tag) {
  tag = tag.trim().toLowerCase().replace(/\s+/g, '-');
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

// ---- Search filter -------------------------------------------------------
function applySearch(query) {
  state.searchQuery = query.toLowerCase();
  const items = fileTree.querySelectorAll('.tree-file');
  let visible = 0;

  items.forEach((el) => {
    const name = (el.querySelector('.file-name')?.textContent ?? '').toLowerCase();
    const rel  = (el.dataset.rel ?? '').toLowerCase();
    const match = !state.searchQuery || name.includes(state.searchQuery) || rel.includes(state.searchQuery);
    el.style.display = match ? '' : 'none';
    if (match) visible++;
  });

  // Expand dirs that have visible children when searching
  fileTree.querySelectorAll('.tree-children').forEach((ul) => {
    if (state.searchQuery) {
      const hasVisible = [...ul.querySelectorAll('.tree-file')].some((el) => el.style.display !== 'none');
      ul.style.display = hasVisible ? '' : 'none';
    }
  });

  const total = items.length;
  sidebarFooter.textContent = state.searchQuery ? `${visible} / ${total} ファイル` : `${total} ファイル`;
}

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
