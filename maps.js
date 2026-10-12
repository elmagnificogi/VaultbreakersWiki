const fs = require("fs");
const path = require("path");
const lz4 = require("lz4js");
const { PNG } = require("pngjs");
const { parseSerialized, readObject } = require("./serialized");
const { decodeTexture } = require("./dxt");

const BUNDLE_DIR = path.resolve(__dirname, "../Vaultbreakers_Data/StreamingAssets/aa/StandaloneWindows64");

const MAP_DEFS = [
  {
    id: "pinewood",
    scene: "22e8bc68e9df03c0af8b54ec8aaec7c0.bundle",
    texture: "6dfc96724fd67e223427f4e284491daf.bundle",
    nameKey: "MapName_Pinewood",
  },
  {
    id: "refinery",
    scene: "b411e94175656f65f931de14528d785b.bundle",
    texture: "3b5fd3da52126ef35d7646afe469b8a3.bundle",
    nameKey: "MapName_Refinery",
  },
  {
    id: "dragonvault",
    scene: "bdaed0fc428a60db80ef56ea6258ee39.bundle",
    texture: "5b340e8f45322580fb9e7a6adbe84e02.bundle",
    nameKey: "MapName_Dragonvault",
  },
];

function align(o, n) {
  const m = o % n;
  return m ? o + (n - m) : o;
}

function cstr(buf, o) {
  let e = o;
  while (buf[e]) e++;
  return { v: buf.toString("utf8", o, e), o: e + 1 };
}

function bundleInfo(buf) {
  let o = 0;
  let s = cstr(buf, o);
  o = s.o;
  if (s.v !== "UnityFS") throw new Error("not UnityFS");
  const version = buf.readUInt32BE(o);
  o += 4;
  s = cstr(buf, o); o = s.o;
  s = cstr(buf, o); o = s.o;
  o += 8;
  const csize = buf.readUInt32BE(o); o += 4;
  const usize = buf.readUInt32BE(o); o += 4;
  const flags = buf.readUInt32BE(o); o += 4;
  if (version >= 7) o = align(o, 16);
  const dst = new Uint8Array(usize);
  const n = lz4.decompressBlock(buf.subarray(o, o + csize), dst, 0, csize, 0);
  if (n !== usize) throw new Error("info lz4");
  const info = Buffer.from(dst.buffer, dst.byteOffset, n);
  let p = 16;
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
    const offset = Number(info.readBigInt64BE(p)); p += 8;
    const size = Number(info.readBigInt64BE(p)); p += 8;
    p += 4;
    const nodePath = cstr(info, p); p = nodePath.o;
    nodes.push({ offset, size, path: nodePath.v });
  }
  const dataStart = (flags & 0x200) ? align(o + csize, 16) : o + csize;
  return { blocks, nodes, dataStart };
}

function extractRange(buf, info, start, size) {
  const out = Buffer.allocUnsafe(size);
  let cursor = info.dataStart;
  let uncompressed = 0;
  const end = start + size;
  for (const block of info.blocks) {
    const bStart = uncompressed;
    const bEnd = uncompressed + block.uncompressedSize;
    const chunk = buf.subarray(cursor, cursor + block.compressedSize);
    cursor += block.compressedSize;
    uncompressed = bEnd;
    if (bEnd <= start || bStart >= end) continue;
    const compression = block.flags & 0x3f;
    let plain = chunk;
    if (compression !== 0) {
      const dst = new Uint8Array(block.uncompressedSize);
      const n = lz4.decompressBlock(chunk, dst, 0, chunk.length, 0);
      if (n !== block.uncompressedSize) throw new Error("block lz4");
      plain = Buffer.from(dst.buffer, dst.byteOffset, n);
    }
    const from = Math.max(start, bStart);
    const to = Math.min(end, bEnd);
    plain.copy(out, from - start, from - bStart, to - bStart);
  }
  return out;
}

function asFloat(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  if ((n | 0) !== n) return n;
  const b = Buffer.alloc(4);
  b.writeInt32LE(n);
  return b.readFloatLE(0);
}

function toMapPercent(x, z, offsetX, offsetY, sizeX, sizeY) {
  // Camera-aligned percent, then one 90° clockwise turn so the page matches the in-game map.
  // Screen y grows downward: left' = 100 - top, top' = left.
  const u = (x - offsetX) / sizeX;
  const v = (z - offsetY) / sizeY;
  const left = u * 100;
  const top = (1 - v) * 100;
  return { left: 100 - top, top: left };
}

function quatRotate(q, v) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const vx = v[0], vy = v[1], vz = v[2];
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

function quatMul(a, b) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function typeHas(node, name) {
  if (!node) return false;
  if (node.name === name) return true;
  return (node.children || []).some((child) => typeHas(child, name));
}

