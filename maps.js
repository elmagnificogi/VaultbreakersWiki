const fs = require("fs");
const path = require("path");
const lz4 = require("lz4js");
const { PNG } = require("pngjs");
const { parseSerialized, readObject } = require("./serialized");
const { decodeTexture } = require("./dxt");

function gameDir() {
  const candidates = [
    path.resolve(__dirname, ".."),
    "D:\\Steam\\steamapps\\common\\Vaultbreakers Demo",
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "Vaultbreakers_Data"))) return dir;
  }
  throw new Error("找不到 Vaultbreakers Demo");
}

const BUNDLE_DIR = path.join(gameDir(), "Vaultbreakers_Data/StreamingAssets/aa/StandaloneWindows64");

const MAP_DEFS = [
  {
    id: "pinewood",
    scene: "6d791b5cb0785cb7beca8c1601b4ccb8.bundle",
    texture: "6dfc96724fd67e223427f4e284491daf.bundle",
    camera: "fbe10b298712e63a2b4c702469432f05.bundle",
    nameKey: "MapName_Pinewood",
  },
  {
    id: "refinery",
    scene: "787d4afed5ef099a0819ea3c40748012.bundle",
    texture: "3b5fd3da52126ef35d7646afe469b8a3.bundle",
    camera: "e15153d3ebdf26bc846fb0755b9cb8cd.bundle",
    nameKey: "MapName_Refinery",
  },
  {
    id: "dragonvault",
    scene: "bdaed0fc428a60db80ef56ea6258ee39.bundle",
    texture: "5b340e8f45322580fb9e7a6adbe84e02.bundle",
    camera: "ba91089093bd8693b378e04d3bfa370f.bundle",
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
  // Minimap camera looks down (+90 deg around X). Right is world +X, up is world +Z.
  const u = (x - offsetX) / sizeX;
  const v = (z - offsetY) / sizeY;
  return { left: u * 100, top: (1 - v) * 100 };
}

// MinimapCameraBehaviour.ResizeMinimapToMatchWorldSize:
// orthographic size = (max(MinimapSizeOverride) + MinimapPadding) * 0.5
// The baked map is that square frustum. Padding is 15 world units on the full width.
const MINIMAP_PADDING = 15;
const frameCache = new Map();

function mapFrame(def) {
  const cached = frameCache.get(def.id);
  if (cached) return cached;
  const buf = fs.readFileSync(path.join(BUNDLE_DIR, def.camera));
  const info = bundleInfo(buf);
  const node = info.nodes.find((n) => !n.path.includes("."));
  const sf = parseSerialized(extractRange(buf, info, node.offset, node.size));
  const trType = sf.types.findIndex((t) => t.classId === 4);
  const overType = sf.types.findIndex((t) => typeHas(t.node, "UseMinimapSizeOverride"));
  const over = readObject(sf, sf.objects.find((o) => o.typeId === overType)).value;
  const byPath = new Map(sf.objects.map((o) => [o.pathId.toString(), o]));
  const go = byPath.get(String(over["#374"].pathId));
  const comps = readObject(sf, go).value.m_Component || [];
  let transformId = "";
  for (const comp of comps) {
    const ptr = comp.component || comp;
    const obj = ptr && byPath.get(String(ptr.pathId));
    if (obj && obj.typeId === trType) transformId = String(ptr.pathId);
  }
  const cache = new Map();
  function worldOf(pathId, depth) {
    const key = String(pathId);
    if (cache.has(key)) return cache.get(key);
    const obj = byPath.get(key);
    if (!obj || depth > 16) return null;
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
  const cam = worldOf(transformId, 0);
  const override = Math.max(asFloat(over.MinimapSizeOverride.x), asFloat(over.MinimapSizeOverride.y));
  const size = override + MINIMAP_PADDING;
  const half = size / 2;
  const frame = {
    offsetX: cam.pos[0] - half,
    offsetY: cam.pos[2] - half,
    sizeX: size,
    sizeY: size,
  };
  frameCache.set(def.id, frame);
  return frame;
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
  const png = new PNG({ width: value.m_Width, height: value.m_Height });
  // Unity stores the DXT blocks bottom-up. One vertical flip puts high world Z at the top.
  // Existing files are skipped, so a later extract must not flip them again.
  png.data = flipVertical(rgba, value.m_Width, value.m_Height);
  fs.writeFileSync(outFile, PNG.sync.write(png));
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
  if (!asFloat(world._worldSize.x) || !asFloat(world._worldSize.y)) return [];
  const frame = mapFrame(def);
  const sizeX = frame.sizeX;
  const sizeY = frame.sizeY;
  const offsetX = frame.offsetX;
  const offsetY = frame.offsetY;
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
  if (!asFloat(world._worldSize.x) || !asFloat(world._worldSize.y)) return [];
  const frame = mapFrame(def);
  const sizeX = frame.sizeX;
  const sizeY = frame.sizeY;
  const offsetX = frame.offsetX;
  const offsetY = frame.offsetY;
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
  return found;
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
  if (!asFloat(world._worldSize.x) || !asFloat(world._worldSize.y)) return [];
  const bounds = mapFrame(def);
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
                const fitted = keepLand(pathPts);
                if (fitted.length) {
                  for (const group of fitted) paths.push(group);
                } else {
                  const mid = pathPts.reduce((s, p) => ({ left: s.left + p.left, top: s.top + p.top }), { left: 0, top: 0 });
                  mid.left /= pathPts.length;
                  mid.top /= pathPts.length;
                  // Covers that hug the void still belong to the landmark under their center.
                  if (onLand(mid)) paths.push(pathPts);
                }
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

const NPC_TOKENS = [
  ["elementalshop", "ElementalShop"],
  ["silverhook", "Silverhook"],
  ["vaulkaryn", "Vulkaryn"],
  ["vulkaryn", "Vulkaryn"],
  ["currenbringer", "CurrentBringer"],
  ["currentbringer", "CurrentBringer"],
  ["farstriker", "Farstriker"],
  ["milloween", "Milloween"],
  ["goldbelly", "Goldbelly"],
  ["priestess", "Priestess"],
  ["thalindra", "Thalindra"],
  ["oldcrone", "OldCrone"],
  ["drakthor", "Drakthor"],
  ["lanathar", "Lanathar"],
  ["gondrak", "Gondrak"],
  ["leiliel", "Leiliel"],
  ["vexxie", "Vexxie"],
  ["manapuff", "Wishy"],
  ["ruffles", "Ruffles"],
  ["emerith", "Emerith"],
  ["vorrak", "Vorrak"],
  ["aetos", "Aetos"],
  ["diona", "Diona"],
  ["doctor", "Doctor"],
  ["wishy", "Wishy"],
  ["jolo", "Jolo"],
  ["ryzor", "Ryzor"],
  ["hunter", "Hunter"],
  ["aurora", "Aurora"],
  ["sven", "Sven"],
];

const BOSS_TOKENS = [
  ["werewolfmagehowly", "WerewolfMageHowly"],
  ["werewolfmage", "WerewolfMage"],
  ["ghostwerewolf", "GhostWerewolf"],
  ["ghostelitewolf", "GhostEliteWolf"],
  ["ghostbandit", "GhostBandit"],
  ["ghostcrone", "GhostCrone"],
  ["blackwerewolf", "BlackWerewolf"],
  ["alphawolf", "EliteWolf"],
  ["elitewolf", "EliteWolf"],
  ["werewolfoneeye", "WerewolfOneEye"],
  ["oldoneeye", "OldOneEye"],
  ["spidermatriarch", "SpiderMatriarch"],
  ["matriarch", "SpiderMatriarch"],
  ["voidcleric", "VoidCleric"],
  ["forgottenchampion", "ForgottenChampion"],
  ["bearwandering", "BearWandering"],
  ["stonebear", "StoneBear"],
  ["redbear", "RedBear"],
  ["oldbear", "OldBear"],
  ["banditaleric", "BanditAleric"],
  ["aleric", "BanditAleric"],
  ["kingfisher", "KingFisher"],
  ["blueblazer", "BlueBlazer"],
  ["banditking", "BanditKing"],
  ["succubusboss", "SuccubusBoss"],
  ["succubus", "Succubus"],
  ["miniboss", "ScratMechSuitMiniBoss"],
  ["necronus", "Necronus"],
  ["howly", "WerewolfMageHowly"],
  ["widow", "Widow"],
];

function npcToken(name) {
  const compact = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const [needle, token] of NPC_TOKENS) {
    if (compact.includes(needle)) return token;
  }
  return "";
}

function bossToken(name) {
  const compact = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const [needle, token] of BOSS_TOKENS) {
    if (compact.includes(needle)) return token;
  }
  if (/^boss(grp)?$/i.test(name.replace(/[\s_]/g, ""))) return "Boss";
  return "";
}

function bossExcluded(name) {
  return /Gate|Pedestal|Terrain|Shadow|Visual|Concept|Contamination|Arena|BossRoom|BossLevel|Hatchery|Corpse|Vfx|Decal|Mdl|Audio|Postprocess|Debris|Debri|Explosion|Shroom|Dungeon|Chest|Water_|Reveal|Torch|Cluster|Amb_|Wind|Rune|Sleeping|Floating/i.test(name);
}

function collectActors(def) {
  const buf = fs.readFileSync(path.join(BUNDLE_DIR, def.scene));
  const info = bundleInfo(buf);
  const scene = info.nodes.find((n) => !n.path.includes("."));
  const data = extractRange(buf, info, scene.offset, scene.size);
  const sf = parseSerialized(data);
  const goType = sf.types.findIndex((t) => t.classId === 1);
  const trType = sf.types.findIndex((t) => t.classId === 4);
  const worldType = sf.types.findIndex((t) => typeHas(t.node, "_worldSize"));
  const worldObj = sf.objects.find((o) => o.typeId === worldType);
  if (!worldObj) return { npcs: [], bosses: [] };
  const world = readObject(sf, worldObj).value;
  if (!asFloat(world._worldSize.x) || !asFloat(world._worldSize.y)) return { npcs: [], bosses: [] };
  const frame = mapFrame(def);
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
    if (!obj || obj.typeId !== trType || depth > 40) return null;
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
  function placedOf(go) {
    const id = transformOf(go);
    return id ? worldOf(id, 0) : null;
  }
  function parentName(placed) {
    const fatherId = placed && placed.value.m_Father && String(placed.value.m_Father.pathId);
    if (!fatherId || fatherId === "0") return "";
    const father = worldOf(fatherId, 0);
    const go = father && byPath.get(String(father.value["#374"] && father.value["#374"].pathId));
    return goName(go);
  }
  function onMap(x, z) {
    const u = (x - frame.offsetX) / frame.sizeX;
    const v = (z - frame.offsetY) / frame.sizeY;
    if (u < -0.02 || u > 1.02 || v < -0.02 || v > 1.02) return null;
    const mapped = toMapPercent(x, z, frame.offsetX, frame.offsetY, frame.sizeX, frame.sizeY);
    return {
      left: Math.round(mapped.left * 10) / 10,
      top: Math.round(mapped.top * 10) / 10,
    };
  }
  function away(pos) {
    return pos && (Math.abs(pos[0]) > 2 || Math.abs(pos[2]) > 2);
  }
  function anchor(placed, depth) {
    if (!placed || depth > 4) return null;
    if (away(placed.pos)) return placed.pos;
    const kids = Array.isArray(placed.value.m_Children) ? placed.value.m_Children : [];
    for (const kid of kids) {
      const found = anchor(worldOf(kid.pathId, 0), depth + 1);
      if (found) return found;
    }
    return null;
  }
  function named(needle, test) {
    const bytes = Buffer.from(needle);
    const hits = [];
    const seen = new Set();
    let at = 0;
    while ((at = data.indexOf(bytes, at)) >= 0) {
      let start = at;
      while (start > 4 && data[start - 1] >= 32 && data[start - 1] < 127) start--;
      let end = at + needle.length;
      while (end < data.length && data[end] >= 32 && data[end] < 127) end++;
      const len = end - start;
      if (len >= needle.length && len < 96 && start >= 4 && data.readInt32LE(start - 4) === len) {
        const name = data.toString("utf8", start, end);
        if (!test || test(name)) {
          const go = findGo(start);
          if (go && !seen.has(go.byteStart)) {
            seen.add(go.byteStart);
            hits.push({ name, go });
          }
        }
      }
      at += needle.length;
    }
    return hits;
  }
  function childGo(placed, kid) {
    const child = worldOf(kid.pathId, 0);
    if (!child) return null;
    const go = byPath.get(String(child.value["#374"] && child.value["#374"].pathId));
    return { name: goName(go), placed: child };
  }
  const npcs = [];
  for (const folderName of ["Quest NPCs", "DV_Quests_Pref"]) {
    for (const folder of named(folderName, (name) => name === folderName)) {
      const placed = placedOf(folder.go);
      const kids = placed && Array.isArray(placed.value.m_Children) ? placed.value.m_Children : [];
      for (const kid of kids) {
        const child = childGo(placed, kid);
        if (!child) continue;
        const token = npcToken(child.name);
        if (!token) continue;
        const pos = anchor(child.placed, 0);
        const spot = pos && onMap(pos[0], pos[2]);
        if (!spot) continue;
        const fallback = child.name
          .replace(/\s*(quests|quest|unlock|hologram)\s*/ig, " ")
          .replace(/\s+/g, " ")
          .replace(/^[\s-]+|[\s-]+$/g, "");
        npcs.push({ token, fallback, left: spot.left, top: spot.top });
      }
    }
  }
  const bosses = [];
  const bossNeedles = ["WerewolfMage", "AlphaWolf", "EliteWolf", "BlackWerewolf", "OldBear", "KingFisher", "BlueBlazer", "OneEye", "Aleric", "VoidCleric", "GhostWerewolf", "GhostElite", "GhostBandit", "GhostCrone", "Matriarch", "Necronus", "Widow", "Succubus", "MiniBoss", "Howly", "Forgotten", "StoneBear", "RedBear", "Wandering", "Boss"];
  for (const needle of bossNeedles) {
    for (const hit of named(needle, (name) => !bossExcluded(name) && bossToken(name))) {
      const placed = placedOf(hit.go);
      if (!placed) continue;
      const token = bossToken(hit.name);
      const kids = Array.isArray(placed.value.m_Children) ? placed.value.m_Children : [];
      const childTokens = kids.map((kid) => childGo(placed, kid)).filter(Boolean);
      if (token === "Boss" && childTokens.some((child) => bossToken(child.name) && bossToken(child.name) !== "Boss")) continue;
      if (childTokens.some((child) => bossToken(child.name) === token && away(child.placed.pos) && (Math.abs(child.placed.pos[0] - placed.pos[0]) > 8 || Math.abs(child.placed.pos[2] - placed.pos[2]) > 8))) continue;
      const parent = parentName(placed);
      if (/^Set \d+$/.test(parent) || parent === "PerformanceScenarioMarkers") continue;
      if (!away(placed.pos)) continue;
      const spot = onMap(placed.pos[0], placed.pos[2]);
      if (!spot || spot.left < 0 || spot.left > 100 || spot.top < 0 || spot.top > 100) continue;
      const path = [];
      const seenPoint = [];
      for (const kid of (Array.isArray(placed.value.m_Children) ? placed.value.m_Children : [])) {
        const child = childGo(placed, kid);
        if (!child || !away(child.placed.pos)) continue;
        const point = onMap(child.placed.pos[0], child.placed.pos[2]);
        if (!point || point.left < 0 || point.top < 0 || point.left > 100 || point.top > 100) continue;
        if (Math.hypot(point.left - spot.left, point.top - spot.top) > 18) continue;
        const duplicate = seenPoint.some((prev) => Math.abs(prev.left - point.left) < 1.5 && Math.abs(prev.top - point.top) < 1.5);
        if (duplicate) continue;
        seenPoint.push(point);
        path.push(point);
      }
      let route = path;
      if (route.length >= 2) {
        const lefts = route.map((point) => point.left);
        const tops = route.map((point) => point.top);
        const span = Math.max(Math.max(...lefts) - Math.min(...lefts), Math.max(...tops) - Math.min(...tops));
        if (span > 28) route = [];
      } else route = [];
      bosses.push({
        token,
        fallback: token,
        left: spot.left,
        top: spot.top,
        path: route,
      });
    }
  }
  function dedupe(rows) {
    const kept = [];
    const occupied = new Set();
    for (const row of rows) {
      const key = row.token + ":" + Math.round(row.left) + ":" + Math.round(row.top);
      if (occupied.has(key)) continue;
      occupied.add(key);
      kept.push(row);
    }
    return kept;
  }
  return { npcs: dedupe(npcs), bosses: dedupe(bosses) };
}

function readMessagePack(view, at) {
  const b = view[at];
  if (b <= 0x7f) return { v: b, at: at + 1 };
  if (b >= 0xe0) return { v: b - 256, at: at + 1 };
  if ((b & 0xf0) === 0x80) {
    const n = b & 0x0f;
    const obj = {};
    at++;
    for (let i = 0; i < n; i++) {
      const key = readMessagePack(view, at);
      at = key.at;
      const val = readMessagePack(view, at);
      at = val.at;
      obj[String(key.v)] = val.v;
    }
    return { v: obj, at };
  }
  if ((b & 0xf0) === 0x90) {
    const n = b & 0x0f;
    const arr = [];
    at++;
    for (let i = 0; i < n; i++) {
      const val = readMessagePack(view, at);
      at = val.at;
      arr.push(val.v);
    }
    return { v: arr, at };
  }
  if ((b & 0xe0) === 0xa0) {
    const n = b & 0x1f;
    return { v: view.toString("utf8", at + 1, at + 1 + n), at: at + 1 + n };
  }
  if (b === 0xc0) return { v: null, at: at + 1 };
  if (b === 0xc2) return { v: false, at: at + 1 };
  if (b === 0xc3) return { v: true, at: at + 1 };
  if (b === 0xc4) { const n = view[at + 1]; return { v: null, at: at + 2 + n }; }
  if (b === 0xc5) { const n = view.readUInt16BE(at + 1); return { v: null, at: at + 3 + n }; }
  if (b === 0xc6) { const n = view.readUInt32BE(at + 1); return { v: null, at: at + 5 + n }; }
  if (b === 0xca) return { v: view.readFloatBE(at + 1), at: at + 5 };
  if (b === 0xcb) return { v: view.readDoubleBE(at + 1), at: at + 9 };
  if (b === 0xcc) return { v: view[at + 1], at: at + 2 };
  if (b === 0xcd) return { v: view.readUInt16BE(at + 1), at: at + 3 };
  if (b === 0xce) return { v: view.readUInt32BE(at + 1), at: at + 5 };
  if (b === 0xcf) return { v: view.readBigUInt64BE(at + 1).toString(), at: at + 9 };
  if (b === 0xd0) return { v: view.readInt8(at + 1), at: at + 2 };
  if (b === 0xd1) return { v: view.readInt16BE(at + 1), at: at + 3 };
  if (b === 0xd2) return { v: view.readInt32BE(at + 1), at: at + 5 };
  if (b === 0xd3) return { v: view.readBigInt64BE(at + 1).toString(), at: at + 9 };
  if (b === 0xd9) { const n = view[at + 1]; return { v: view.toString("utf8", at + 2, at + 2 + n), at: at + 2 + n }; }
  if (b === 0xda) { const n = view.readUInt16BE(at + 1); return { v: view.toString("utf8", at + 3, at + 3 + n), at: at + 3 + n }; }
  if (b === 0xdb) { const n = view.readUInt32BE(at + 1); return { v: view.toString("utf8", at + 5, at + 5 + n), at: at + 5 + n }; }
  if (b === 0xdc) {
    const n = view.readUInt16BE(at + 1);
    const arr = [];
    at += 3;
    for (let i = 0; i < n; i++) { const val = readMessagePack(view, at); at = val.at; arr.push(val.v); }
    return { v: arr, at };
  }
  if (b === 0xdd) {
    const n = view.readUInt32BE(at + 1);
    const arr = [];
    at += 5;
    for (let i = 0; i < n; i++) { const val = readMessagePack(view, at); at = val.at; arr.push(val.v); }
    return { v: arr, at };
  }
  if (b === 0xde) {
    const n = view.readUInt16BE(at + 1);
    const obj = {};
    at += 3;
    for (let i = 0; i < n; i++) { const key = readMessagePack(view, at); at = key.at; const val = readMessagePack(view, at); at = val.at; obj[String(key.v)] = val.v; }
    return { v: obj, at };
  }
  if (b === 0xdf) {
    const n = view.readUInt32BE(at + 1);
    const obj = {};
    at += 5;
    for (let i = 0; i < n; i++) { const key = readMessagePack(view, at); at = key.at; const val = readMessagePack(view, at); at = val.at; obj[String(key.v)] = val.v; }
    return { v: obj, at };
  }
  throw new Error("bad message pack " + b.toString(16) + " at " + at);
}

const SPAWN_POSITION = 2216820863;
const SPAWN_CHILDREN = 321568097;
const CHILD_POSITION = 1486226603;
const LOOT_TABLE = 1762408745;
const ITEM_PICKUP = 2741270443;

function authoringEntries(def) {
  const buf = fs.readFileSync(path.join(BUNDLE_DIR, def.camera));
  const info = bundleInfo(buf);
  const shared = info.nodes.find((n) => n.path.endsWith(".sharedAssets"));
  const data = extractRange(buf, info, shared.offset, shared.size);
  const sf = parseSerialized(data);
  let script = null;
  for (const obj of sf.objects) {
    if (!sf.types[obj.typeId] || sf.types[obj.typeId].classId !== 49) continue;
    const raw = data.slice(sf.dataOffset + obj.byteStart, sf.dataOffset + obj.byteStart + obj.byteSize);
    const nameLen = raw.readInt32LE(0);
    if (nameLen < 1 || nameLen > 80) continue;
    const name = raw.toString("utf8", 4, 4 + nameLen);
    if (!name.endsWith("_Authoring")) continue;
    const p = (4 + nameLen + 3) & ~3;
    const scriptLen = raw.readInt32LE(p);
    script = raw.slice(p + 4, p + 4 + scriptLen);
  }
  if (!script || script.slice(0, 4).toString("ascii") !== "HVAF") return [];
  return readMessagePack(script, script.readUInt16LE(6)).v[2] || [];
}

function collectSpawns(def) {
  const entries = authoringEntries(def);
  const frame = mapFrame(def);
  const points = [];
  for (const entry of entries) {
    const name = String(entry[0] || "");
    if (!name.startsWith("Authored_Spawn_")) continue;
    const pos = (entry[4] || []).find((comp) => Array.isArray(comp) && comp[0] === SPAWN_POSITION && Array.isArray(comp[1]) && comp[1].length === 2);
    if (!pos) continue;
    const x = pos[1][0] / 65536;
    const z = pos[1][1] / 65536;
    const spot = toMapPercent(x, z, frame.offsetX, frame.offsetY, frame.sizeX, frame.sizeY);
    if (spot.left < -1 || spot.left > 101 || spot.top < -1 || spot.top > 101) continue;
    const point = {
      unit: name.replace(/^Authored_Spawn_/, ""),
      left: Math.round(spot.left * 10) / 10,
      top: Math.round(spot.top * 10) / 10,
    };
    const route = patrolRoute(entry, frame);
    if (route.length >= 3) point.path = route;
    points.push(point);
  }
  return points;
}

function fixedPair(node) {
  const flat = [];
  const walk = (value) => {
    if (typeof value === "number") flat.push(value / 65536);
    else if (Array.isArray(value)) value.forEach(walk);
  };
  walk(node);
  return flat.length >= 2 ? [flat[0], flat[1]] : null;
}

function patrolRoute(entry, frame) {
  const nest = (entry[4] || []).find((comp) => Array.isArray(comp) && comp[0] === SPAWN_CHILDREN);
  const kids = nest && nest[1] && nest[1][4];
  if (!Array.isArray(kids)) return [];
  const world = [];
  for (const kid of kids) {
    const pos = (kid || []).find((comp) => Array.isArray(comp) && comp[0] === CHILD_POSITION);
    const pair = pos && fixedPair(pos[1]);
    if (pair) world.push(pair);
  }
  if (world.length < 3) return [];
  const xs = world.map((pair) => pair[0]);
  const zs = world.map((pair) => pair[1]);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
  if (span < 8) return [];
  const path = [];
  for (const [x, z] of world) {
    const spot = toMapPercent(x, z, frame.offsetX, frame.offsetY, frame.sizeX, frame.sizeY);
    if (spot.left < -2 || spot.left > 102 || spot.top < -2 || spot.top > 102) continue;
    const left = Math.round(spot.left * 10) / 10;
    const top = Math.round(spot.top * 10) / 10;
    const prev = path[path.length - 1];
    if (prev && prev.left === left && prev.top === top) continue;
    path.push({ left, top });
  }
  return path.length >= 3 ? path : [];
}

function collectLootPoints(def) {
  const entries = authoringEntries(def);
  const frame = mapFrame(def);
  const points = [];
  const seen = new Set();
  for (const entry of entries) {
    const table = (entry[4] || []).find((comp) => Array.isArray(comp) && comp[0] === LOOT_TABLE && Array.isArray(comp[1]) && typeof comp[1][0] === "number" && comp[1][0] > 0);
    const pos = (entry[4] || []).find((comp) => Array.isArray(comp) && comp[0] === SPAWN_POSITION && Array.isArray(comp[1]) && comp[1].length === 2);
    if (!table || !pos) continue;
    const x = pos[1][0] / 65536;
    const z = pos[1][1] / 65536;
    const spot = toMapPercent(x, z, frame.offsetX, frame.offsetY, frame.sizeX, frame.sizeY);
    if (spot.left < -1 || spot.left > 101 || spot.top < -1 || spot.top > 101) continue;
    const left = Math.round(spot.left * 10) / 10;
    const top = Math.round(spot.top * 10) / 10;
    const key = table[1][0] + ":" + left + ":" + top;
    if (seen.has(key)) continue;
    seen.add(key);
    points.push({ tableId: table[1][0], left, top });
  }
  return points;
}

function collectItemPickups(def) {
  const frame = mapFrame(def);
  const points = [];
  const seen = new Set();
  for (const entry of authoringEntries(def)) {
    const name = String(entry[0] || "");
    if (!name.startsWith("Authored_ItemPickup")) continue;
    const pickup = (entry[4] || []).find((comp) => Array.isArray(comp) && comp[0] === ITEM_PICKUP && Array.isArray(comp[1]));
    const pos = (entry[4] || []).find((comp) => Array.isArray(comp) && comp[0] === SPAWN_POSITION && Array.isArray(comp[1]) && comp[1].length === 2);
    if (!pickup || !pos) continue;
    const item = pickup[1][0];
    const amount = pickup[1][1];
    if (!(item > 0) || !(amount > 0)) continue;
    const spot = mapSpot(frame, pos[1][0] / 65536, pos[1][1] / 65536);
    if (!spot) continue;
    const key = item + ":" + amount + ":" + spot.left + ":" + spot.top;
    if (seen.has(key)) continue;
    seen.add(key);
    points.push({ item, amount, left: spot.left, top: spot.top });
  }
  points.sort((a, b) => a.item - b.item || a.top - b.top || a.left - b.left || a.amount - b.amount);
  return points;
}

function nestedPair(node) {
  if (!Array.isArray(node) || node.length < 2) return null;
  const x = Array.isArray(node[0]) ? node[0][0] : node[0];
  const z = Array.isArray(node[1]) ? node[1][0] : node[1];
  if (typeof x !== "number" || typeof z !== "number") return null;
  return [x / 65536, z / 65536];
}

function mapSpot(frame, x, z) {
  const spot = toMapPercent(x, z, frame.offsetX, frame.offsetY, frame.sizeX, frame.sizeY);
  if (spot.left < -1 || spot.left > 101 || spot.top < -1 || spot.top > 101) return null;
  return { left: Math.round(spot.left * 10) / 10, top: Math.round(spot.top * 10) / 10 };
}

function collectTeleportLinks(def, byKey) {
  const shrineTitle = (byKey && byKey.get("BuildingUpgradeLibraryTier2Name")) || "";
  const balloonTitle = (byKey && byKey.get("MapName_BalloonPad")) || "";
  const frame = mapFrame(def);
  const shrines = [];
  const balloons = [];
  for (const entry of authoringEntries(def)) {
    const name = String(entry[0] || "");
    const shrine = name.startsWith("Authored_POI_TeleportShrine");
    const balloon = /^Authored_BalloonTeleport(?:_\d+)?$/.test(name);
    if (!shrine && !balloon) continue;
    const pos = (entry[4] || []).find((comp) => Array.isArray(comp) && comp[0] === SPAWN_POSITION && Array.isArray(comp[1]) && comp[1].length === 2);
    const link = (entry[4] || []).find((comp) => Array.isArray(comp) && comp[0] === (shrine ? 1028502046 : 4272233776));
    if (!pos || !link) continue;
    const here = mapSpot(frame, pos[1][0] / 65536, pos[1][1] / 65536);
    const targetPair = nestedPair(link[1] && link[1][0]);
    const target = targetPair && mapSpot(frame, targetPair[0], targetPair[1]);
    if (!here || !target) continue;
    if (shrine) shrines.push({ id: link[1][1], here, target });
    else balloons.push({ here, target });
  }
  const links = [];
  const seenShrine = new Set();
  for (const point of shrines) {
    if (seenShrine.has(point)) continue;
    const other = shrines.find((item) => item !== point && item.id === point.id);
    if (!other || !shrineTitle) continue;
    seenShrine.add(point);
    seenShrine.add(other);
    links.push({ title: shrineTitle, a: point.here, b: other.here });
  }
  const seenBalloon = new Set();
  for (const point of balloons) {
    if (seenBalloon.has(point) || !balloonTitle) continue;
    let other = null;
    let best = 4;
    for (const candidate of balloons) {
      if (candidate === point || seenBalloon.has(candidate)) continue;
      const distance = Math.hypot(point.target.left - candidate.here.left, point.target.top - candidate.here.top);
      if (distance < best) {
        other = candidate;
        best = distance;
      }
    }
    if (!other) continue;
    const back = Math.hypot(other.target.left - point.here.left, other.target.top - point.here.top);
    if (back > 4) continue;
    seenBalloon.add(point);
    seenBalloon.add(other);
    links.push({ title: balloonTitle, a: point.here, b: other.here });
  }
  return links;
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
    const actors = collectActors(def);
    const links = collectTeleportLinks(def, byKey);
    const pickups = collectItemPickups(def);
    console.log("map", title, "pins", pins.length, "regions", regions.length, "entrances", entrances.length, "npcs", actors.npcs.length, "bosses", actors.bosses.length, "paths", actors.bosses.filter((boss) => boss.path.length >= 2).length, "links", links.length, "pickups", pickups.length);
    maps.push({ id: def.id, title, image: file, pins, regions, entrances, links, pickups, npcs: actors.npcs, bosses: actors.bosses });
  }
  return maps;
}

module.exports = { extractGameMaps, collectRegions, collectEntrances, collectActors, collectSpawns, collectLootPoints, collectItemPickups, collectTeleportLinks, MAP_DEFS, bundleInfo, extractRange, asFloat, BUNDLE_DIR };
