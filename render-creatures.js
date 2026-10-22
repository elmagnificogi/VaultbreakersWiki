const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const { bundleInfo, extractRange, BUNDLE_DIR } = require("./maps");
const { parseUnityFS, extractNode } = require("./unityfs");
const { parseSerialized, readObject } = require("./serialized");
const { decodeTexture } = require("./dxt");

const ROOT = __dirname;

function asString(v) {
  if (typeof v === "string") return v;
  if (!Array.isArray(v) || !v.length || v.length > 140) return "";
  if (!v.every((n) => typeof n === "number" && n >= 32 && n < 127)) return "";
  return Buffer.from(v).toString("utf8");
}

function toBytes(v) {
  if (!v) return Buffer.alloc(0);
  if (Buffer.isBuffer(v)) return v;
  if (Array.isArray(v)) return Buffer.from(v);
  return Buffer.alloc(0);
}

function f16(h) {
  const sign = (h & 0x8000) >> 15;
  const exp = (h & 0x7c00) >> 10;
  const frac = h & 0x03ff;
  if (exp === 0) return (sign ? -1 : 1) * 2 ** -14 * (frac / 1024);
  if (exp === 31) return 0;
  return (sign ? -1 : 1) * 2 ** (exp - 15) * (1 + frac / 1024);
}

function enumOf(asset) {
  return String(asset || "").replace(/ConfigurationAsset$/, "");
}

function iconFile(asset) {
  return "Model_" + enumOf(asset).replace(/[^\w.\-]+/g, "_") + ".png";
}

let indexCache = null;

function buildCabMap() {
  const cabToFile = new Map();
  const files = fs.readdirSync(BUNDLE_DIR).filter((f) => f.endsWith(".bundle"));
  for (const file of files) {
    const fp = path.join(BUNDLE_DIR, file);
    const st = fs.statSync(fp);
    const fd = fs.openSync(fp, "r");
    const head = Buffer.alloc(Math.min(st.size, 512 * 1024));
    fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    let info;
    try { info = bundleInfo(head); } catch { continue; }
    for (const node of info.nodes) {
      const id = (node.path.match(/CAB-[0-9a-f]+/i) || [])[0];
      if (id && !cabToFile.has(id)) cabToFile.set(id, file);
    }
  }
  return cabToFile;
}

function buildIndex() {
  if (indexCache) return indexCache;
  const cabToFile = buildCabMap();
  const visualToFile = new Map();
  const meshToFile = new Map();
  const files = fs.readdirSync(BUNDLE_DIR).filter((f) => f.endsWith(".bundle"));
  for (const file of files) {
    const fp = path.join(BUNDLE_DIR, file);
    const st = fs.statSync(fp);
    if (st.size > 40 * 1024 * 1024) continue;
    let buf;
    let info;
    try { buf = fs.readFileSync(fp); info = bundleInfo(buf); } catch { continue; }
    for (const node of info.nodes) {
      if (node.path.endsWith(".resS") || node.size > 12 * 1024 * 1024 || node.size < 32) continue;
      let data;
      try { data = extractRange(buf, info, node.offset, node.size); } catch { continue; }
      const text = data.toString("latin1");
      for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_]{2,60}_Visual/g)) visualToFile.set(match[0], file);
      for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_]{2,60}_Mesh\b/g)) meshToFile.set(match[0], file);
    }
  }
  indexCache = { cabToFile, visualToFile, meshToFile };
  return indexCache;
}

const bundleCache = new Map();
function loadSerialized(file, cabId) {
  const key = file + "|" + (cabId || "");
  if (bundleCache.has(key)) return bundleCache.get(key);
  const bundle = parseUnityFS(fs.readFileSync(path.join(BUNDLE_DIR, file)));
  const cab = cabId
    ? bundle.nodes.find((n) => n.path.includes(cabId))
    : bundle.nodes.find((n) => !n.path.includes("."));
  const res = bundle.nodes.find((n) => n.path.endsWith(".resS"));
  if (!cab) return null;
  const sf = parseSerialized(extractNode(bundle, cab));
  const resS = res ? extractNode(bundle, res) : Buffer.alloc(0);
  const loaded = { sf, resS, file };
  bundleCache.set(key, loaded);
  return loaded;
}