function chestTable(name) {
  if (/Decal|Vfx|Mdl|Lid|Wheel|Fire|Crack|Open_Magic|EpicDragon|VaultFire|VaultCrash|DirtDecal|Tree_Vfx|Holo/i.test(name)) return "";
  if (/DirtMound/i.test(name)) return /Large/i.test(name) ? "DirtMoundLargeChestTable" : "DirtMoundSmallChestTable";
  if (/WolfsDen|WolfDen/i.test(name)) return "WolfsDenChestTable";
  if (/DesertBeast|Rockmuncher/i.test(name)) return "DesertBeastDenChestTable";
  if (/RocketCrash/i.test(name)) return "RocketCrashChestTable";
  if (/Dv Portal Chest|GreaterVoid/i.test(name)) return "GreaterVoidPortalChestCraftingMatTable";
  const vaultNumber = name.match(/vault\s*(\d+)\s*chest/i);
  if (vaultNumber) {
    const n = vaultNumber[1];
    if (n === "1") return "VaultChest_Vault1CustomTable";
    if (n === "2") return "VaultChest2Table";
    if (n === "3") return "VaultChest3Table";
    if (n === "4") return "VaultChest4Table";
    if (n === "5") return "VaultChest5Table";
    return "VaultChestTable";
  }
  if (/DroppedLoot/i.test(name)) return "DroppedLootChestTable";
  if (/ExtraHigh2/i.test(name)) return "LootChest_ExtraHigh2Table";
  if (/ExtraHigh|GoldenChest/i.test(name)) return "LootChest_ExtraHighTable";
  if (/LootChest2/i.test(name)) return "LootChest2Table";
  if (/Lockbox|LockBox/i.test(name)) {
    if (/Bandit/i.test(name)) return "BanditLockboxTable";
    if (/Ghost/i.test(name)) return "GhostLockBoxChestTable";
    if (/Scrat/i.test(name)) return "ScratLockboxTable";
    return "LockBoxChestTable";
  }
  if (/GhostMedium|MediumChest/i.test(name)) {
    if (/Ghost/i.test(name)) return "GhostMediumChestTable";
    if (/Scrat/i.test(name)) return "ScratMediumChestTable";
    return "MediumChestTable";
  }
  if (/TentChest|ScratTent/i.test(name)) return "ScratTentChestTable";
  if (/Purifier/i.test(name)) return "ScratOilPurifierChestTable";
  if (/ScrapPile|JunkChest/i.test(name)) return "ScratJunkChestLowTable";
  if (/VaultChest5/i.test(name)) return "VaultChest5Table";
  if (/VaultChest4/i.test(name)) return "VaultChest4Table";
  if (/VaultChest3/i.test(name)) return "VaultChest3Table";
  if (/VaultChest2/i.test(name)) return "VaultChest2Table";
  if (/VaultChest1|Vault1Custom/i.test(name)) return "VaultChest_Vault1CustomTable";
  if (/VaultChest/i.test(name)) return "VaultChestTable";
  if (/High/i.test(name)) return "LootChestHighTable";
  if (/LowLevelChests_Bandits|BanditChest/i.test(name)) return "BanditChestTable";
  if (/LowLevelChests_Ghosts/i.test(name)) return "GhostMediumChestTable";
  if (/LowLevelChests_Scrats|ScratChest/i.test(name)) return "ScratChestTable";
  if (/LootChest|ChestSpawn/i.test(name)) return "LootChestTable";
  return "";
}

function exportMinimap(def, outFile) {
  if (fs.existsSync(outFile)) return;
  const buf = fs.readFileSync(path.join(BUNDLE_DIR, def.texture));
  const info = bundleInfo(buf);
  const cab = info.nodes.find((n) => !n.path.includes("."));
  const res = info.nodes.find((n) => n.path.endsWith(".resS"));
  const sf = parseSerialized(extractRange(buf, info, cab.offset, cab.size));
  const texType = sf.types.findIndex((t) => typeHas(t.node, "m_TextureFormat"));
  const obj = sf.objects.find((o) => o.typeId === texType);
  const value = readObject(sf, obj).value;
  const stream = value.m_StreamData;
  const size = Number(stream["#795"] || 0);
  const offset = Number(stream.offset || 0);
  const raw = extractRange(buf, info, res.offset + offset, size);
  const rgba = decodeTexture(value.m_TextureFormat, raw, value.m_Width, value.m_Height);
  if (!rgba) throw new Error("minimap decode " + def.id);
  const upright = flipVertical(rgba, value.m_Width, value.m_Height);
  const turned = rotateCW90(upright, value.m_Width, value.m_Height);
  const png = new PNG({ width: turned.width, height: turned.height });
  // Unity stores the DXT blocks bottom-up. Flip vertically, then rotate 90° clockwise
  // once. Existing files are skipped, so a later extract must not turn them again.
  png.data = turned.data;
  fs.writeFileSync(outFile, PNG.sync.write(png));
}

function rotateCW90(rgba, width, height) {
  const out = Buffer.alloc(rgba.length);
  const dstWidth = height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dx = height - 1 - y;
      const dy = x;
      rgba.copy(out, (dy * dstWidth + dx) * 4, src, src + 4);
    }
  }
  return { data: out, width: height, height: width };
}

function flipVertical(rgba, width, height) {
  const out = Buffer.alloc(rgba.length);
  const stride = width * 4;
  for (let y = 0; y < height; y++) {
    rgba.copy(out, (height - 1 - y) * stride, y * stride, (y + 1) * stride);
  }
  return out;
}

