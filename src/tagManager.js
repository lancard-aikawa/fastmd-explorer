import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

// Tags are stored per-root in {root}/.mdexplorer/tags.json
// Schema: { [relativePath]: { tags: string[], flagged: boolean, note: string } }

function tagsFile(rootPath) {
  return join(rootPath, '.mdexplorer', 'tags.json');
}

export async function loadTags(rootPath) {
  try {
    const data = await readFile(tagsFile(rootPath), 'utf8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

export async function saveTags(rootPath, tags) {
  const dir = join(rootPath, '.mdexplorer');
  await mkdir(dir, { recursive: true });
  await writeFile(tagsFile(rootPath), JSON.stringify(tags, null, 2), 'utf8');
}

export async function renameFileTags(rootPath, oldRelative, newRelative) {
  const tags = await loadTags(rootPath);
  // normOld.length === oldRelative.length なのでスライス位置は共通
  const normOld = oldRelative.replace(/\\/g, '/');
  let changed = false;
  for (const key of Object.keys(tags)) {
    const normKey = key.replace(/\\/g, '/');
    if (normKey === normOld) {
      tags[newRelative] = tags[key];
      if (key !== newRelative) delete tags[key];
      changed = true;
    } else if (normKey.startsWith(normOld + '/')) {
      // key の区切り文字をそのまま保持してプレフィックスだけ置換
      const newKey = newRelative + key.slice(oldRelative.length);
      tags[newKey] = tags[key];
      if (key !== newKey) delete tags[key];
      changed = true;
    }
  }
  if (changed) await saveTags(rootPath, tags);
}

export async function updateFileTags(rootPath, relativePath, patch) {
  const tags = await loadTags(rootPath);
  const current = tags[relativePath] ?? { tags: [], flagged: false, note: '' };
  tags[relativePath] = { ...current, ...patch };
  // Clean up empty entries
  const entry = tags[relativePath];
  if (!entry.flagged && entry.tags.length === 0 && !entry.note) {
    delete tags[relativePath];
  }
  await saveTags(rootPath, tags);
  return tags[relativePath] ?? null;
}