function cabIdOf(externalPath) {
  return (String(externalPath || "").match(/CAB-[0-9a-f]+/i) || [])[0] || "";
}

function resolveExternal(sf, fileId) {
  if (!fileId) return null;
  const ext = (sf.externals || [])[fileId - 1];
  return cabIdOf(ext && ext.path);
}

function readObjectSafe(sf, obj) {
  try { return readObject(sf, obj).value; } catch { return null; }
}

function collectDraws(sf) {
  const draws = [];
  for (const obj of sf.objects) {
    const value = readObjectSafe(sf, obj);
    if (!value || !value.m_Mesh || !value.m_Mesh.pathId || value.m_Mesh.pathId === "0") continue;
    const mats = Array.isArray(value.m_Materials) ? value.m_Materials : [];
    draws.push({ mesh: value.m_Mesh, material: mats[0] || null });
  }
  const seen = new Set();
  return draws.filter((d) => {
    const key = d.mesh.fileId + ":" + d.mesh.pathId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function textureFromMaterial(matSf, matValue, index) {
  const wanted = [];
  function walk(v) {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    const slot = asString(v["#155"]) || asString(v.first) || "";
    const tex = (v.m_Texture) || (v.SInt16 && v.SInt16.m_Texture);
    if (tex && tex.pathId && tex.pathId !== "0" && /maintex|basemap|basecolormap|albedo/i.test(slot)) wanted.push({ slot, fileId: tex.fileId || 0, pathId: String(tex.pathId) });
    for (const x of Object.values(v)) walk(x);
  }
  walk(matValue.m_SavedProperties || matValue);
  wanted.sort((a, b) => (/base|albedo/i.test(a.slot) ? -1 : 1));
  const hit = wanted[0];
  if (!hit) return null;
  let loaded = { sf: matSf, resS: null };
  if (hit.fileId) {
    const cab = resolveExternal(matSf, hit.fileId);
    if (!cab) return null;
    const file = index.cabToFile.get(cab);
    if (!file) return null;
    loaded = loadSerialized(file, cab);
    if (!loaded) return null;
  } else {
    const cached = [...bundleCache.values()].find((item) => item.sf === matSf);
    loaded = { sf: matSf, resS: cached ? cached.resS : Buffer.alloc(0) };
  }
  for (const obj of loaded.sf.objects) {
    if (hit.pathId && String(obj.pathId) !== hit.pathId) continue;
    const value = readObjectSafe(loaded.sf, obj);
    if (!value || !value.m_Width || value.m_TextureFormat == null) continue;
    const rgba = decodeImage(value, loaded.resS);
    if (rgba) return { rgba, w: value.m_Width, h: value.m_Height };
  }
  for (const obj of loaded.sf.objects) {
    const value = readObjectSafe(loaded.sf, obj);
    if (!value || !value.m_Width || value.m_TextureFormat == null) continue;
    const name = asString(value["#427"]);
    if (name && !/color|albedo|base|diff/i.test(name)) continue;
    const rgba = decodeImage(value, loaded.resS);
    if (rgba) return { rgba, w: value.m_Width, h: value.m_Height };
  }
  return null;
}

function decodeImage(value, resS) {
  const stream = value.m_StreamData;
  const size = stream && Number(stream["#795"] || 0);
  const offset = stream ? Number(stream.offset) : 0;
  let raw = null;
  if (size && offset + size <= resS.length) raw = resS.subarray(offset, offset + size);
  else if (Array.isArray(value["image data"])) raw = Buffer.from(value["image data"]);
  else if (Buffer.isBuffer(value["image data"])) raw = value["image data"];
  if (!raw || !raw.length) return null;
  return decodeTexture(value.m_TextureFormat, raw, value.m_Width, value.m_Height);
}

function channelSize(format, dimension) {
  const unit = { 0: 4, 1: 2, 2: 1, 3: 1, 4: 2, 5: 2, 6: 1, 7: 1, 8: 2, 9: 2, 10: 4, 11: 4 }[format] || 4;
  return unit * dimension;
}

function readComponent(blob, offset, format) {
  if (format === 1) return f16(blob.readUInt16LE(offset));
  if (format === 0) return blob.readFloatLE(offset);
  return 0;
}

function decodeMesh(mesh) {
  const vd = mesh.m_VertexData;
  if (!vd || !vd.m_VertexCount) return null;
  const count = vd.m_VertexCount;
  if (count < 12 || count > 120000) return null;
  const channels = vd.m_Channels || [];
  const strides = [];
  for (const ch of channels) {
    if (!ch.dimension) continue;
    const end = (ch.offset || 0) + channelSize(ch.format, ch.dimension);
    strides[ch.stream] = Math.max(strides[ch.stream] || 0, end);
  }
  const base = [];
  let cursor = 0;
  for (let i = 0; i < strides.length; i++) {
    base[i] = cursor;
    cursor += (strides[i] || 0) * count;
  }
  const blob = toBytes(vd.m_DataSize);
  if (blob.length < cursor) return null;
  const posCh = channels.find((c) => c.dimension >= 3 && c.format === 0);
  const nrmCh = channels.filter((c) => c.dimension >= 3 && c.format === 0)[1] || null;
  const uvCh = channels.find((c) => c.dimension === 2) || null;
  const pos = new Float32Array(count * 3);
  const nrm = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const po = base[posCh.stream] + i * strides[posCh.stream] + posCh.offset;
    pos[i * 3] = readComponent(blob, po, posCh.format);
    pos[i * 3 + 1] = readComponent(blob, po + 4, posCh.format);
    pos[i * 3 + 2] = readComponent(blob, po + 8, posCh.format);
    if (nrmCh) {
      const no = base[nrmCh.stream] + i * strides[nrmCh.stream] + nrmCh.offset;
      nrm[i * 3] = readComponent(blob, no, nrmCh.format);
      nrm[i * 3 + 1] = readComponent(blob, no + (nrmCh.format === 1 ? 2 : 4), nrmCh.format);
      nrm[i * 3 + 2] = readComponent(blob, no + (nrmCh.format === 1 ? 4 : 8), nrmCh.format);
    } else nrm[i * 3 + 2] = 1;
    if (uvCh) {
      const step = uvCh.format === 1 ? 2 : 4;
      const uo = base[uvCh.stream] + i * strides[uvCh.stream] + uvCh.offset;
      uv[i * 2] = readComponent(blob, uo, uvCh.format);
      uv[i * 2 + 1] = readComponent(blob, uo + step, uvCh.format);
    }
  }
  const indices = [];
  const ib = toBytes(mesh.m_IndexBuffer);
  const wide = mesh.m_IndexFormat === 1;
  for (const sub of mesh.m_SubMeshes || []) {
    const start = sub.firstByte || 0;
    const n = sub.indexCount || 0;
    for (let i = 0; i < n; i++) {
      const at = start + i * (wide ? 4 : 2);
      if (at + (wide ? 4 : 2) > ib.length) break;
      indices.push(wide ? ib.readUInt32LE(at) : ib.readUInt16LE(at));
    }
  }
  return { pos, nrm, uv, indices, count };
}

function extentsOf(geo) {
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < geo.count; i++) {
    for (let k = 0; k < 3; k++) {
      const v = geo.pos[i * 3 + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
}

function isGroundDisc(ext) {
  const wide = Math.max(ext[0], ext[1]);
  const flat = ext[2] < wide * 0.22;
  const round = Math.min(ext[0], ext[1]) > wide * 0.72;
  return flat && round && wide > 0.2;
}

function cullPortrait(parts) {
  const info = [];
  for (const part of parts) {
    const ext = extentsOf(part.geo);
    if (isGroundDisc(ext)) continue;
    const span = Math.max(ext[0], ext[1], ext[2]);
    const thin = Math.min(ext[0], ext[1], ext[2]);
    const aura = part.geo.count < 800 && thin > span * 0.7;
    if (!aura) info.push({ part, ext, span, verts: part.geo.count });
  }
  if (!info.length) return cullParts(parts);
  const body = info.slice().sort((a, b) => b.verts - a.verts)[0];
  return info.filter((item) => item === body || (item.verts > 80 && item.span <= body.span * 1.35 && item.span >= body.span * 0.12)).map((item) => item.part);
}

function cullParts(parts) {
  if (parts.length < 2) return parts;
  const info = parts.map((part) => {
    const ext = extentsOf(part.geo);
    const span = Math.max(ext[0], ext[1], ext[2]);
    return { part, span, tall: ext[1] / (Math.max(ext[0], ext[2], 0.001)) };
  });
  const tall = info.filter((item) => item.tall > 0.45);
  const pool = (tall.length ? tall : info).slice().sort((a, b) => a.span - b.span);
  const kept = pool.filter((item) => item.span <= pool[0].span * 3.5);
  return (kept.length ? kept : pool.slice(0, 1)).map((item) => item.part);
}

function paint(parts) {
  let min = [1e9, 1e9, 1e9];
  let max = [-1e9, -1e9, -1e9];
  for (const part of parts) {
    const pos = part.geo.pos;
    for (let i = 0; i < part.geo.count; i++) {
      for (let k = 0; k < 3; k++) {
        const v = pos[i * 3 + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
  }
  const W = 300;
  const H = 380;
  const png = new PNG({ width: W, height: H });
  const zbuf = new Float32Array(W * H).fill(-Infinity);
  const cx = (min[0] + max[0]) * 0.5;
  const cy = (min[1] + max[1]) * 0.5;
  const scale = Math.min((W - 28) / ((max[0] - min[0]) || 1), (H - 28) / ((max[1] - min[1]) || 1));
  const light = [0.15, 0.55, 0.82];
  const llen = Math.hypot(light[0], light[1], light[2]);
  light[0] /= llen; light[1] /= llen; light[2] /= llen;
  for (const part of parts) {
    const { pos, nrm, uv, indices, count } = part.geo;
    const tex = part.tex;
    function sample(u, v) {
      if (!tex) return [176, 148, 118];
      u -= Math.floor(u);
      v -= Math.floor(v);
      const x = Math.max(0, Math.min(tex.w - 1, (u * tex.w) | 0));
      const y = Math.max(0, Math.min(tex.h - 1, ((1 - v) * tex.h) | 0));
      const o = (y * tex.w + x) * 4;
      return [tex.rgba[o], tex.rgba[o + 1], tex.rgba[o + 2]];
    }
    function vert(i) {
      return [(pos[i] - cx) * scale + W / 2, H / 2 - (pos[i + 1] - cy) * scale, pos[i + 2]];
    }
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const ia = indices[t];
      const ib = indices[t + 1];
      const ic = indices[t + 2];
      if (ia >= count || ib >= count || ic >= count) continue;
      const a = vert(ia * 3);
      const b = vert(ib * 3);
      const c = vert(ic * 3);
      const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
      if (Math.abs(area) < 1e-4) continue;
      const nx = nrm[ia * 3] + nrm[ib * 3] + nrm[ic * 3];
      const ny = nrm[ia * 3 + 1] + nrm[ib * 3 + 1] + nrm[ic * 3 + 1];
      const nz = nrm[ia * 3 + 2] + nrm[ib * 3 + 2] + nrm[ic * 3 + 2];
      let nd = (nx * light[0] + ny * light[1] + nz * light[2]) / (Math.hypot(nx, ny, nz) || 1);
      if (area > 0) nd = -nd;
      const shade = 0.45 + Math.max(0, nd) * 0.7;
      const ca = sample(uv[ia * 2], uv[ia * 2 + 1]);
      const cb = sample(uv[ib * 2], uv[ib * 2 + 1]);
      const cc = sample(uv[ic * 2], uv[ic * 2 + 1]);
      const minx = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
      const maxx = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
      const miny = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
      const maxy = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
      if (maxx - minx > 220 && maxy - miny > 280) continue;
      for (let y = miny; y <= maxy; y++) {
        for (let x = minx; x <= maxx; x++) {
          const w0 = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
          const w1 = (c[0] - b[0]) * (y - b[1]) - (c[1] - b[1]) * (x - b[0]);
          const w2 = area - w0 - w1;
          const inside = (w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0);
          if (!inside) continue;
          const z = (w2 * a[2] + w0 * b[2] + w1 * c[2]) / area;
          const p = y * W + x;
          if (z <= zbuf[p]) continue;
          zbuf[p] = z;
          const inv = 1 / area;
          const bw = w0 * inv;
          const cw = w1 * inv;
          const aw = w2 * inv;
          const o = p * 4;
          png.data[o] = Math.min(255, (ca[0] * aw + cb[0] * bw + cc[0] * cw) * shade);
          png.data[o + 1] = Math.min(255, (ca[1] * aw + cb[1] * bw + cc[1] * cw) * shade);
          png.data[o + 2] = Math.min(255, (ca[2] * aw + cb[2] * bw + cc[2] * cw) * shade);
          png.data[o + 3] = 255;
        }
      }
    }
  }
  return trim(png, 12);
}

function trim(png, pad) {
  let minx = png.width, miny = png.height, maxx = 0, maxy = 0, n = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (png.data[(y * png.width + x) * 4 + 3] < 20) continue;
      n++;
      if (x < minx) minx = x;
      if (y < miny) miny = y;
      if (x > maxx) maxx = x;
      if (y > maxy) maxy = y;
    }
  }
  if (n < 40) return null;
  minx = Math.max(0, minx - pad);
  miny = Math.max(0, miny - pad);
  maxx = Math.min(png.width - 1, maxx + pad);
  maxy = Math.min(png.height - 1, maxy + pad);
  const w = maxx - minx + 1;
  const h = maxy - miny + 1;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) png.data.copy(out.data, y * w * 4, ((miny + y) * png.width + minx) * 4, ((miny + y) * png.width + minx + w) * 4);
  return out;
}

function meshByRef(sf, meshRef, index) {
  let targetSf = sf;
  if (meshRef.fileId) {
    const cab = resolveExternal(sf, meshRef.fileId);
    const file = cab && index.cabToFile.get(cab);
    if (!file) return null;
    const loaded = loadSerialized(file, cab);
    if (!loaded) return null;
    targetSf = loaded.sf;
  }
  for (const obj of targetSf.objects) {
    if (String(obj.pathId) !== String(meshRef.pathId)) continue;
    const value = readObjectSafe(targetSf, obj);
    if (value && value.m_VertexData) return value;
  }
  for (const obj of targetSf.objects) {
    const value = readObjectSafe(targetSf, obj);
    if (value && value.m_VertexData && value.m_VertexData.m_VertexCount > 50) return value;
  }
  return null;
}

function textureFor(sf, materialRef, index) {
  if (!materialRef || !materialRef.pathId || materialRef.pathId === "0") return null;
  let matSf = sf;
  let matValue = null;
  if (materialRef.fileId) {
    const cab = resolveExternal(sf, materialRef.fileId);
    const file = cab && index.cabToFile.get(cab);
    if (!file) return null;
    const loaded = loadSerialized(file, cab);
    if (!loaded) return null;
    matSf = loaded.sf;
  }
  for (const obj of matSf.objects) {
    if (String(obj.pathId) !== String(materialRef.pathId)) continue;
    matValue = readObjectSafe(matSf, obj);
  }
  if (!matValue) return null;
  return textureFromMaterial(matSf, matValue, index);
}

function renderVisual(name, index, options) {
  const file = index.visualToFile.get(name + "_Visual");
  if (!file) return { error: "no visual" };
  const loaded = loadSerialized(file);
  if (!loaded) return { error: "bad visual" };
  const draws = collectDraws(loaded.sf);
  const parts = [];
  for (const draw of draws) {
    const mesh = meshByRef(loaded.sf, draw.mesh, index);
    if (!mesh) continue;
    const geo = decodeMesh(mesh);
    if (!geo || geo.indices.length < 3) continue;
    let tex = null;
    try { tex = textureFor(loaded.sf, draw.material, index); } catch { tex = null; }
    parts.push({ geo, tex });
  }
  if (!parts.length) {
    const meshFile = index.meshToFile.get(name + "_Mesh");
    if (!meshFile) return { error: "no mesh" };
    const meshLoaded = loadSerialized(meshFile);
    if (!meshLoaded) return { error: "bad mesh" };
    for (const obj of meshLoaded.sf.objects) {
      const value = readObjectSafe(meshLoaded.sf, obj);
      if (!value || !value.m_VertexData) continue;
      const geo = decodeMesh(value);
      if (geo) parts.push({ geo, tex: null });
    }
  }
  if (!parts.length) return { error: "empty" };
  const kept = options && options.dropDiscs ? cullPortrait(parts) : cullParts(parts);
  const png = paint(kept);
  if (!png) return { error: "blank" };
  flipPngHorizontal(png);
  return { png, parts: parts.length, textured: parts.filter((p) => p.tex).length };
}

function flipPngHorizontal(png) {
  const width = png.width;
  const height = png.height;
  const src = Buffer.from(png.data);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4;
      const to = (y * width + (width - 1 - x)) * 4;
      png.data[to] = src[from];
      png.data[to + 1] = src[from + 1];
      png.data[to + 2] = src[from + 2];
      png.data[to + 3] = src[from + 3];
    }
  }
}

function fillCreaturePortraits(sources) {
  const pending = sources.filter((s) => s.category === "怪物" && !s.icon);
  const iconDir = path.join(ROOT, "icons");
  fs.mkdirSync(iconDir, { recursive: true });
  let made = 0;
  const need = [];
  for (const source of pending) {
    const file = iconFile(source.asset);
    const full = path.join(iconDir, file);
    if (fs.existsSync(full)) {
      source.icon = "icons/" + file;
      continue;
    }
    need.push(source);
  }
  if (!need.length) return 0;
  console.log("rendering creature fronts", need.length);
  const index = buildIndex();
  for (const source of need) {
    const name = enumOf(source.asset);
    let result;
    try { result = renderVisual(name, index); } catch (error) { result = { error: error.message }; }
    if (!result.png) {
      console.log(" skip", name, result.error || "");
      continue;
    }
    const file = iconFile(source.asset);
    fs.writeFileSync(path.join(iconDir, file), PNG.sync.write(result.png));
    source.icon = "icons/" + file;
    made++;
    console.log(" creature", name, "parts", result.parts, "textured", result.textured);
  }
  return made;
}

const NPC_VISUALS = {
  Priestess: "AdvancedNPC_PriestessInMatch",
  Vulkaryn: "AdvancedNPC_VulkarynInMatch",
  Goldbelly: "AdvancedNPC_GoldBellyInMatch",
  Silverhook: "AdvancedNpc_SilverhookSamQuartermaster",
  Lanathar: "AdvancedNPC_LanatharInMatch",
  Vexxie: "AdvancedNPC_VexxieInMatch",
  Doctor: "AdvancedNPC_DoctorInMatch",
  Aetos: "AdvancedNPC_AetosInMatch",
  Gondrak: "AdvancedNPC_GondrakInMatch",
  Diona: "AdvancedNpc_Diona",
  Ruffles: "AdvancedNpc_Ruffles",
  Milloween: "AdvancedNpc_Milloween",
  Drakthor: "AdvancedNpc_Drakthor",
  Ryzor: "AdvancedNpc_RyzorPotionVendor",
  HumanShopkeeper: "HumanShopkeeper_Named",
};

const NPC_ASSETS = {
  AdvancedNPC_DoctorConfigurationAsset: "Doctor",
  AdvancedNpc_RyzorPotionVendorConfigurationAsset: "Ryzor",
  AdvancedNpc_VulkarynItemVendorConfigurationAsset: "Vulkaryn",
  HumanShopkeeper_NamedConfigurationAsset: "HumanShopkeeper",
  AdvancedNpc_DionaConfigurationAsset: "Diona",
  AdvancedNpc_GondrakBlacksmithConfigurationAsset: "Gondrak",
};

function catalogBundles(names) {
  const catalog = path.resolve(BUNDLE_DIR, "../catalog.bin");
  const buf = fs.readFileSync(catalog);
  const U32 = 0xffffffff;
  const u32 = (o) => buf.readUInt32LE(o);
  const i32 = (o) => buf.readInt32LE(o);
  const keysOffset = u32(8);
  const count = i32(keysOffset - 4) / 4;
  const cache = new Map();
  function readBasic(offset) {
    const len = i32(offset - 4);
    if (len < 0 || len > 4000 || offset + len > buf.length) return null;
    return buf.toString("utf8", offset, offset + len);
  }
  function readEncoded(encoded, sep) {
    if (encoded === U32 || encoded === U32 - 1) return null;
    if (cache.has(encoded)) return cache.get(encoded);
    const offset = encoded & 0x3fffffff;
    let result;
    if ((encoded & 0x40000000) !== 0 && sep) {
      const parts = [];
      let at = offset;
      for (let n = 0; n < 12; n++) {
        const part = readEncoded(u32(at), null);
        const next = u32(at + 4);
        if (part) parts.push(part);
        if (next === U32) break;
        at = next;
      }
      result = parts.length === 1 ? parts[0] : parts.reverse().join(sep);
    } else if ((encoded & 0x80000000) !== 0) {
      const len = i32(offset - 4);
      result = buf.toString("utf16le", offset, offset + len);
    } else result = readBasic(offset);
    cache.set(encoded, result);
    return result;
  }
  function decodeKey(offset) {
    const typeOff = u32(offset);
    const objOff = u32(offset + 4);
    if (!typeOff || typeOff === U32 || typeOff > buf.length) return null;
    const cls = readEncoded(u32(typeOff + 4), ".");
    if (!cls || !String(cls).endsWith("String")) return null;
    if (objOff === U32) return "";
    const sep = String.fromCharCode(buf[objOff + 4]);
    return readEncoded(u32(objOff), sep && sep !== "\0" ? sep : null);
  }
  function bundleOf(locOff, depth) {
    if (!locOff || locOff === U32 || depth > 4) return "";
    const n = i32(locOff - 4) / 4;
    for (let j = 0; j < n && j < 6; j++) {
      const off = u32(locOff + j * 4);
      const internalId = readEncoded(u32(off + 4), "/");
      if (internalId && internalId.endsWith(".bundle")) return internalId.split(/[/\\]/).pop();
      const nested = bundleOf(u32(off + 12), depth + 1);
      if (nested) return nested;
    }
    return "";
  }
  const wanted = new Set(names.map((name) => name + "_Visual.prefab"));
  const found = new Map();
  for (let i = 0; i < count; i += 2) {
    const key = decodeKey(u32(keysOffset + i * 4));
    if (!wanted.has(key)) continue;
    const file = bundleOf(u32(keysOffset + (i + 1) * 4), 0);
    if (file) found.set(key.replace(/_Visual\.prefab$/, ""), file);
  }
  return found;
}

function fillNpcPortraits() {
  const iconDir = path.join(ROOT, "icons");
  fs.mkdirSync(iconDir, { recursive: true });
  const names = [...new Set(Object.values(NPC_VISUALS))];
  const pending = names.filter((name) => !fs.existsSync(path.join(iconDir, iconFile(name))));
  const files = new Map();
  if (pending.length) {
    console.log("rendering npc fronts", pending.length);
    const bundles = catalogBundles(pending);
    console.log("indexing mesh bundles");
    const index = { cabToFile: buildCabMap(), visualToFile: new Map(), meshToFile: new Map() };
    for (const name of pending) {
      const bundle = bundles.get(name);
      if (!bundle) {
        console.log(" skip", name, "no bundle");
        continue;
      }
      index.visualToFile.set(name + "_Visual", bundle);
      let result;
      try { result = renderVisual(name, index, { dropDiscs: true }); } catch (error) { result = { error: error.message }; }
      if (!result.png) {
        console.log(" skip", name, result.error || "");
        continue;
      }
      fs.writeFileSync(path.join(iconDir, iconFile(name)), PNG.sync.write(result.png));
      console.log(" npc", name, "parts", result.parts, "textured", result.textured);
    }
  }
  for (const name of names) {
    const file = iconFile(name);
    if (fs.existsSync(path.join(iconDir, file))) files.set(name, "icons/" + file);
  }
  const tokens = {};
  for (const [token, name] of Object.entries(NPC_VISUALS)) if (files.has(name)) tokens[token] = files.get(name);
  const assets = {};
  for (const [asset, token] of Object.entries(NPC_ASSETS)) if (tokens[token]) assets[asset] = tokens[token];
  return { tokens, assets };
}

module.exports = { fillCreaturePortraits, fillNpcPortraits, renderVisual, buildIndex, iconFile };

if (require.main === module) {
  const names = process.argv.slice(2);
  const index = buildIndex();
  const iconDir = path.join(ROOT, "icons");
  fs.mkdirSync(iconDir, { recursive: true });
  for (const name of names) {
    const result = renderVisual(name, index);
    if (!result.png) { console.log("skip", name, result.error); continue; }
    const file = "Model_" + name + ".png";
    fs.writeFileSync(path.join(iconDir, file), PNG.sync.write(result.png));
    console.log("wrote", file, "parts", result.parts, "textured", result.textured);
  }
}