function collectPins(def) {
  const buf = fs.readFileSync(path.join(BUNDLE_DIR, def.scene));
  const info = bundleInfo(buf);
  const scene = info.nodes.find((n) => !n.path.includes("."));
  const data = extractRange(buf, info, scene.offset, scene.size);
  const sf = parseSerialized(data);
  const goType = sf.types.findIndex((t) => t.classId === 1);
  const trType = sf.types.findIndex((t) => t.classId === 4);
  const worldType = sf.types.findIndex((t) => typeHas(t.node, "_worldSize"));
  const worldObj = sf.objects.find((o) => o.typeId === worldType);
  if (!worldObj) return [];
  const world = readObject(sf, worldObj).value;
  const sizeX = asFloat(world._worldSize.x);
  const sizeY = asFloat(world._worldSize.y);
  const offsetX = asFloat(world._worldOffset.x);
  const offsetY = asFloat(world._worldOffset.y);
  if (!sizeX || !sizeY) return [];
  const byPath = new Map();
  for (const obj of sf.objects) byPath.set(obj.pathId.toString(), obj);
  const gos = sf.objects.filter((o) => o.typeId === goType).sort((a, b) => a.byteStart - b.byteStart);
  function findGo(abs) {
    const rel = abs - sf.dataOffset;
    let lo = 0;
    let hi = gos.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const obj = gos[mid];
      if (rel < obj.byteStart) hi = mid - 1;
      else if (rel >= obj.byteStart + obj.byteSize) lo = mid + 1;
      else return obj;
    }
    return null;
  }
  const cache = new Map();
  function worldOf(pathId, depth) {
    const key = String(pathId);
    if (cache.has(key)) return cache.get(key);
    const obj = byPath.get(key);
    if (!obj || obj.typeId !== trType || depth > 32) return null;
    const value = readObject(sf, obj).value;
    const localPos = [asFloat(value.m_LocalPosition.x), asFloat(value.m_LocalPosition.y), asFloat(value.m_LocalPosition.z)];
    const localRot = [asFloat(value.m_LocalRotation.x), asFloat(value.m_LocalRotation.y), asFloat(value.m_LocalRotation.z), asFloat(value.m_LocalRotation.w)];
    let pos = localPos;
    let rot = localRot;
    const father = value.m_Father && String(value.m_Father.pathId);
    if (father && father !== "0") {
      const parent = worldOf(father, depth + 1);
      if (parent) {
        const rotated = quatRotate(parent.rot, localPos);
        pos = [parent.pos[0] + rotated[0], parent.pos[1] + rotated[1], parent.pos[2] + rotated[2]];
        rot = quatMul(parent.rot, localRot);
      }
    }
    const result = { pos, rot };
    cache.set(key, result);
    return result;
  }
  const needles = ["Chest", "Loot", "Den", "Mound", "Lock", "Vault", "Scrap", "Purifier", "Rocket", "Hidden"];
  const seen = new Set();
  const pins = [];
  for (const needle of needles) {
    const bytes = Buffer.from(needle);
    let at = 0;
    while ((at = data.indexOf(bytes, at)) >= 0) {
      let start = at;
      while (start > 4 && data[start - 1] >= 32 && data[start - 1] < 127) start--;
      let end = at + needle.length;
      while (end < data.length && data[end] >= 32 && data[end] < 127) end++;
      const len = end - start;
      if (len >= needle.length && len < 96 && data.readInt32LE(start - 4) === len) {
        const name = data.toString("utf8", start, end);
        const table = chestTable(name);
        const go = table ? findGo(start) : null;
        if (go && !seen.has(go.byteStart)) {
          seen.add(go.byteStart);
          const value = readObject(sf, go).value;
          const comps = Array.isArray(value.m_Component) ? value.m_Component : [];
          let transformId = "";
          for (const comp of comps) {
            const ptr = comp.component || comp;
            const obj = ptr && byPath.get(String(ptr.pathId));
            if (obj && obj.typeId === trType) {
              transformId = String(ptr.pathId);
              break;
            }
          }
          const placed = transformId ? worldOf(transformId, 0) : null;
          if (placed) {
            const x = placed.pos[0];
            const z = placed.pos[2];
            const u = (x - offsetX) / sizeX;
            const v = (z - offsetY) / sizeY;
            if (u >= -0.02 && u <= 1.02 && v >= -0.02 && v <= 1.02) {
              const mapped = toMapPercent(x, z, offsetX, offsetY, sizeX, sizeY);
              pins.push({
                table,
                x: Math.round(x * 10) / 10,
                z: Math.round(z * 10) / 10,
                left: Math.round(mapped.left * 10) / 10,
                top: Math.round(mapped.top * 10) / 10,
              });
            }
          }
        }
      }
      at += needle.length;
    }
  }
  const deduped = [];
  const occupied = new Set();
  for (const pin of pins) {
    const key = pin.table + ":" + Math.round(pin.x) + ":" + Math.round(pin.z);
    if (occupied.has(key)) continue;
    occupied.add(key);
    deduped.push(pin);
  }
  return deduped;
}

const ENTRANCE_SPECS = [
  { test: /^PortalWolfswood1\b/, titleKey: "Name_AdvancedNpc_PortalWolfswood1", detailKey: "Description_AdvancedNpc_PortalWolfswood1_Base", kind: "portal" },
  { test: /^PortalWolfswood2\b/, titleKey: "Name_AdvancedNpc_PortalWolfswood2", detailKey: "Description_AdvancedNpc_PortalWolfswood2_Base", kind: "portal" },
  { test: /^PortalWolfswood3\b/, titleKey: "Name_AdvancedNpc_PortalWolfswood3", detailKey: "Description_AdvancedNpc_PortalWolfswood3_Base", kind: "portal" },
  { test: /^PortalRefinery1\b/, titleKey: "Name_PortalRefinery1", detailKey: "Description_PortalRefinery1_Base", kind: "portal" },
  { test: /^PortalRefinery2\b/, titleKey: "Name_PortalRefinery2", detailKey: "Description_PortalRefinery2_Base", kind: "portal" },
  { test: /^PortalRefinery3\b/, titleKey: "Name_PortalRefinery3", detailKey: "Description_PortalRefinery3_Base", kind: "portal" },
  { test: /^DVPortal - West\b/, titleKey: "Name_PortalDV1", detailKey: "Name_PortalDV1", kind: "portal" },
  { test: /^DVPortal - North\b/, titleKey: "Name_PortalDV2", detailKey: "Name_PortalDV2", kind: "portal" },
  { test: /^DVPortal - East\b/, titleKey: "Name_PortalDV3", detailKey: "Name_PortalDV3", kind: "portal" },
  { test: /^OneWayPortal1$/, titleKey: "Name_AdvancedNpc_OneWayPortal1", detailKey: "Description_AdvancedNpc_OneWayPortal1", kind: "portal" },
  { test: /^OneWayPortal2$/, titleKey: "Name_AdvancedNpc_OneWayPortal2", detailKey: "Description_AdvancedNpc_OneWayPortal2", kind: "portal" },
  { test: /^OneWayPortal3$/, titleKey: "Name_AdvancedNpc_OneWayPortal3", detailKey: "Description_AdvancedNpc_OneWayPortal3", kind: "portal" },
];

