import { build } from 'esbuild';
import { writeFile } from 'fs/promises';

const META_URL_VAR = '__import_meta_url_for_bundle';

// bundle は src/_bundle.cjs に出力する。
// 理由: src/cli.js の `ROOT_DIR = dirname(__dirname)` 計算と整合させるため
// (src の親 = repo-root が ROOT_DIR となり、public/ や node_modules/ にアクセスできる)。
await build({
  entryPoints: ['src/cli.js'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'src/_bundle.cjs',
  // CJS にバンドルすると `import.meta.url` は空になるため、
  // ランタイムで __filename から URL 形式に変換した値で置換する。
  define: {
    'import.meta.url': META_URL_VAR,
  },
  banner: {
    js: `const ${META_URL_VAR} = require('url').pathToFileURL(__filename).href;`,
  },
});

// pkg は entry の隣にある .pkgrc.json を auto-discover するので、
// src/_bundle.cjs と並べて src/.pkgrc.json を生成する。
// assets パスは src/ ディレクトリからの相対パス (= `../<repo-root-relative>`)。
// server.js が /vendor で配信する依存はすべてここに列挙する
// (列挙漏れがあると dev では動くが exe で 404 になる)。
const pkgrc = {
  assets: [
    '../public/**/*',
    '../node_modules/mermaid/dist/mermaid.min.js',
    '../node_modules/cytoscape/dist/cytoscape.min.js',
    '../node_modules/highlight.js/styles/github.css',
    '../node_modules/highlight.js/styles/github-dark.css',
    '../node_modules/katex/dist/katex.min.css',
    '../node_modules/katex/dist/fonts/*.woff2',
    '../mdexplorer.config.json.sample',
    'picker.ps1',
  ],
};
await writeFile('src/.pkgrc.json', JSON.stringify(pkgrc, null, 2));
