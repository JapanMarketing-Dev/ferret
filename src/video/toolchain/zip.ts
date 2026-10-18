import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { ToolchainError } from './errors.js';

// Minimal zip extractor (stored + deflate, no zip64). GNU tar on Linux cannot read zip, and we do not want to
// depend on `unzip` being installed. Entries are read from the central directory; paths may not escape `dest`.

export async function extractZip(file: string, dest: string): Promise<void> {
  const buf = await readFile(file);
  // end of central directory: signature 0x06054b50 within the last 64 KiB + 22 bytes
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ToolchainError('extract', 'not a zip file (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new ToolchainError('extract', 'zip64 archives are not supported');
  const root = normalize(dest) + sep;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ToolchainError('extract', 'corrupt zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    const out = normalize(join(dest, name));
    if (!out.startsWith(root) && out + sep !== root) throw new ToolchainError('extract', `zip entry escapes the target: ${name}`);
    if (name.endsWith('/')) {
      await mkdir(out, { recursive: true });
      continue;
    }
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new ToolchainError('extract', `corrupt zip entry: ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    let data: Buffer;
    try {
      if (method === 0) data = raw;
      else if (method === 8) data = inflateRawSync(raw);
      else throw new ToolchainError('extract', `unsupported zip compression ${method}: ${name}`);
    } catch (e) {
      throw e instanceof ToolchainError ? e : new ToolchainError('extract', `cannot inflate ${name}: ${(e as Error).message}`);
    }
    if (data.length !== usize) throw new ToolchainError('extract', `size mismatch in ${name}`);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, data);
  }
}