function collectEntrances(def) {
  const buf = fs.readFileSync(path.join(BUNDLE_DIR, def.scene));
  const info = bundleInfo(buf);
  const scene = info.nodes.find((n) => !n.path.includes("."));
  const data = extractRange(buf, info, scene.offset, scene.size);
  const sf = parseSerialized(data);
  const goType = sf.types.findIndex((t) => t.classId === 1);
  const trType = sf.types.findIndex((t) => t.classId === 4);
  const worldType = sf.types.findIndex((t) => typeHas(t.node, "_worldSize"));
  const worldObj = sf.objects.find((o) => o.typeId === worldType);
  if (!worldObj) return [];
  const world = readObject(sf, worldObj).value;
  const sizeX = asFloat(world._worldSize.x);
  const sizeY = asFloat(world._worldSize.y);
  const offsetX = asFloat(world._worldOffset.x);
  const offsetY = asFloat(world._worldOffset.y);
  if (!sizeX || !sizeY) return [];
  const byPath = new Map();
  for (const obj of sf.objects) byPath.set(obj.pathId.toString(), obj);
  const gos = sf.objects.filter((o) => o.typeId === goType).sort((a, b) => a.byteStart - b.byteStart);
  function findGo(abs) {
    const rel = abs - sf.dataOffset;
    let lo = 0;
    let hi = gos.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const obj = gos[mid];
      if (rel < obj.byteStart) hi = mid - 1;
      else if (rel >= obj.byteStart + obj.byteSize) lo = mid + 1;
      else return obj;
    }
    return null;
  }
  function goName(obj) {
    if (!obj) return "";
    const raw = readObject(sf, obj).value["#427"];
    return Array.isArray(raw) ? Buffer.from(raw).toString("utf8") : "";
  }
  const cache = new Map();
  function worldOf(pathId, depth) {
    const key = String(pathId);
    if (cache.has(key)) return cache.get(key);
    const obj = byPath.get(key);
    if (!obj || obj.typeId !== trType || depth > 32) return null;
    const value = readObject(sf, obj).value;
    const localPos = [asFloat(value.m_LocalPosition.x), asFloat(value.m_LocalPosition.y), asFloat(value.m_LocalPosition.z)];
    const localRot = [asFloat(value.m_LocalRotation.x), asFloat(value.m_LocalRotation.y), asFloat(value.m_LocalRotation.z), asFloat(value.m_LocalRotation.w)];
    let pos = localPos;
    let rot = localRot;
    const father = value.m_Father && String(value.m_Father.pathId);
    if (father && father !== "0") {
      const parent = worldOf(father, depth + 1);
      if (parent) {
        const rotated = quatRotate(parent.rot, localPos);
        pos = [parent.pos[0] + rotated[0], parent.pos[1] + rotated[1], parent.pos[2] + rotated[2]];
        rot = quatMul(parent.rot, localRot);
      }
    }
    const result = { pos, rot, value };
    cache.set(key, result);
    return result;
  }
  function transformOf(go) {
    const value = readObject(sf, go).value;
    const comps = Array.isArray(value.m_Component) ? value.m_Component : [];
    for (const comp of comps) {
      const ptr = comp.component || comp;
      const obj = ptr && byPath.get(String(ptr.pathId));
      if (obj && obj.typeId === trType) return String(ptr.pathId);
    }
    return "";
  }
  function childNamed(transformId, pattern) {
    const placed = worldOf(transformId, 0);
    const kids = placed && Array.isArray(placed.value.m_Children) ? placed.value.m_Children : [];
    for (const kid of kids) {
      const child = worldOf(kid.pathId, 0);
      if (!child) continue;
      const go = byPath.get(String(child.value["#374"] && child.value["#374"].pathId));
      const name = goName(go);
      if (pattern.test(name)) return { name, pos: child.pos };
    }
    return null;
  }
  function marker(spec, x, z) {
    const u = (x - offsetX) / sizeX;
    const v = (z - offsetY) / sizeY;
    if (u < -0.02 || u > 1.02 || v < -0.02 || v > 1.02) return null;
    const mapped = toMapPercent(x, z, offsetX, offsetY, sizeX, sizeY);
    return {
      titleKey: spec.titleKey,
      detailKey: spec.detailKey,
      kind: spec.kind,
      left: Math.round(mapped.left * 10) / 10,
      top: Math.round(mapped.top * 10) / 10,
    };
  }
  const found = [];
  const seen = new Set();
  const needles = ["PortalWolfswood", "PortalRefinery", "DVPortal", "OneWayPortal", "ExtractionSpawn"];
  for (const needle of needles) {
    const bytes = Buffer.from(needle);
    let at = 0;
    while ((at = data.indexOf(bytes, at)) >= 0) {
      let start = at;
      while (start > 4 && data[start - 1] >= 32 && data[start - 1] < 127) start--;
      let end = at + needle.length;
      while (end < data.length && data[end] >= 32 && data[end] < 127) end++;
      const len = end - start;
      if (len >= needle.length && len < 80 && data.readInt32LE(start - 4) === len) {
        const name = data.toString("utf8", start, end);
        const go = findGo(start);
        if (go && !seen.has(go.byteStart)) {
          seen.add(go.byteStart);
          const transformId = transformOf(go);
          const placed = transformId ? worldOf(transformId, 0) : null;
          if (placed && name === "ExtractionSpawn") {
            const rune = childNamed(transformId, /^Rune$/);
            if (rune && (Math.abs(rune.pos[0]) > 1 || Math.abs(rune.pos[2]) > 1)) {
              const point = marker({ titleKey: "ExtractionPoint", detailKey: "ChannelToSoloExtract", kind: "extract" }, rune.pos[0], rune.pos[2]);
              if (point) found.push(point);
            }
          }
          const spec = ENTRANCE_SPECS.find((item) => item.test.test(name));
          if (placed && spec) {
            let pos = placed.pos;
            if (Math.abs(pos[0]) < 1 && Math.abs(pos[2]) < 1) {
              const visual = childNamed(transformId, /Portal visible Unlocked|^Portal On VFx$/i);
              if (visual) pos = visual.pos;
            }
            if (Math.abs(pos[0]) > 1 || Math.abs(pos[2]) > 1) {
              const point = marker(spec, pos[0], pos[2]);
              if (point) found.push(point);
            }
          }
        }
      }
      at += needle.length;
    }
  }
  const mapFile = path.join(__dirname, "maps", def.id + ".png");
  if (fs.existsSync(mapFile)) {
    const png = PNG.sync.read(fs.readFileSync(mapFile));
    for (const point of found) {
      const mode = point.kind === "extract" ? "gate" : point.titleKey === "Name_AdvancedNpc_PortalWolfswood3" ? "field" : "";
      const snapped = mode ? snapSouthOntoMap(png, point.left, point.top, mode) : null;
      if (!snapped) continue;
      point.left = snapped.left;
      point.top = snapped.top;
    }
  }
  return found;
}

