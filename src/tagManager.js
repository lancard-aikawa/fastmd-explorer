import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, normalize } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';

// Tags are stored in ~/.mdexplorer/tags/{hash}.json
// where hash = SHA1 of the normalized root path (lowercase, forward slashes)
// This keeps user data folders clean.

const TAGS_DIR = join(homedir(), '.mdexplorer', 'tags');

function rootHash(rootPath) {
  const key = normalize(rootPath).toLowerCase().replace(/\\/g, '/');
  return createHash('sha1').update(key).digest('hex');
}

function tagsFile(rootPath) {
  return join(TAGS_DIR, rootHash(rootPath) + '.json');
}

// Legacy path (old location inside the root folder)
function legacyTagsFile(rootPath) {
  return join(rootPath, '.mdexplorer', 'tags.json');
}

export async function loadTags(rootPath) {
  // Try new location first
  try {
    const data = await readFile(tagsFile(rootPath), 'utf8');
    return JSON.parse(data);
  } catch { /* not found yet */ }

  // Migrate from legacy location if exists
  try {
    const data = await readFile(legacyTagsFile(rootPath), 'utf8');
    const tags = JSON.parse(data);
    await saveTags(rootPath, tags); // write to new location
    return tags;
  } catch { /* no legacy either */ }

  return {};
}

export async function saveTags(rootPath, tags) {
  await mkdir(TAGS_DIR, { recursive: true });
  await writeFile(tagsFile(rootPath), JSON.stringify(tags, null, 2), 'utf8');
}

export async function renameFileTags(rootPath, oldRelative, newRelative) {
  const tags = await loadTags(rootPath);
  const normOld = oldRelative.replace(/\\/g, '/');
  let changed = false;
  for (const key of Object.keys(tags)) {
    const normKey = key.replace(/\\/g, '/');
    if (normKey === normOld) {
      tags[newRelative] = tags[key];
      if (key !== newRelative) delete tags[key];
      changed = true;
    } else if (normKey.startsWith(normOld + '/')) {
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
  const entry = tags[relativePath];
  if (!entry.flagged && entry.tags.length === 0 && !entry.note) {
    delete tags[relativePath];
  }
  await saveTags(rootPath, tags);
  return tags[relativePath] ?? null;
}
