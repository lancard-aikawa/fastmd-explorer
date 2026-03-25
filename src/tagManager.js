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
  if (tags[oldRelative]) {
    tags[newRelative] = tags[oldRelative];
    delete tags[oldRelative];
    await saveTags(rootPath, tags);
  }
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