function voidPixel(png, x, y) {
  const i = (y * png.width + x) * 4;
  const dr = png.data[i] - 24;
  const dg = png.data[i + 1] - 16;
  const db = png.data[i + 2] - 12;
  return dr * dr + dg * dg + db * db < 400;
}

function mapPercent(png, x, y) {
  return {
    left: Math.round(x / (png.width - 1) * 1000) / 10,
    top: Math.round(y / (png.height - 1) * 1000) / 10,
  };
}

// The authored pivots sit north of the landmarks: the solo extract rune is on the
// road above the map entrance, and the pine-fields portal is inside the rice plot.
// Move only those markers south onto the entrance light or the field's south edge.
function snapSouthOntoMap(png, left, top, mode) {
  const x0 = Math.round(left / 100 * (png.width - 1));
  const y0 = Math.round(top / 100 * (png.height - 1));
  if (mode === "gate") {
    let best = null;
    for (let y = y0; y < Math.min(png.height, y0 + 220); y++) {
      for (let x = x0 - 30; x <= x0 + 30; x++) {
        if (x < 0 || x >= png.width || voidPixel(png, x, y)) continue;
        const i = (y * png.width + x) * 4;
        const r = png.data[i];
        const g = png.data[i + 1];
        if (r < 160 || g < 120) continue;
        const sum = r + g + png.data[i + 2];
        if (!best || sum > best.sum) best = { x, y, sum };
      }
    }
    if (best && best.y - y0 >= 40) return mapPercent(png, best.x, best.y);
  }
  let last = y0;
  let dark = 0;
  for (let y = y0; y < Math.min(png.height, y0 + 220); y++) {
    const i = (y * png.width + x0) * 4;
    const sum = png.data[i] + png.data[i + 1] + png.data[i + 2];
    if (sum > 180) {
      last = y;
      dark = 0;
    } else if (++dark >= 8) {
      break;
    }
  }
  if (last - y0 < 40) return null;
  return mapPercent(png, x0, last);
}

const COVER_BUNDLES = {
  "CAB-37100f6c8d1535b9f210dfc3910db507": "839a09fd50d12e72cf28f24a0e621940.bundle",
  "CAB-689ad21f9b65ac628424c7c92d97c348": "d265171fabd5e36b448079dd3ae93aba.bundle",
  "CAB-53e1fd8c86a874168b45803c46982c34": "f5afb7345361b38bb569507e0e35fd15.bundle",
};

const meshCache = new Map();

function meshLoops(indices) {
  const count = new Map();
  const edgeKey = (a, b) => (a < b ? a + ":" + b : b + ":" + a);
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const tri = [indices[i], indices[i + 1], indices[i + 2]];
    for (let k = 0; k < 3; k++) {
      const id = edgeKey(tri[k], tri[(k + 1) % 3]);
      count.set(id, (count.get(id) || 0) + 1);
    }
  }
  const next = new Map();
  for (const [id, n] of count) {
    if (n !== 1) continue;
    const [a, b] = id.split(":").map(Number);
    if (!next.has(a)) next.set(a, []);
    if (!next.has(b)) next.set(b, []);
    next.get(a).push(b);
    next.get(b).push(a);
  }
  const used = new Set();
  const loops = [];
  for (const start of next.keys()) {
    if (used.has(String(start))) continue;
    const loop = [];
    let prev = -1;
    let cur = start;
    for (let guard = 0; guard < 4000; guard++) {
      const mark = prev + ">" + cur;
      if (used.has(mark)) break;
      used.add(mark);
      used.add(String(cur));
      loop.push(cur);
      const options = (next.get(cur) || []).filter((n) => n !== prev);
      const fresh = options.find((n) => !used.has(cur + ">" + n) && !used.has(n + ">" + cur));
      if (fresh === undefined) break;
      prev = cur;
      cur = fresh;
      if (cur === start) break;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

function pointLineDist(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  return Math.abs(dx * (a[1] - p[1]) - dy * (a[0] - p[0])) / len;
}

function simplifyOpen(points, epsilon) {
  if (points.length < 3) return points;
  let max = 0;
  let index = 0;
  const a = points[0];
  const b = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const dist = pointLineDist(points[i], a, b);
    if (dist > max) {
      max = dist;
      index = i;
    }
  }
  if (max <= epsilon) return [a, b];
  const left = simplifyOpen(points.slice(0, index + 1), epsilon);
  const right = simplifyOpen(points.slice(index), epsilon);
  return left.slice(0, -1).concat(right);
}

function simplifyClosed(points, epsilon) {
  if (points.length < 8) return points;
  let far = 1;
  let max = 0;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i][0] - points[0][0], points[i][1] - points[0][1]);
    if (d > max) {
      max = d;
      far = i;
    }
  }
  const first = simplifyOpen(points.slice(0, far + 1), epsilon);
  const second = simplifyOpen(points.slice(far).concat([points[0]]), epsilon);
  return first.slice(0, -1).concat(second.slice(0, -1));
}

