// Windows PE exe のサブシステムを CONSOLE(3) → GUI(2) に書き換える。
// これにより exe をダブルクリックしてもコンソール窓が出なくなる。
//
// PE フォーマット:
//   - DOS ヘッダ 0x3C: PE シグネチャへのオフセット (UInt32LE)
//   - PE シグネチャ "PE\0\0" (4 byte) + COFF ヘッダ (20 byte) の後が Optional ヘッダ
//   - Optional ヘッダ先頭 +0x44 が Subsystem (UInt16LE)
//   => Subsystem の絶対オフセット = peOffset + 4 + 20 + 0x44 = peOffset + 0x5C
import { readFile, writeFile } from 'fs/promises';

const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3; // console

const target = process.argv[2] ?? 'dist/fastmd-explorer.exe';
const buf = await readFile(target);

if (buf.toString('ascii', 0, 2) !== 'MZ') {
  throw new Error(`${target} は PE 実行ファイルではありません (MZ ヘッダ無し)`);
}

const peOffset = buf.readUInt32LE(0x3c);
if (buf.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
  throw new Error('PE シグネチャが見つかりません');
}

const subsystemOffset = peOffset + 0x5c;
const current = buf.readUInt16LE(subsystemOffset);

if (current === IMAGE_SUBSYSTEM_WINDOWS_GUI) {
  console.log('既に GUI サブシステムです。スキップします。');
  process.exit(0);
}
if (current !== IMAGE_SUBSYSTEM_WINDOWS_CUI) {
  throw new Error(`想定外の Subsystem 値: ${current} (3=console を期待)`);
}

buf.writeUInt16LE(IMAGE_SUBSYSTEM_WINDOWS_GUI, subsystemOffset);
await writeFile(target, buf);
console.log(`${target}: Subsystem を CONSOLE(3) → GUI(2) に書き換えました。`);
