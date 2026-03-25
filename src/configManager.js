import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

// Global user data (history, last folder)
const GLOBAL_DIR  = join(homedir(), '.mdexplorer');
const GLOBAL_FILE = join(GLOBAL_DIR, 'config.json');

// Local project config (port, network, theme) — searched in cwd
const LOCAL_FILE = join(process.cwd(), 'mdexplorer.config.json');

const MAX_HISTORY = 20;

const DEFAULTS = {
  port:    13847,
  network: 'local',   // 'local' | 'lan'
  theme:   'light',
};

let _global = null;   // persisted user data
let _local  = null;   // mdexplorer.config.json (read-only at runtime)

// ---- Local config (mdexplorer.config.json) --------------------------------

export async function loadLocalConfig() {
  try {
    const data = await readFile(LOCAL_FILE, 'utf8');
    _local = JSON.parse(data);
  } catch {
    _local = {};
  }
  return _local;
}

/** Merged server settings: defaults < local config < (no CLI args yet) */
export function serverConfig() {
  return {
    port:    _local?.port    ?? DEFAULTS.port,
    network: _local?.network ?? DEFAULTS.network,
    theme:   _local?.theme   ?? DEFAULTS.theme,
  };
}

// ---- Global user config (history, lastFolder) ----------------------------

export async function loadConfig() {
  try {
    const data = await readFile(GLOBAL_FILE, 'utf8');
    _global = { history: [], ...(JSON.parse(data)) };
  } catch {
    _global = { history: [] };
  }
  return _global;
}

export async function saveConfig(config) {
  _global = config;
  await mkdir(GLOBAL_DIR, { recursive: true });
  await writeFile(GLOBAL_FILE, JSON.stringify(config, null, 2), 'utf8');
}

export async function addFolderToHistory(folderPath) {
  const config = _global ?? await loadConfig();
  const history = config.history.filter((h) => h !== folderPath);
  history.unshift(folderPath);
  if (history.length > MAX_HISTORY) history.splice(MAX_HISTORY);
  config.history   = history;
  config.lastFolder = folderPath;
  await saveConfig(config);
  return config;
}

export function getConfig() {
  return _global ?? { history: [] };
}