function traceAlpha(rgba, width, height) {
  const count = width * height;
  const solid = new Uint8Array(count);
  for (let i = 0; i < count; i++) if (rgba[i * 4 + 3] > 96) solid[i] = 1;
  const seen = new Uint8Array(count);
  let best = [];
  for (let i = 0; i < count; i++) {
    if (!solid[i] || seen[i]) continue;
    const stack = [i];
    const comp = [];
    seen[i] = 1;
    while (stack.length) {
      const cur = stack.pop();
      comp.push(cur);
      const x = cur % width;
      const y = (cur / width) | 0;
      const next = [];
      if (x > 0) next.push(cur - 1);
      if (x + 1 < width) next.push(cur + 1);
      if (y > 0) next.push(cur - width);
      if (y + 1 < height) next.push(cur + width);
      for (const nb of next) {
        if (solid[nb] && !seen[nb]) {
          seen[nb] = 1;
          stack.push(nb);
        }
      }
    }
    if (comp.length > best.length) best = comp;
  }
  if (best.length < 30) return [];
  let cx = 0;
  let cy = 0;
  for (const index of best) {
    cx += index % width;
    cy += (index / width) | 0;
  }
  cx /= best.length;
  cy /= best.length;
  const bins = 72;
  const edge = new Array(bins).fill(null);
  for (const index of best) {
    const x = index % width;
    const y = (index / width) | 0;
    const dx = x - cx;
    const dy = y - cy;
    let angle = Math.atan2(dy, dx);
    if (angle < 0) angle += Math.PI * 2;
    const bin = Math.min(bins - 1, Math.floor((angle / (Math.PI * 2)) * bins));
    const dist = dx * dx + dy * dy;
    if (!edge[bin] || dist > edge[bin][2]) edge[bin] = [x, y, dist];
  }
  return edge.filter(Boolean).map((point) => [point[0], point[1]]);
}

function loadCoverMesh(bundleFile, nodePath, pathId) {
  const key = bundleFile + "|" + nodePath + "|" + pathId;
  if (meshCache.has(key)) return meshCache.get(key);
  const buf = fs.readFileSync(path.join(BUNDLE_DIR, bundleFile));
  const info = bundleInfo(buf);
  const node = info.nodes.find((n) => n.path === nodePath) || info.nodes.find((n) => n.path.includes(nodePath) && !n.path.endsWith(".resS"));
  if (!node) {
    meshCache.set(key, null);
    return null;
  }
  const sf = parseSerialized(extractRange(buf, info, node.offset, node.size));
  const obj = sf.objects.find((o) => o.pathId.toString() === String(pathId));
  if (!obj) {
    meshCache.set(key, null);
    return null;
  }
  const value = readObject(sf, obj).value;
  const rd = value.m_RD;
  const raw = Buffer.from(rd.m_VertexData.m_DataSize);
  const count = rd.m_VertexData.m_VertexCount;
  const points = [];
  for (let i = 0; i < count; i++) points.push([raw.readFloatLE(i * 12), raw.readFloatLE(i * 12 + 4)]);
  const idx = Buffer.from(rd.m_IndexBuffer);
  const indices = [];
  for (let i = 0; i + 1 < idx.length; i += 2) indices.push(idx.readUInt16LE(i));
  let mesh = { points, loops: meshLoops(indices) };
  const texture = rd.texture;
  const texObj = texture && texture.pathId && texture.pathId !== "0" && !texture.fileId
    ? sf.objects.find((item) => item.pathId.toString() === String(texture.pathId))
    : null;
  const res = info.nodes.find((n) => n.path.endsWith(".resS"));
  if (texObj && res) {
    try {
      const tex = readObject(sf, texObj).value;
      const stream = tex.m_StreamData;
      const size = Number(stream["#795"] || 0);
      const offset = Number(stream.offset || 0);
      const encoded = extractRange(buf, info, res.offset + offset, size);
      const rgba = decodeTexture(tex.m_TextureFormat, encoded, tex.m_Width, tex.m_Height);
      const edge = rgba ? traceAlpha(rgba, tex.m_Width, tex.m_Height) : [];
      if (edge.length) {
        const rectW = asFloat(value.m_Rect.width) || tex.m_Width;
        const rectH = asFloat(value.m_Rect.height) || tex.m_Height;
        const rectX = asFloat(value.m_Rect.x);
        const rectY = asFloat(value.m_Rect.y);
        const ppu = asFloat(value.m_PixelsToUnits) || rectW;
        const pivotX = asFloat(value.m_Pivot.x);
        const pivotY = asFloat(value.m_Pivot.y);
        const local = edge.map(([px, py]) => {
          const texX = px;
          const texY = tex.m_Height - 1 - py;
          return [
            (texX - rectX - pivotX * rectW) / ppu,
            (texY - rectY - pivotY * rectH) / ppu,
          ];
        });
        const simplified = simplifyClosed(local, 0.015);
        if (simplified.length >= 8) mesh = { points: simplified, loops: [simplified.map((_, i) => i)] };
      }
    } catch (error) {
      mesh.contourError = error.message;
    }
  }
  meshCache.set(key, mesh);
  return mesh;
}

