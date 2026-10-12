const lz4 = require("lz4js");

function readCString(buf, offset) {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  return { value: buf.toString("utf8", offset, end), offset: end + 1 };
}

function align(offset, n) {
  const m = offset % n;
  return m === 0 ? offset : offset + (n - m);
}

function decompressLz4(src, uncompressedSize) {
  const dst = new Uint8Array(uncompressedSize);
  const n = lz4.decompressBlock(src, dst, 0, src.length, 0);
  if (n !== uncompressedSize) {
    throw new Error(`lz4 size mismatch got ${n} expected ${uncompressedSize}`);
  }
  return Buffer.from(dst.buffer, dst.byteOffset, n);
}

function parseUnityFS(buf) {
  let o = 0;
  const sig = readCString(buf, o);
  o = sig.offset;
  if (sig.value !== "UnityFS") throw new Error("not UnityFS: " + sig.value);
  const version = buf.readUInt32BE(o); o += 4;
  const unityVersion = readCString(buf, o); o = unityVersion.offset;
  const revision = readCString(buf, o); o = revision.offset;
  const size = buf.readBigUInt64BE(o); o += 8;
  const compressedBlocksInfoSize = buf.readUInt32BE(o); o += 4;
  const uncompressedBlocksInfoSize = buf.readUInt32BE(o); o += 4;
  const flags = buf.readUInt32BE(o); o += 4;

  if (version >= 7) o = align(o, 16);

  const compression = flags & 0x3f;
  const infoAtEnd = (flags & 0x80) !== 0;
  const padAtStart = (flags & 0x200) !== 0;
  let infoBuf;
  let dataStart;
  if (infoAtEnd) {
    const infoOff = Number(size) - compressedBlocksInfoSize;
    infoBuf = buf.subarray(infoOff, infoOff + compressedBlocksInfoSize);
    dataStart = o;
  } else {
    infoBuf = buf.subarray(o, o + compressedBlocksInfoSize);
    dataStart = o + compressedBlocksInfoSize;
  }
  if (padAtStart) dataStart = align(dataStart, 16);

  let info;
  if (compression === 0) info = infoBuf;
  else if (compression === 2 || compression === 3) info = decompressLz4(infoBuf, uncompressedBlocksInfoSize);
  else throw new Error("unsupported blocks info compression " + compression);

  let p = 16; // hash
  const blockCount = info.readInt32BE(p); p += 4;
  const blocks = [];
  for (let i = 0; i < blockCount; i++) {
    const uncompressedSize = info.readUInt32BE(p); p += 4;
    const compressedSize = info.readUInt32BE(p); p += 4;
    const bflags = info.readUInt16BE(p); p += 2;
    blocks.push({ uncompressedSize, compressedSize, flags: bflags });
  }
  const nodeCount = info.readInt32BE(p); p += 4;
  const nodes = [];
  for (let i = 0; i < nodeCount; i++) {
    const offset = info.readBigInt64BE(p); p += 8;
    const nsize = info.readBigInt64BE(p); p += 8;
    const nflags = info.readUInt32BE(p); p += 4;
    const path = readCString(info, p); p = path.offset;
    nodes.push({ offset: Number(offset), size: Number(nsize), flags: nflags, path: path.value });
  }

  const parts = [];
  let cursor = dataStart;
  for (const b of blocks) {
    const chunk = buf.subarray(cursor, cursor + b.compressedSize);
    cursor += b.compressedSize;
    const bc = b.flags & 0x3f;
    if (bc === 0) parts.push(chunk);
    else if (bc === 2 || bc === 3) parts.push(decompressLz4(chunk, b.uncompressedSize));
    else throw new Error("unsupported block compression " + bc);
  }
  const data = Buffer.concat(parts);
  return {
    version,
    unityVersion: unityVersion.value,
    revision: revision.value,
    flags,
    padAtStart,
    dataStart,
    blocks,
    nodes,
    data,
  };
}

function extractNode(bundle, node) {
  return bundle.data.subarray(node.offset, node.offset + node.size);
}

module.exports = { parseUnityFS, extractNode };
