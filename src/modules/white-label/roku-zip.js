// ZIP format encoder in Node core only; no external archiver and no shell commands.
// Zip source packages are NOT signed .pkg files. The physical Roku device signs .pkg.
import { deflateRawSync } from 'node:zlib';

const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  return c >>> 0;
});
export function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function buildZip(files) {
  const local = [], central = [];
  let offset = 0;
  if (files.length > 2000) throw Error('Pacote possui arquivos demais.');
  const seen = new Set();
  for (const file of files) {
    const name = file.path.replaceAll('\\', '/');
    if (!/^[\w./-]+$/.test(name) || name.startsWith('/') || name.split('/').includes('..') || seen.has(name))
      throw Error('Nome de arquivo inseguro ou duplicado no ZIP.');
    seen.add(name);
    const source = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    if (source.length > 8_000_000) throw Error('Arquivo grande demais para Roku.');
    const encoded = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(source, { level: 6 });
    const crc = crc32(source);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(compressed.length, 18);
    head.writeUInt32LE(source.length, 22); head.writeUInt16LE(encoded.length, 26);
    local.push(head, encoded, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(8, 10); directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(source.length, 24);
    directory.writeUInt16LE(encoded.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, encoded);
    offset += head.length + encoded.length + compressed.length;
  }
  const centralLength = central.reduce((sum, part) => sum + part.length, 0);
  if (offset + centralLength > 70_000_000) throw Error('ZIP excede limite do gerador.');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