function collectRegions(def) {
  const buf = fs.readFileSync(path.join(BUNDLE_DIR, def.scene));
  const info = bundleInfo(buf);
  const scene = info.nodes.find((n) => !n.path.includes("."));
  const data = extractRange(buf, info, scene.offset, scene.size);
  const sf = parseSerialized(data);
  const goType = sf.types.findIndex((t) => t.classId === 1);
  const trType = sf.types.findIndex((t) => t.classId === 4);
  const worldType = sf.types.findIndex((t) => typeHas(t.node, "_worldSize"));
  const worldObj = sf.objects.find((o) => o.typeId === worldType);
  if (!worldObj) return [];
  const world = readObject(sf, worldObj).value;
  const bounds = {
    sizeX: asFloat(world._worldSize.x),
    sizeY: asFloat(world._worldSize.y),
    offsetX: asFloat(world._worldOffset.x),
    offsetY: asFloat(world._worldOffset.y),
  };
  if (!bounds.sizeX || !bounds.sizeY) return [];
  const byPath = new Map();
  for (const obj of sf.objects) byPath.set(obj.pathId.toString(), obj);
  const gos = sf.objects.filter((o) => o.typeId === goType).sort((a, b) => a.byteStart - b.byteStart);
  function findGo(abs) {
    const rel = abs - sf.dataOffset;
    let lo = 0;
    let hi = gos.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const obj = gos[mid];
      if (rel < obj.byteStart) hi = mid - 1;
      else if (rel >= obj.byteStart + obj.byteSize) lo = mid + 1;
      else return obj;
    }
    return null;
  }
  function objectName(go) {
    const value = readObject(sf, go).value;
    const raw = value["#427"];
    return Array.isArray(raw) ? Buffer.from(raw).toString("utf8") : "";
  }
  const cache = new Map();
  function worldOf(pathId, depth) {
    const key = String(pathId);
    if (cache.has(key)) return cache.get(key);
    const obj = byPath.get(key);
    if (!obj || obj.typeId !== trType || depth > 32) return null;
    const value = readObject(sf, obj).value;
    const localPos = [asFloat(value.m_LocalPosition.x), asFloat(value.m_LocalPosition.y), asFloat(value.m_LocalPosition.z)];
    const localRot = [asFloat(value.m_LocalRotation.x), asFloat(value.m_LocalRotation.y), asFloat(value.m_LocalRotation.z), asFloat(value.m_LocalRotation.w)];
    const localScale = [asFloat(value.m_LocalScale.x), asFloat(value.m_LocalScale.y), asFloat(value.m_LocalScale.z)];
    let pos = localPos;
    let rot = localRot;
    let scale = localScale;
    const father = value.m_Father && String(value.m_Father.pathId);
    if (father && father !== "0") {
      const parent = worldOf(father, depth + 1);
      if (parent) {
        const rotated = quatRotate(parent.rot, [localPos[0] * parent.scale[0], localPos[1] * parent.scale[1], localPos[2] * parent.scale[2]]);
        pos = [parent.pos[0] + rotated[0], parent.pos[1] + rotated[1], parent.pos[2] + rotated[2]];
        rot = quatMul(parent.rot, localRot);
        scale = [parent.scale[0] * localScale[0], parent.scale[1] * localScale[1], parent.scale[2] * localScale[2]];
      }
    }
    const result = { pos, rot, scale, go: value["#374"] && String(value["#374"].pathId), father };
    cache.set(key, result);
    return result;
  }
  function coverMesh(fileId, pathId) {
    if (!fileId) return loadCoverMesh(def.scene, scene.path, pathId);
    const ext = sf.externals[fileId - 1];
    if (!ext) return null;
    const cab = (ext.path.match(/CAB-[0-9a-f]+/) || [])[0];
    if (ext.path.includes(".sharedAssets")) return loadCoverMesh(def.scene, cab + ".sharedAssets", pathId);
    const bundle = COVER_BUNDLES[cab];
    if (!bundle) return null;
    return loadCoverMesh(bundle, cab, pathId);
  }
  const mapPng = fs.existsSync(path.join(__dirname, "maps", def.id + ".png"))
    ? PNG.sync.read(fs.readFileSync(path.join(__dirname, "maps", def.id + ".png")))
    : null;
  function onLand(point) {
    if (!mapPng) return point.left >= 0 && point.left <= 100 && point.top >= 0 && point.top <= 100;
    const x = Math.round(point.left / 100 * (mapPng.width - 1));
    const y = Math.round(point.top / 100 * (mapPng.height - 1));
    if (x < 0 || y < 0 || x >= mapPng.width || y >= mapPng.height) return false;
    const i = (y * mapPng.width + x) * 4;
    const dr = mapPng.data[i] - 24;
    const dg = mapPng.data[i + 1] - 16;
    const db = mapPng.data[i + 2] - 12;
    return dr * dr + dg * dg + db * db > 140;
  }
  function keepLand(pathPts) {
    const land = pathPts.filter(onLand);
    if (land.length < 6) return [];
    const groups = [];
    let current = [land[0]];
    const gap = (a, b) => {
      const mid = { left: (a.left + b.left) / 2, top: (a.top + b.top) / 2 };
      return Math.hypot(a.left - b.left, a.top - b.top) > 8 && !onLand(mid);
    };
    for (let i = 1; i < land.length; i++) {
      if (gap(land[i - 1], land[i])) {
        groups.push(current);
        current = [];
      }
      current.push(land[i]);
    }
    if (current.length && !gap(land[land.length - 1], land[0]) && groups.length === 0) groups.push(current);
    else {
      groups.push(current);
    }
    return groups.filter((group) => group.length >= 6);
  }
  const seen = new Set();
  const pieces = [];
  const needle = Buffer.from("HiddenAreaCover");
  let at = 0;
  while ((at = data.indexOf(needle, at)) >= 0) {
    let start = at;
    while (start > 4 && data[start - 1] >= 32 && data[start - 1] < 127) start--;
    let end = at + needle.length;
    while (end < data.length && data[end] >= 32 && data[end] < 127) end++;
    const len = end - start;
    if (len >= needle.length && len < 80 && data.readInt32LE(start - 4) === len) {
      const go = findGo(start);
      if (go && !seen.has(go.byteStart)) {
        seen.add(go.byteStart);
        const value = readObject(sf, go).value;
        const comps = Array.isArray(value.m_Component) ? value.m_Component : [];
        let transformId = "";
        let sprite = null;
        for (const comp of comps) {
          const ptr = comp.component || comp;
          const obj = ptr && byPath.get(String(ptr.pathId));
          if (!obj) continue;
          if (obj.typeId === trType) transformId = String(ptr.pathId);
          if (sf.types[obj.typeId].classId === 212) {
            const sv = readObject(sf, obj).value;
            sprite = sv.m_Sprite;
          }
        }
        const placed = transformId && sprite && sprite.pathId && sprite.pathId !== "0" ? worldOf(transformId, 0) : null;
        const mesh = placed ? coverMesh(sprite.fileId, String(sprite.pathId)) : null;
        if (placed && mesh && mesh.loops.length) {
          const names = [];
          let cursor = placed;
          for (let i = 0; i < 8 && cursor; i++) {
            const goObj = cursor.go && byPath.get(cursor.go);
            if (goObj) names.push(objectName(goObj));
            cursor = cursor.father && cursor.father !== "0" ? worldOf(cursor.father, 0) : null;
          }
          const numbered = names.find((name) => /^Area \d+\b/.test(name));
          const poi = names.find((name) => /^Area\d+\b/.test(name));
          const title = (numbered || poi || "").replace(/\s+/g, " ").trim();
          if (title) {
            const paths = [];
            for (const loop of mesh.loops) {
              const pathPts = [];
              for (const index of loop) {
                const local = mesh.points[index];
                if (!local) continue;
                const rotated = quatRotate(placed.rot, [local[0] * placed.scale[0], local[1] * placed.scale[1], 0]);
                const x = placed.pos[0] + rotated[0];
                const z = placed.pos[2] + rotated[2];
                const mapped = toMapPercent(x, z, bounds.offsetX, bounds.offsetY, bounds.sizeX, bounds.sizeY);
                pathPts.push(mapped);
              }
              const inside = pathPts.filter((p) => p.left >= -8 && p.left <= 108 && p.top >= -8 && p.top <= 108).length;
              if (inside >= pathPts.length * 0.5) {
                for (const fitted of keepLand(pathPts)) paths.push(fitted);
              }
            }
            if (paths.length) pieces.push({ title, paths });
          }
        }
      }
    }
    at += needle.length;
  }
  const grouped = new Map();
  for (const piece of pieces) {
    if (!grouped.has(piece.title)) grouped.set(piece.title, []);
    grouped.get(piece.title).push(...piece.paths);
  }
  const regions = [];
  for (const [title, paths] of grouped) {
    let best = paths[0];
    let bestArea = -1;
    for (const pathPts of paths) {
      let area = 0;
      for (let i = 0; i < pathPts.length; i++) {
        const a = pathPts[i];
        const b = pathPts[(i + 1) % pathPts.length];
        area += a.left * b.top - b.left * a.top;
      }
      area = Math.abs(area);
      if (area > bestArea) {
        bestArea = area;
        best = pathPts;
      }
    }
    const label = best.reduce((sum, p) => ({ left: sum.left + p.left, top: sum.top + p.top }), { left: 0, top: 0 });
    regions.push({
      title,
      paths: paths.map((pathPts) => pathPts.map((p) => ({
        left: Math.round(p.left * 10) / 10,
        top: Math.round(p.top * 10) / 10,
      }))),
      left: Math.round((label.left / best.length) * 10) / 10,
      top: Math.round((label.top / best.length) * 10) / 10,
    });
  }
  return regions;
}

function extractGameMaps(byKey) {
  const dir = path.join(__dirname, "maps");
  fs.mkdirSync(dir, { recursive: true });
  const maps = [];
  for (const def of MAP_DEFS) {
    const file = "maps/" + def.id + ".png";
    exportMinimap(def, path.join(__dirname, file));
    const title = (byKey && byKey.get(def.nameKey)) || def.id;
    const pins = collectPins(def);
    const regions = collectRegions(def);
    const entrances = collectEntrances(def);
    console.log("map", title, "pins", pins.length, "regions", regions.length, "entrances", entrances.length);
    maps.push({ id: def.id, title, image: file, pins, regions, entrances });
  }
  return maps;
}

module.exports = { extractGameMaps, collectRegions, collectEntrances, MAP_DEFS, bundleInfo, extractRange, asFloat, BUNDLE_DIR };
