// exe をビルドする (pnpm run build:exe)。
//
// exe にアイコンと版情報を入れるため、pkg が包む前の Node 本体に入れる。
// 包んだあとの exe を書き換えてはいけない: pkg は同梱データの位置を
// ファイル先頭からの絶対位置で exe に埋め込んでおり、リソースの大きさが
// 変わると位置がずれて起動できなくなる。
//
// 1. pkg-fetch で正規の Node 本体を用意する (取得時にハッシュを照合済み)
// 2. .cache/pkg-base/ に複製し、アイコン (assets/icon.ico) と版情報を書き込む
// 3. PKG_NODE_PATH でその複製を指定して pkg を実行する
import { readFile, writeFile, mkdir } from 'fs/promises';
import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import * as ResEdit from 'resedit';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TARGET = 'node22-win-x64';
const OUTPUT = 'dist/fastmd-explorer.exe';

const require = createRequire(import.meta.url);
const pkgDir = dirname(require.resolve('@yao-pkg/pkg/package.json'));
const pkgRequire = createRequire(join(pkgDir, 'package.json'));
const { need } = pkgRequire('@yao-pkg/pkg-fetch');

const appPkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));

// 1. 正規の Node 本体
const base = await need({ nodeRange: 'node22', platform: 'win', arch: 'x64' });

// 2. 複製にアイコンと版情報を入れる
const exe = ResEdit.NtExecutable.from(await readFile(base), { ignoreCert: true });
const res = ResEdit.NtExecutableResource.from(exe);

const ico = ResEdit.Data.IconFile.from(await readFile(join(ROOT, 'assets', 'icon.ico')));
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
// Node の既存のアイコングループを置き換える (無ければ 1 番で足す)
const targets = groups.length ? groups : [{ id: 1, lang: 1033 }];
for (const g of targets) {
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries, g.id, g.lang, ico.icons.map((i) => i.data));
}

// 版情報: 「プログラムから開く」の一覧やタスクバーに出る名前
const [maj, min, pat] = appPkg.version.split('.').map(Number);
const versions = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
const vi = versions[0] ?? ResEdit.Resource.VersionInfo.createEmpty();
const lang = vi.getAllLanguagesForStringValues()[0] ?? { lang: 1033, codepage: 1200 };
vi.setFileVersion(maj, min, pat, 0, lang.lang);
vi.setProductVersion(maj, min, pat, 0, lang.lang);
vi.setStringValues(lang, {
  FileDescription: 'fastmd-explorer',
  ProductName: 'fastmd-explorer',
  InternalName: 'fastmd-explorer',
  OriginalFilename: 'fastmd-explorer.exe',
  CompanyName: '',
  LegalCopyright: '',
  FileVersion: appPkg.version,
  ProductVersion: appPkg.version,
});
vi.outputToResourceEntries(res.entries);

res.outputResource(exe);
const cacheDir = join(ROOT, '.cache', 'pkg-base');
await mkdir(cacheDir, { recursive: true });
const patched = join(cacheDir, `${basename(base)}-fastmd.exe`);
await writeFile(patched, Buffer.from(exe.generate()));
console.log(`base: ${base}\n  -> ${patched} (icon + version ${appPkg.version})`);

// 3. pkg
const pkgBin = join(pkgDir, 'lib-es5', 'bin.js');
const r = spawnSync(process.execPath,
  [pkgBin, 'src/_bundle.cjs', '--targets', TARGET, '--output', OUTPUT],
  { cwd: ROOT, stdio: 'inherit', env: { ...process.env, PKG_NODE_PATH: patched } });
process.exit(r.status ?? 1);
