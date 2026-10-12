function expand565(c) {
  const r = (c >> 11) & 31;
  const g = (c >> 5) & 63;
  const b = c & 31;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

function decodeDxt1Block(src, p, colors) {
  const c0 = src.readUInt16LE(p);
  const c1 = src.readUInt16LE(p + 2);
  const bits = src.readUInt32LE(p + 4);
  const a = expand565(c0);
  const b = expand565(c1);
  colors[0] = [a[0], a[1], a[2], 255];
  colors[1] = [b[0], b[1], b[2], 255];
  if (c0 > c1) {
    colors[2] = [
      (2 * a[0] + b[0] + 1) / 3 | 0,
      (2 * a[1] + b[1] + 1) / 3 | 0,
      (2 * a[2] + b[2] + 1) / 3 | 0,
      255,
    ];
    colors[3] = [
      (a[0] + 2 * b[0] + 1) / 3 | 0,
      (a[1] + 2 * b[1] + 1) / 3 | 0,
      (a[2] + 2 * b[2] + 1) / 3 | 0,
      255,
    ];
  } else {
    colors[2] = [(a[0] + b[0]) / 2 | 0, (a[1] + b[1]) / 2 | 0, (a[2] + b[2]) / 2 | 0, 255];
    colors[3] = [0, 0, 0, 0];
  }
  return bits;
}

function decodeDXT1(src, w, h) {
  const out = Buffer.alloc(w * h * 4);
  const bw = Math.ceil(w / 4);
  const bh = Math.ceil(h / 4);
  const colors = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  let p = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const bits = decodeDxt1Block(src, p, colors);
      p += 8;
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px;
          const y = by * 4 + py;
          if (x >= w || y >= h) continue;
          const idx = (bits >>> (2 * (py * 4 + px))) & 3;
          const c = colors[idx];
          const o = (y * w + x) * 4;
          out[o] = c[0];
          out[o + 1] = c[1];
          out[o + 2] = c[2];
          out[o + 3] = c[3];
        }
      }
    }
  }
  return out;
}

function decodeDXT5(src, w, h) {
  const out = Buffer.alloc(w * h * 4);
  const bw = Math.ceil(w / 4);
  const bh = Math.ceil(h / 4);
  const colors = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const alpha = new Array(8);
  let p = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const a0 = src[p];
      const a1 = src[p + 1];
      const abits = BigInt(src.readUInt32LE(p + 2)) | (BigInt(src.readUInt16LE(p + 6)) << 32n);
      p += 8;
      alpha[0] = a0;
      alpha[1] = a1;
      if (a0 > a1) {
        for (let i = 1; i <= 6; i++) alpha[i + 1] = ((7 - i) * a0 + i * a1 + 3) / 7 | 0;
      } else {
        for (let i = 1; i <= 4; i++) alpha[i + 1] = ((5 - i) * a0 + i * a1 + 2) / 5 | 0;
        alpha[6] = 0;
        alpha[7] = 255;
      }
      const bits = decodeDxt1Block(src, p, colors);
      p += 8;
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px;
          const y = by * 4 + py;
          if (x >= w || y >= h) continue;
          const pi = py * 4 + px;
          const ci = (bits >>> (2 * pi)) & 3;
          const ai = Number((abits >> BigInt(3 * pi)) & 7n);
          const c = colors[ci];
          const o = (y * w + x) * 4;
          out[o] = c[0];
          out[o + 1] = c[1];
          out[o + 2] = c[2];
          out[o + 3] = alpha[ai];
        }
      }
    }
  }
  return out;
}

function decodeTexture(format, src, w, h) {
  if (format === 10) return decodeDXT1(src, w, h);
  if (format === 12) return decodeDXT5(src, w, h);
  if (format === 4) return Buffer.from(src.subarray(0, w * h * 4));
  return null;
}

module.exports = { decodeTexture };
