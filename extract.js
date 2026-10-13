const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const { parseUnityFS, extractNode } = require("./unityfs");
const { parseSerialized, readObject } = require("./serialized");
const { decodeTexture } = require("./dxt");
const { extractGameMaps } = require("./maps");
const { fillCreaturePortraits } = require("./render-creatures");

const ROOT = __dirname;
const GAME = path.resolve(ROOT, "..");
const BUNDLE_DIR = path.join(GAME, "Vaultbreakers_Data", "StreamingAssets", "aa", "StandaloneWindows64");
const CONFIG_BUNDLE = "0563f413959c8f3465f5b3d19fece440.bundle";
const ICON_BUNDLE = "d690eafe8fe5a7e08f9f6fa44534a52e.bundle";
const ZH_BUNDLE = "4ce0a894b5e7192d33184335bd5bec42.bundle";
const SHARED_STRINGS_BUNDLE = "0be045fb94ecb50bb5159a32ba66c0a4.bundle";
const DUMP = path.join(ROOT, "il2cpp", "dump.cs");

const RARITY = ["普通", "优秀", "稀有", "至高", "传说", "任务", "诅咒"];
const DROP_MODE = { 0: "权重", 1: "概率" };
const OUTCOME = { 0: "物品", 1: "子掉落表", 2: "配方" };
const ELEMENT_FLAGS = [
  [2, "仅本职业可用"],
  [4, "占位"],
  [8, "忽略稀有度"],
  [16, "配方书"],
];

function parseEnum(text, name) {
  const start = text.indexOf(`public enum ${name}`);
  if (start < 0) throw new Error("missing enum " + name);
  const end = text.indexOf("\n}", start);
  const body = text.slice(start, end);
  const map = {};
  const nameToId = {};
  for (const m of body.matchAll(/public const \w+ (\w+) = (-?\d+);/g)) {
    map[m[2]] = m[1];
    nameToId[m[1]] = Number(m[2]);
  }
  return { map, nameToId };
}

function parseSearchMeta(text) {
  const byClass = {};
  const re = /\[SearchPath\("([^"]*)"\)\]\s*\[SearchName\("([^"]*)"\)\]\s*public class (\w+)/g;
  for (const m of text.matchAll(re)) {
    byClass[m[3]] = { path: m[1], name: m[2] };
  }
  const re2 = /\[SearchName\("([^"]*)"\)\]\s*\[SearchPath\("([^"]*)"\)\]\s*public class (\w+)/g;
  for (const m of text.matchAll(re2)) {
    byClass[m[3]] = { path: m[2], name: m[1] };
  }
  return byClass;
}

function asString(v) {
  if (typeof v === "string") return v;
  if (!Array.isArray(v) || v.length === 0 || v.length > 240) return null;
  if (!v.every((x) => typeof x === "number" && x >= 32 && x < 127)) return null;
  return Buffer.from(v).toString("utf8");
}

function utf8(v) {
  if (typeof v === "string") return v;
  if (!Array.isArray(v) || v.length === 0 || v.length > 8000) return null;
  if (!v.every((x) => typeof x === "number" && x >= 0 && x < 256)) return null;
  return Buffer.from(v).toString("utf8");
}

function displayText(value) {
  if (!value) return "";
  const text = value
    .replace(/<[^>]*>/g, "")
    .replace(/\{@[^}]*\}/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

function readSharedStringKeys(sf, obj) {
  const buf = sf.buf;
  let o = sf.dataOffset + obj.byteStart;
  const u8 = () => buf[o++];
  const i32 = () => {
    const v = buf.readInt32LE(o);
    o += 4;
    return v;
  };
  const i64 = () => {
    const v = buf.readBigInt64LE(o).toString();
    o += 8;
    return v;
  };
  const align = () => {
    o = (o + 3) & ~3;
  };
  const str = () => {
    const n = i32();
    if (n < 0 || n > 200000) throw new Error("bad shared string");
    const s = buf.toString("utf8", o, o + n);
    o += n;
    align();
    return s;
  };
  o += 4 + 8;
  u8();
  align();
  o += 4 + 8;
  str();
  const collection = str();
  str();
  const count = i32();
  const keyToId = new Map();
  for (let i = 0; i < count; i++) {
    const id = i64();
    const key = str();
    const metaCount = i32();
    o += metaCount * 8;
    if (key) keyToId.set(key, id);
  }
  return { collection, keyToId };
}

function loadChinese() {
  const bundle = loadBundle(ZH_BUNDLE);
  const node = bundle.nodes.find((n) => !n.path.includes("."));
  const sf = parseSerialized(extractNode(bundle, node));
  const byId = new Map();
  for (const obj of sf.objects) {
    let value;
    try {
      value = readObject(sf, obj).value;
    } catch {
      continue;
    }
    const name = utf8(value["#427"]);
    if (!name || !name.endsWith("_zh")) continue;
    for (const row of value.m_TableData || []) {
      const text = utf8(row.m_Localized);
      if (text && text.trim()) byId.set(String(row.m_Id), text);
    }
  }

  const shared = loadBundle(SHARED_STRINGS_BUNDLE);
  const sharedNode = shared.nodes.find((n) => n.path === "CAB-51fbaa50979881bfde5cd85c584e1d3c");
  const sharedSf = parseSerialized(extractNode(shared, sharedNode));
  const keyToId = new Map();
  for (const obj of sharedSf.objects) {
    if (!sharedSf.types[obj.typeId] || sharedSf.types[obj.typeId].node.type !== "#263") continue;
    const tree = sharedSf.types[obj.typeId].node;
    if (!tree.children.some((child) => child.name === "m_TableCollectionName")) continue;
    let parsed;
    try {
      parsed = readSharedStringKeys(sharedSf, obj);
    } catch {
      continue;
    }
    if (parsed.collection !== "DefaultStrings" && parsed.collection !== "QuestStrings") continue;
    for (const [key, id] of parsed.keyToId) keyToId.set(key, id);
  }

  const byKey = new Map();
  for (const [key, id] of keyToId) {
    const text = byId.get(id);
    if (text) byKey.set(key, text);
  }
  const resolve = (text, depth) => {
    if (!text || depth > 6 || !text.includes("{@")) return text;
    return text.replace(/\{@([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\}/g, (token, _table, key) => {
      const next = byKey.get(key);
      return next ? resolve(next, depth + 1) : token;
    });
  };
  for (const [id, text] of byId) {
    const expanded = displayText(resolve(text, 0));
    if (expanded) byId.set(id, expanded);
    else byId.delete(id);
  }
  byKey.clear();
  for (const [key, id] of keyToId) {
    const text = byId.get(id);
    if (text) byKey.set(key, text);
  }
  return { byId, byKey };
}

function fixedBytes(node) {
  const value = node && node._fixedBuffer && node._fixedBuffer.Value;
  if (!Array.isArray(value) || !value.length) return null;
  return Buffer.from(value);
}

function readMapIds(node) {
  const buf = fixedBytes(node);
  if (!buf) return [];
  const count = Math.max(0, Math.min(node._length | 0, 16));
  const ids = [];
  for (let i = 0; i < count; i++) {
    if (i * 4 + 4 <= buf.length) ids.push(buf.readInt32LE(i * 4));
    else if (i < buf.length) ids.push(buf[i]);
  }
  return ids.filter((id) => id >= 0);
}

function assetAlias(name) {
  return String(name || "")
    .replace(/ConfigurationAsset$/, "")
    .replace(/Item$/, "")
    .replace(/^ConsumableFood/, "")
    .replace(/^Consumable/, "")
    .replace(/^Food/, "")
    .toLowerCase();
}

function walk(value, fn) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (value.length && typeof value[0] === "number") return;
    for (const item of value) walk(item, fn);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    fn(key, child);
    walk(child, fn);
  }
}

function decodeElements(bytes, length) {
  const buf = Buffer.from(bytes);
  const out = [];
  const stride = 0x50;
  const count = Math.min(length, Math.floor(buf.length / stride));
  for (let i = 0; i < count; i++) {
    const o = i * stride;
    const rarityLen = buf.readInt32LE(o + 0x20);
    const rarities = [];
    const n = Math.max(0, Math.min(rarityLen, 16));
    for (let r = 0; r < n; r++) rarities.push(buf.readInt16LE(o + 0x24 + r * 2));
    const flags = buf.readInt32LE(o + 0x48);
    out.push({
      min: buf.readInt32LE(o),
      max: buf.readInt32LE(o + 4),
      dropMode: buf.readUInt8(o + 8),
      weight: buf.readInt16LE(o + 0x0a),
      percent: Number(buf.readBigInt64LE(o + 0x10)) / 65536,
      outcome: buf.readUInt8(o + 0x18),
      item: buf.readUInt16LE(o + 0x1a),
      nested: buf.readInt32LE(o + 0x1c),
      rarities,
      overrideChild: buf.readUInt8(o + 0x44) !== 0,
      flags,
      recipe: buf.readUInt16LE(o + 0x4c),
    });
  }
  return out;
}

function rotate180(rgba, width, height) {
  const out = Buffer.alloc(rgba.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = ((height - 1 - y) * width + (width - 1 - x)) * 4;
      out[dst] = rgba[src];
      out[dst + 1] = rgba[src + 1];
      out[dst + 2] = rgba[src + 2];
      out[dst + 3] = rgba[src + 3];
    }
  }
  return out;
}

function pretty(id) {
  if (!id) return "";
  return id
    .replace(/ConfigurationAsset$/, "")
    .replace(/ConfigurationValues$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function loadBundle(name) {
  return parseUnityFS(fs.readFileSync(path.join(BUNDLE_DIR, name)));
}

function main() {
  console.log("reading enums");
  const dump = fs.readFileSync(DUMP, "utf8");
  const items = parseEnum(dump, "ItemType");
  const tables = parseEnum(dump, "DropTableType");
  const maps = parseEnum(dump, "MapType");
  const textIds = parseEnum(dump, "TextStringId");
  const search = parseSearchMeta(dump);
  console.log("items", Object.keys(items.map).length, "tables", Object.keys(tables.map).length, "search", Object.keys(search).length);

  console.log("reading configurations");
  const config = loadBundle(CONFIG_BUNDLE);
  const node = config.nodes.find((n) => n.path.endsWith(".sharedAssets"));
  const sf = parseSerialized(extractNode(config, node));
  const dropTables = [];
  const sources = [];
  const nameIds = {};
  const assetMaps = {};
  const iconFiles = {};
  let failed = 0;
  let read = 0;
  for (const obj of sf.objects) {
    let value;
    try {
      value = readObject(sf, obj).value;
    } catch {
      failed++;
      continue;
    }
    read++;
    let assetName = null;
    let nameKey = null;
    let shownId = 0;
    let mapIds = null;
    let portrait = "";
    let iconFile = "";
    const strings = [];
    const tableRefs = [];
    let embedded = null;
    walk(value, (key, child) => {
      const text = asString(child);
      if (text) {
        if (!assetName && /ConfigurationAsset$/.test(text)) assetName = text;
        if (text.endsWith(".png") || text.endsWith("_Sprite") || /Portrait|Icon/i.test(text)) strings.push(text);
      }
      if (key === "NameLocalized" && child && child.m_TableEntryReference) {
        const id = String(child.m_TableEntryReference.m_KeyId || "");
        if (id && id !== "0") nameKey = id;
      }
      if (key === "ShownUnitNameId" && typeof child === "number" && child > 0) shownId = child;
      if (key === "PortraitSpriteName") {
        const portraitName = asString(child);
        if (portraitName && portraitName !== "TempIcon") portrait = portraitName.replace(/\.png$/i, "");
      }
      if (key === "IconFileName") {
        const iconName = asString(child);
        if (iconName && iconName !== "TempIcon") iconFile = iconName.replace(/\.png$/i, "");
      }
      if (key === "Locations" && child && child._length > 0) mapIds = readMapIds(child);
      if (key === "DropTableConfigurationValues" && child && child.Elements && Array.isArray(child.Elements._fixedBuffer?.Value)) {
        embedded = child;
      }
      if (/DropTable$/.test(key) && typeof child === "number" && child > 0 && key !== "TotalWeight") {
        tableRefs.push({ field: key, id: child });
      }
    });
    if (assetName && nameKey) nameIds[assetName] = nameKey;
    if (assetName && mapIds && mapIds.length) assetMaps[assetName] = mapIds;
    if (assetName && iconFile) iconFiles[assetName] = iconFile;
    if (!assetName) {
      walk(value, (key, child) => {
        if (assetName) return;
        const text = asString(child);
        if (text && text.length > 3 && !text.includes(" ")) assetName = text;
      });
    }
    if (!assetName) continue;
    const meta = search[assetName] || {};
    if (embedded) {
      const enumName = assetName.replace(/ConfigurationAsset$/, "");
      const entries = decodeElements(embedded.Elements._fixedBuffer.Value, embedded.Elements._length);
      dropTables.push({
        id: tables.nameToId[enumName] ?? null,
        enumName,
        asset: assetName,
        title: meta.name || pretty(enumName),
        category: meta.path || "DropTables",
        totalWeight: embedded.TotalWeight,
        entries,
      });
    }
    if (tableRefs.length && !embedded) {
      sources.push({
        asset: assetName,
        title: meta.name || pretty(assetName),
        category: meta.path || "其他",
        refs: tableRefs,
        hints: [...new Set(strings)].slice(0, 6),
        shownId,
        portrait,
        iconFile,
      });
    }
  }
  console.log("read", read, "failed", failed, "tables", dropTables.length, "sources", sources.length);

  console.log("exporting icons");
  const iconBundle = loadBundle(ICON_BUNDLE);
  const iconNode = iconBundle.nodes.find((n) => !n.path.includes("."));
  const iconSf = parseSerialized(extractNode(iconBundle, iconNode));
  const resNode = iconBundle.nodes.find((n) => n.path.endsWith(".resS"));
  const resS = extractNode(iconBundle, resNode);
  const texType = iconSf.types.findIndex((t) => {
    let hit = false;
    (function w(nd) {
      if (!nd) return;
      if (nd.name === "m_TextureFormat") hit = true;
      for (const c of nd.children || []) w(c);
    })(t.node);
    return hit;
  });
  const iconDir = path.join(ROOT, "icons");
  fs.mkdirSync(iconDir, { recursive: true });
  const icons = {};
  let exported = 0;
  let skippedFmt = 0;
  for (const obj of iconSf.objects) {
    if (obj.typeId !== texType) continue;
    let value;
    try {
      value = readObject(iconSf, obj).value;
    } catch {
      continue;
    }
    const name = asString(value["#427"]);
    if (!name) continue;
    const file = name.replace(/[^\w.\-]+/g, "_") + ".png";
    icons[name.toLowerCase()] = "icons/" + file;
    if (fs.existsSync(path.join(iconDir, file))) continue;
    const stream = value.m_StreamData;
    const size = stream && Number(stream["#795"] || 0);
    const offset = stream ? Number(stream.offset) : 0;
    if (!size || offset + size > resS.length) continue;
    const raw = resS.subarray(offset, offset + size);
    const rgba = decodeTexture(value.m_TextureFormat, raw, value.m_Width, value.m_Height);
    if (!rgba) {
      skippedFmt++;
      continue;
    }
    const png = new PNG({ width: value.m_Width, height: value.m_Height });
    png.data = rotate180(rgba, value.m_Width, value.m_Height);
    fs.writeFileSync(path.join(iconDir, file), PNG.sync.write(png));
    exported++;
  }
  console.log("icons", exported, "unknown format", skippedFmt);
  let extraPortraits = 0;
  for (const file of fs.readdirSync(BUNDLE_DIR)) {
    const fp = path.join(BUNDLE_DIR, file);
    const stat = fs.statSync(fp);
    if (!stat.isFile() || stat.size > 1024 * 1024 || stat.size < 1000) continue;
    const raw = fs.readFileSync(fp);
    if (raw.indexOf("_Portrait") < 0) continue;
    let bundle;
    try {
      bundle = parseUnityFS(raw);
    } catch {
      continue;
    }
    const cab = bundle.nodes.find((n) => !n.path.includes("."));
    const res = bundle.nodes.find((n) => n.path.endsWith(".resS"));
    if (!cab || !res) continue;
    let portraitSf;
    try {
      portraitSf = parseSerialized(extractNode(bundle, cab));
    } catch {
      continue;
    }
    const portraitRes = extractNode(bundle, res);
    for (const obj of portraitSf.objects) {
      let value;
      try {
        value = readObject(portraitSf, obj).value;
      } catch {
        continue;
      }
      const name = asString(value["#427"]);
      if (!name || value.m_TextureFormat == null) continue;
      const outName = name.replace(/[^\w.\-]+/g, "_") + ".png";
      const outPath = path.join(iconDir, outName);
      icons[name.toLowerCase()] = "icons/" + outName;
      if (fs.existsSync(outPath)) continue;
      const stream = value.m_StreamData;
      const size = stream && Number(stream["#795"] || 0);
      const offset = stream ? Number(stream.offset) : 0;
      if (!size || offset + size > portraitRes.length) continue;
      const rgba = decodeTexture(value.m_TextureFormat, portraitRes.subarray(offset, offset + size), value.m_Width, value.m_Height);
      if (!rgba) continue;
      const upright = rotate180(rgba, value.m_Width, value.m_Height);
      const png = new PNG({ width: value.m_Width, height: value.m_Height });
      png.data = upright;
      fs.writeFileSync(outPath, PNG.sync.write(png));
      extraPortraits++;
    }
  }
  console.log("extra portraits", extraPortraits);

  console.log("reading Chinese strings");
  const { byId: chinese, byKey } = loadChinese();
  function gameName(raw) {
    if (!raw) return "";
    const bases = new Set();
    const add = (value) => {
      if (!value || bases.has(value)) return;
      bases.add(value);
      add(value.replace(/ConfigurationAsset$/, ""));
      add(value.replace(/Table$/, ""));
      add(value.replace(/^AdvancedNPC_/, ""));
      add(value.replace(/^AdvancedNpc_/, ""));
      add(value.replace(/(InMatch|InLobby)$/, ""));
    };
    add(raw);
    const keys = [];
    for (const base of bases) {
      keys.push(
        "UnitName_" + base,
        "Name_" + base,
        base + "Name",
        "MapName_" + base,
        "Mapname_" + base,
        "BuildingName_" + base,
        "Name_AdvancedNPC_" + base,
        "Name_AdvancedNpc_" + base
      );
    }
    for (const key of keys) {
      const text = byKey.get(key);
      if (text && text.length <= 40 && !text.includes("\n") && /[\u4e00-\u9fff]/.test(text)) return text;
    }
    return "";
  }
  function describeTable(enumName) {
    const roles = [
      [/CraftingMatTable$/, "材料"],
      [/ValuableTable$/, "贵重"],
      [/CraftingTable$/, "制作"],
    ];
    for (const [pattern, role] of roles) {
      if (!pattern.test(enumName)) continue;
      const base = enumName.replace(pattern, "");
      const who = byKey.get("UnitName_" + base) || byKey.get("Name_" + base);
      if (who) return who + role;
    }
    return "";
  }
  function describeLoot(enumName) {
    if (!/Chest|Lockbox|LockBox|DirtMound|BahraCache/.test(enumName)) return null;
    let role = "";
    let name = enumName;
    if (name.endsWith("CraftingMatTable")) {
      role = "材料";
      name = name.slice(0, -"CraftingMatTable".length);
    } else if (name.endsWith("ValuableTable")) {
      role = "贵重";
      name = name.slice(0, -"ValuableTable".length);
    } else if (name.endsWith("Table")) name = name.slice(0, -5);
    const raw = (key) => byKey.get(key) || "";
    const clean = (key) => raw(key).replace(/\s+/g, "");
    const banditStash = clean("BanditStashKeyName").replace(/钥匙$/, "");
    const bandit = banditStash.startsWith("强盗") ? "强盗" : "";
    const scrat = clean("MapName_ScratOutpost").startsWith("嘶科鼠") ? "嘶科鼠" : "";
    const ghost = clean("PhantomBraceletName").startsWith("幽灵") ? "幽灵" : "";
    const stash = clean("BahrasChest").endsWith("藏匿点") ? "藏匿点" : "";
    const box = raw("QuestInteractUnopenedChestFewDescription").includes("宝箱") ? "宝箱" : "";
    const small = clean("ChestSmallName");
    const large = clean("ChestLargeName");
    const huge = clean("ChestVeryLargeName");
    const ashenSmall = clean("SmallAshenclawChest");
    const ashen = clean("AshenclawChest");
    const ashenGreat = clean("GreaterAshenclawChest");
    const digit = (name.match(/(\d+)(?!.*\d)/) || [])[1] || "";
    const withRole = (title) => (role ? title + "·" + role : title);
    const withDigit = (title) => (digit && !title.includes(digit) ? title + " " + digit : title);
    let title = "";
    let place = "";
    let look = "";
    let icon = icons.chestsmall || null;
    if (/DirtMoundLarge/.test(name)) {
      title = clean("Name_HiddenLoot") + "·" + large;
      look = raw("HiddenLootWelcomeText").replace(/。$/, "");
      icon = icons.chestlarge || icon;
    } else if (/DirtMound/.test(name)) {
      title = clean("Name_HiddenLoot") + "·" + small;
      look = raw("HiddenLootWelcomeText").replace(/。$/, "");
    } else if (/ScratJunk/.test(name)) {
      title = raw("SearchScrapPile").replace(/^搜索/, "");
      place = clean("MapName_Junkyard");
      look = title;
      icon = icons.chestofscrap || icon;
    } else if (/ScratTent/.test(name)) {
      look = raw("SearchTent").replace(/^搜索/, "");
      title = scrat + look;
    } else if (/OilPurifier/.test(name)) {
      title = raw("SearchPurifier");
      look = title.replace(/^搜搜/, "") || title;
    } else if (/ScratLock/.test(name)) {
      title = scrat + stash;
      look = stash;
    } else if (/BanditLock/.test(name)) {
      title = banditStash || bandit + stash;
      look = stash;
    } else if (/GhostLock/.test(name)) {
      title = ghost + stash;
      look = stash;
    } else if (/LockBox|Lockbox/.test(name)) {
      title = stash;
      look = stash;
    } else if (/DesertBeastDen/.test(name)) {
      title = clean("MapName_RockmuncherLair");
      place = title;
      look = raw("SearchDen").replace(/^搜索/, "");
    } else if (/WolfsDen/.test(name)) {
      const den = raw("SearchDen").replace(/^搜索/, "");
      title = clean("UnitName_Wolf") + den;
      look = den;
    } else if (/GreaterVoidPortal/.test(name)) {
      title = clean("MapName_GreaterVoidPortal") + box;
      place = clean("MapName_GreaterVoidPortal");
      look = huge;
      icon = "icons/ChestWarforge.png";
    } else if (/RocketCrash/.test(name)) {
      look = raw("RocketLaunchCrashNotificationMessage").replace(/[！!。]/g, "");
      title = look + box;
      place = clean("MapName_Refinery");
      icon = icons.chestlarge || icon;
    } else if (/DroppedLoot/.test(name)) {
      title = clean("Loot");
      look = title;
    } else if (/DVChest/.test(name)) {
      title = withDigit(clean("MapName_Dragonvault") + box + "掉落集合");
      place = clean("MapName_Dragonvault");
      look = huge;
      icon = "icons/ChestDragonGold.png";
    } else if (/VaultChest/.test(name)) {
      title = withDigit(clean("MapName_Dragonvault") + box);
      place = clean("MapName_Dragonvault");
      look = huge;
      icon = "icons/ChestDragonGold.png";
    } else if (/ExtraHigh2/.test(name)) {
      title = withDigit(ashenGreat);
      look = ashen;
      icon = "icons/ChestDragonSilver.png";
    } else if (/ExtraHigh/.test(name)) {
      title = ashenGreat;
      look = ashen;
      icon = "icons/ChestDragonGold.png";
    } else if (/High/.test(name)) {
      title = ashenSmall;
      look = ashenSmall;
      icon = "icons/ChestDragonGold.png";
    } else if (/Large/.test(name)) {
      title = large;
      look = large;
      icon = icons.chestlarge || icon;
    } else if (/Medium/.test(name)) {
      const who = /Ghost/.test(name) ? ghost : /Scrat/.test(name) ? scrat : "";
      if (!who) return null;
      title = who + box;
      look = box;
      icon = /Scrat/.test(name) ? "icons/ChestScrat.png" : (icons.chestlarge || icon);
    } else if (/Ghost/.test(name)) {
      title = ghost + small;
      look = small;
    } else if (/Bandit/.test(name)) {
      title = bandit + small;
      look = small;
    } else if (/Scrat/.test(name)) {
      title = scrat + small;
      look = small;
    } else if (/BahraCache/.test(name)) {
      title = clean("BahrasChest");
      look = title;
      icon = "icons/ChestBahra.png";
    } else return null;
    if (!title || !/[\u4e00-\u9fff]/.test(title)) return null;
    return { title: withRole(title), place, look, icon };
  }
  function placeName(mapId) {
    const name = maps.map[String(mapId)];
    if (!name || name === "Invalid") return "";
    return byKey.get("MapName_" + name) || byKey.get("Mapname_" + name) || byKey.get("MapSelectionName_" + name) || "";
  }
  function placesFor(assetName) {
    const ids = assetMaps[assetName] || [];
    return [...new Set(ids.map(placeName).filter(Boolean))];
  }
  function placesForEnum(enumName) {
    const exact = enumName + "ConfigurationAsset";
    if (assetMaps[exact]) return placesFor(exact);
    const alias = assetAlias(enumName);
    const hit = Object.keys(assetMaps).find((asset) => assetAlias(asset) === alias);
    return hit ? placesFor(hit) : [];
  }
  const aliasAssets = new Map();
  for (const assetName of Object.keys(nameIds)) {
    const alias = assetAlias(assetName);
    if (!aliasAssets.has(alias)) aliasAssets.set(alias, []);
    aliasAssets.get(alias).push(assetName);
  }
  function textForAsset(assetName) {
    const id = assetName && nameIds[assetName];
    return (id && chinese.get(id)) || "";
  }
  function localizedTitle(assetName, fallback) {
    return textForAsset(assetName) || fallback;
  }
  function localizedItemTitle(enumName, fallback) {
    const exact = textForAsset(enumName + "ConfigurationAsset");
    if (exact) return exact;
    const linkedAssets = {
      ConsumableExplosiveBarrel: "ExplodableBarrelItemConfigurationAsset",
    };
    const linked = textForAsset(linkedAssets[enumName] || "");
    if (linked && /[\u4e00-\u9fff]/.test(linked)) return linked;
    const hits = aliasAssets.get(assetAlias(enumName)) || [];
    if (hits.length === 1) return textForAsset(hits[0]) || fallback;
    return fallback;
  }
  let translated = 0;
  for (const id of Object.values(nameIds)) if (chinese.get(id)) translated++;
  console.log("localized names", translated, "of", Object.keys(nameIds).length, "strings", chinese.size);

  function iconFor(name) {
    if (!name) return null;
    const base = String(name).replace(/\.png$/i, "").replace(/_sprite$/i, "").replace(/^.*[\\/]/, "").toLowerCase();
    return icons[base] || null;
  }

  const itemList = Object.entries(items.nameToId)
    .filter(([name, id]) => id > 0 && name !== "INVALID")
    .map(([name, id]) => {
      const meta = search[name + "ConfigurationAsset"] || search[name] || {};
      const iconKey = (meta.name || name).replace(/\s+/g, "");
      const english = meta.name || pretty(name);
      return {
        id,
        name,
        english,
        places: placesForEnum(name),
        title: localizedItemTitle(name, english),
        icon: iconFor(iconFiles[name + "ConfigurationAsset"]) || iconFor(iconFiles[name]) || iconFor(name) || iconFor(iconKey) || iconFor("RegularItem" + name) || iconFor("NamedItem" + name.replace(/^NamedItem/, "")) || null,
      };
    });
  const itemById = Object.fromEntries(itemList.map((it) => [it.id, it]));
  console.log("item icons", itemList.filter((it) => it.icon).length, "of", itemList.length, "icon names", Object.keys(iconFiles).length);
  const tableById = {};
  for (const table of dropTables) {
    if (table.id != null) tableById[table.id] = table.enumName;
    for (const entry of table.entries) {
      entry.itemName = itemById[entry.item]?.title || items.map[String(entry.item)] || (entry.item ? "#" + entry.item : "");
      entry.itemEnglish = itemById[entry.item]?.english || "";
      entry.itemIcon = itemById[entry.item]?.icon || iconFor(items.map[String(entry.item)] || "") || null;
      entry.nestedEnum = entry.nested ? (tables.map[String(entry.nested)] || "") : "";
      entry.nestedName = entry.nestedEnum ? pretty(entry.nestedEnum) : (entry.nested ? "#" + entry.nested : "");
      entry.flagText = ELEMENT_FLAGS.filter(([bit]) => entry.flags & bit).map(([, label]) => label);
    }
  }
  function sourceCategory(text) {
    const t = text.toLowerCase();
    if (/furnace|workbench|shop|vendor|doctor|fireplace|crafting|blacksmith|potion device/.test(t)) return "工坊与商人";
    if (/chest|lockbox|lock box|dirt mound|crate|urn|loot pile/.test(t)) return "搜刮点";
    return "怪物";
  }
  function bestIcon(title, hints) {
    const compact = String(title || "").replace(/[^A-Za-z0-9]/g, "");
    const candidates = [...(hints || []), title, compact, "Icon_" + compact, compact + "_Portrait", compact + "Portrait"];
    for (const key of candidates) {
      const hit = iconFor(key);
      if (hit) return hit;
    }
    const needle = compact.toLowerCase();
    if (needle.length >= 6) {
      const found = Object.keys(icons).find((key) => key === "icon_" + needle || key.endsWith("_" + needle) || key === needle + "_portrait");
      if (found) return icons[found];
    }
    return null;
  }
  const tableCategory = {
    "DropTables/Collections": "掉落集合",
    "DropTables/Tables": "掉落表",
    DropTables: "掉落表",
  };
  for (const source of sources) {
    source.english = source.title;
    const shownKey = textIds.map[String(source.shownId || "")];
    source.title = (shownKey && byKey.get(shownKey)) || gameName(source.asset) || localizedTitle(source.asset, "") || source.title;
  }
  for (const table of dropTables) {
    table.english = table.title;
    table.category = tableCategory[table.category] || table.category;
    const loot = describeLoot(table.enumName);
    table.title = localizedTitle(table.asset, "") || gameName(table.enumName) || gameName(table.asset) || describeTable(table.enumName) || (loot && loot.title) || table.title;
    if (loot) {
      table.place = loot.place;
      table.look = loot.look;
      table.lootIcon = loot.icon;
    }
  }
  const owners = new Map();
  for (const source of sources) {
    if (!/[\u4e00-\u9fff]/.test(source.title)) continue;
    for (const ref of source.refs) {
      if (!owners.has(ref.id)) owners.set(ref.id, new Set());
      owners.get(ref.id).add(source.title);
    }
  }
  for (const table of dropTables) {
    if (/[\u4e00-\u9fff]/.test(table.title)) continue;
    const names = owners.get(table.id);
    if (names && names.size === 1) {
      const name = [...names][0];
      if (!dropTables.some((other) => other !== table && other.title === name)) table.title = name;
    }
  }
  const zhShort = (key) => {
    const text = byKey.get(key);
    if (!text || text.length > 24 || /[\r\n{}]/.test(text) || !/[\u4e00-\u9fff]/.test(text)) return "";
    return text.replace(/\s+/g, "");
  };
  const sourceByCompact = new Map();
  for (const source of sources) {
    if (!/[\u4e00-\u9fff]/.test(source.title)) continue;
    const compact = String(source.english || "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
    const asset = source.asset.replace(/ConfigurationAsset$/, "").toLowerCase();
    if (compact && !sourceByCompact.has(compact)) sourceByCompact.set(compact, source.title);
    if (asset && !sourceByCompact.has(asset)) sourceByCompact.set(asset, source.title);
  }
  const familyName = new Map();
  for (const table of dropTables) {
    if (!/[\u4e00-\u9fff]/.test(table.title)) continue;
    const base = table.enumName.replace(/_?Table$/, "");
    if (!base || /CraftingMat|Valuable|Shared|Chest|Lock|Collection/.test(base)) continue;
    if (!familyName.has(base.toLowerCase())) familyName.set(base.toLowerCase(), table.title);
  }
  const parentNames = new Map();
  for (const table of dropTables) {
    if (!/[\u4e00-\u9fff]/.test(table.title)) continue;
    for (const entry of table.entries) {
      const child = entry.nestedEnum || (entry.nested && tables.map[String(entry.nested)]) || "";
      if (!child) continue;
      if (!parentNames.has(child)) parentNames.set(child, new Set());
      parentNames.get(child).add(table.title);
    }
  }
  const banditWord = ((byKey.get("MapName_BanditOutpost") || "").match(/^[\u4e00-\u9fff]+/) || [])[0] || "";
  const ghostWord = ((byKey.get("Description_Ghost1") || "").match(/^[\u4e00-\u9fff]{2}/) || [])[0] || "";
  const stoneWord = ((byKey.get("MapName_StoneCircleEast") || "").match(/[\u4e00-\u9fff]+$/) || [])[0] || "";
  const warforgeWord = (byKey.get("Interact_WarforgeChest") || "").replace(/藏匿点$/, "");
  const shopWord = [...byKey.values()].find((value) => String(value).replace(/\s+/g, "") === "商店") || "";
  const salvageWord = zhShort("Salvageable");
  const gearWord = zhShort("Gear");
  const rarityWord = {
    Common: zhShort("RarityCommon"),
    Uncommon: zhShort("RarityUncommon"),
    Unommon: zhShort("RarityUncommon"),
    Rare: zhShort("RarityRare"),
    Supreme: zhShort("RaritySupreme"),
    Legendary: zhShort("RarityLegendary"),
  };
  const slotWord = {
    Armour: zhShort("SlotTypeArmor"),
    Armor: zhShort("SlotTypeArmor"),
    Feet: zhShort("SlotTypeBoots"),
    Hand: zhShort("SlotTypeGloves"),
    Head: zhShort("SlotTypeHelmet"),
    Shoulder: zhShort("SlotTypePauldrons"),
    Weapon: zhShort("SlotTypeWeapon"),
    Weapons: zhShort("SlotTypeWeapon"),
    Rings: zhShort("SlotTypeRing"),
    Ring: zhShort("SlotTypeRing"),
    Trinket: zhShort("SlotTypeTrinket") || zhShort("Trinket"),
    Consumable: zhShort("SlotTypeConsumable"),
    Bow: "",
  };
  const stemNames = [];
  for (const [key, text] of byKey) {
    const clean = zhShort(key);
    if (!clean) continue;
    const found = key.match(/^(?:UnitName_|Name_|Name_AdvancedNPC_|Name_AdvancedNpc_)(.+?)(?:Plural)?$/);
    if (found) stemNames.push({ stem: found[1].toLowerCase(), text: clean });
  }
  function matchStem(base) {
    const key = String(base || "").toLowerCase();
    if (key.length < 4) return "";
    const hits = stemNames.filter((row) => row.stem === key || (key.length >= 6 && Math.abs(row.stem.length - key.length) <= 8 && (row.stem.endsWith(key) || row.stem.startsWith(key))));
    const texts = [...new Set(hits.map((row) => row.text))];
    if (texts.length === 1) return texts[0];
    const generic = hits.filter((row) => !/^(elite|pirate|named|advanced)/.test(row.stem));
    const genericText = [...new Set(generic.map((row) => row.text))];
    return genericText.length === 1 ? genericText[0] : "";
  }
  const ownerNames = new Map();
  for (const source of sources) {
    if (!/[\u4e00-\u9fff]/.test(source.title)) continue;
    for (const ref of source.refs) {
      const enumName = tables.map[String(ref.id)];
      if (!enumName) continue;
      if (!ownerNames.has(enumName)) ownerNames.set(enumName, new Set());
      ownerNames.get(enumName).add(source.title);
    }
  }
  function matchOwner(enumName) {
    const names = ownerNames.get(enumName);
    if (!names || !names.size) return "";
    if (names.size === 1) return [...names][0];
    if (banditWord && [...names].every((name) => name.startsWith(banditWord))) return banditWord;
    return "";
  }
  const changelingWord = itemList.some((item) => String(item.title || "").includes("马卓古尔之选")) ? "马卓古尔之选" : "";
  function matchSource(base) {
    const key = String(base || "").toLowerCase();
    if (!key) return "";
    if (sourceByCompact.has(key)) return sourceByCompact.get(key);
    const hits = [];
    for (const [compact, title] of sourceByCompact) {
      if (key.length >= 6 && compact.length >= 6 && Math.abs(compact.length - key.length) <= 8 && (compact.endsWith(key) || compact.startsWith(key) || key.startsWith(compact))) hits.push({ compact, title });
    }
    if (!hits.length) return "";
    const texts = [...new Set(hits.map((hit) => hit.title))];
    if (texts.length === 1) return texts[0];
    const generic = hits.filter((hit) => !/^(elite|pirate|named|advanced)/.test(hit.compact));
    const genericText = [...new Set(generic.map((hit) => hit.text || hit.title))];
    return genericText.length === 1 ? genericText[0] : "";
  }
  function splitRole(enumName) {
    const roles = [
      [/CraftingMatTable$/, "材料"],
      [/ValuableTable$/, "贵重"],
      [/SharedLowTierTable$/, "低阶"],
      [/SharedTable$/, "共享"],
      [/CraftingTable$/, "制作"],
    ];
    for (const [pattern, role] of roles) {
      if (pattern.test(enumName)) return { role, base: enumName.replace(pattern, "") };
    }
    return { role: "", base: enumName.replace(/_?Table$/, "") };
  }
  function translateToken(token) {
    return (
      zhShort("UnitName_" + token) ||
      zhShort("Name_" + token) ||
      ((zhShort(token).length <= 4 && zhShort(token)) || "") ||
      matchSource(token) ||
      (token === "Bandit" ? banditWord : "") ||
      (token === "Ghost" || token === "Ghosts" ? ghostWord : "") ||
      (token === "Gear" ? gearWord : "") ||
      (token === "Shopkeeper" || token === "Shop" ? shopWord : "") ||
      rarityWord[token] ||
      slotWord[token] ||
      ""
    );
  }
  function specialTitle(table) {
    const name = table.enumName;
    let match = name.match(/^GearSalvage(Common|Uncommon|Unommon|Rare|Supreme|Legendary)$/);
    if (match && rarityWord[match[1]] && salvageWord) return rarityWord[match[1]] + salvageWord;
    if (/Collection/.test(name)) {
      const digit = (name.match(/(\d+)$/) || [])[1];
      const suffix = digit ? " " + digit : "";
      if (/Changeling/.test(name) && changelingWord) return changelingWord + (slotWord.Weapon || "") + suffix;
      if (/NamedItem/.test(name) && gearWord) return gearWord + suffix;
      if (/RegularGear/.test(name) && gearWord) return gearWord + suffix;
      if (/Default/.test(name) && gearWord) return gearWord + "掉落" + suffix;
      if (/CraftingCollectionTier(\d+)/.test(name)) return "材料 " + name.match(/Tier(\d+)/)[1];
      if (/Recipe/.test(name)) return "配方" + suffix;
      if (/FixedItem/.test(name) && gearWord) return gearWord;
      if (/Accessory/.test(name) && gearWord) return gearWord + suffix;
      if (/Artifact/.test(name) && slotWord.Armor) return slotWord.Armor + suffix;
      const slot = Object.entries(slotWord).find(([token]) => token.length > 3 && name.includes(token));
      if (slot && slot[1]) return slot[1] + suffix;
    }
    if (name === "ShopkeeperTable") return shopWord;
    match = name.match(/^(.*?)Shopkeeper(?:Tier(\d+))?Table$/);
    if (match) {
      const shopPeople = {
        Elemental: zhShort("Name_AdvancedNpc_ElementalShop"),
        Vulkaryn: zhShort("Name_VulkarynItemVendor"),
        Diona: zhShort("Name_Diona"),
        Goldbelly: zhShort("Name_Goldbelly"),
        Jolo: zhShort("Name_JoloNpc"),
        Human: zhShort("Name_Diona"),
        Storm: ((zhShort("Herb1") || "").match(/^[\u4e00-\u9fff]{2}/) || [])[0] || "",
      };
      const who = shopPeople[match[1]] || matchSource(match[1] + "Shopkeeper") || matchSource(match[1]);
      if (who) return who + (who.endsWith(shopWord) ? "" : shopWord) + (match[2] || "");
    }
    match = name.match(/^AdvancedNPC_Jolo(.*?)Table$/);
    if (match) {
      const jolo = zhShort("Name_JoloNpc");
      const tail = match[1];
      const forest = zhShort("UnitName_ForestGolem");
      const elementalWord = forest.endsWith("元素灵") ? "元素灵" : "";
      const sub = tail === "Werewolf" ? zhShort("UnitName_Werewolf") : tail === "Scrat" ? ((byKey.get("MapName_ScratOutpost") || "").replace(/\s+/g, "").replace(/哨所$/, "")) : tail === "Elemental" ? elementalWord : "";
      if (jolo) return jolo + (sub || "");
    }
    if (name === "HerbSickleTable") return zhShort("HerbSickle");
    match = name.match(/^(Herb|Iron|Crystal|Silver|Potion|Mushroom|LightBulb)(\d+)?(b)?(Volcanite)?Table$/);
    if (match) {
      const item = table.entries.find((entry) => entry.itemName && /[\u4e00-\u9fff]/.test(entry.itemName));
      if (item) return item.itemName;
    }
    if (/Humanoid.*Potion/.test(name)) {
      const item = table.entries.find((entry) => entry.itemName && /[\u4e00-\u9fff]/.test(entry.itemName));
      if (item) return item.itemName;
    }
    match = name.match(/^GlobalTier(\d+)Table$/);
    if (match) {
      const item = table.entries.find((entry) => entry.itemName && /[\u4e00-\u9fff]/.test(entry.itemName));
      if (item) return item.itemName + " " + match[1];
    }
    match = name.match(/^Ai(Common|Uncommon|Rare|Epic)?Table$/);
    if (match && changelingWord) return changelingWord + (match[1] && rarityWord[match[1]] ? rarityWord[match[1]] : "");
    if (name === "BahraCache") return zhShort("BahrasChest") || matchSource("Bahra");
    if (name === "WeaponRackTable") return slotWord.Weapon;
    if (name === "WarforgeTable" && warforgeWord) return warforgeWord;
    if (/StoneCircle/.test(name) && stoneWord) return stoneWord;
    if (name === "NecronusSpecialItemsTable") return matchSource("Necronus") || zhShort("UnitName_Necronus");
    if (/^WreckTitan/.test(name)) return zhShort("WreckTitan");
    if (name === "BearSharedLowTierTable") {
      const bear = zhShort("UnitName_Stonebear") || "";
      if (bear.endsWith("熊")) return "熊低阶";
    }
    return "";
  }
  function refreshLinks() {
    familyName.clear();
    parentNames.clear();
    for (const table of dropTables) {
      if (!/[\u4e00-\u9fff]/.test(table.title)) continue;
      const base = table.enumName.replace(/_?Table$/, "");
      if (base && !/CraftingMat|Valuable|Shared|Chest|Lock|Collection/.test(base) && !familyName.has(base.toLowerCase())) {
        familyName.set(base.toLowerCase(), table.title);
      }
      for (const entry of table.entries) {
        const child = entry.nestedEnum || (entry.nested && tables.map[String(entry.nested)]) || "";
        if (!child) continue;
        if (!parentNames.has(child)) parentNames.set(child, new Set());
        parentNames.get(child).add(table.title);
      }
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    refreshLinks();
    for (const table of dropTables) {
      if (/[\u4e00-\u9fff]/.test(table.title)) continue;
      const special = specialTitle(table);
      if (special && /[\u4e00-\u9fff]/.test(special)) {
        table.title = special;
        continue;
      }
      const { role, base } = splitRole(table.enumName);
      const parents = parentNames.get(table.enumName);
      const parent = parents && parents.size === 1 ? [...parents][0] : "";
      let who = familyName.get(base.toLowerCase()) || matchOwner(table.enumName) || matchSource(base) || matchStem(base) || parent;
      if (!who) {
        const tokens = base.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" ").filter(Boolean);
        const words = tokens.map(translateToken);
        if (tokens.length && words.every(Boolean)) who = words.join("");
      }
      if (who) table.title = role ? who + role : who;
    }
  }
  for (const source of sources) {
    if (/[\u4e00-\u9fff]/.test(source.title)) continue;
    const base = source.asset.replace(/ConfigurationAsset$/, "");
    source.title = zhShort(base) || zhShort("Name_" + base) || zhShort("UnitName_" + base) || (base.startsWith("WreckTitan") ? zhShort("WreckTitan") : "") || matchSource(base) || source.title;
  }
  const stillEnglish = dropTables.filter((table) => !/[\u4e00-\u9fff]/.test(table.title)).map((table) => table.enumName);
  console.log("english tables left", stillEnglish.length, stillEnglish.slice(0, 40).join(", "));
  const monsterTitles = new Set(
    sources.filter((source) => sourceCategory(source.title + " " + source.english + " " + source.asset) === "怪物").map((source) => source.title)
  );
  let strippedMat = 0;
  for (const table of dropTables) {
    if (!table.title.endsWith("材料")) continue;
    const base = table.title.slice(0, -2);
    if (!monsterTitles.has(base)) continue;
    table.title = base;
    strippedMat++;
  }
  console.log("monster material suffix removed", strippedMat);
  const titleByEnum = {};
  for (const table of dropTables) titleByEnum[table.enumName] = table.title;
  for (const table of dropTables) {
    for (const entry of table.entries) {
      if (!entry.nested) continue;
      const enumName = tables.map[String(entry.nested)];
      if (enumName && titleByEnum[enumName]) entry.nestedName = titleByEnum[enumName];
    }
  }
  for (const source of sources) {
    source.category = sourceCategory(source.title + " " + source.english + " " + source.asset);
    source.icon = iconFor(source.portrait) || iconFor(String(source.portrait || "").replace(/_Portrait$/i, "")) || bestIcon(source.portrait, []) || iconFor(source.iconFile) || iconFor(iconFiles[source.asset]) || null;
    if (/BahrasChest|BahraCache/.test(source.asset || "")) source.icon = "icons/ChestBahra.png";
  }
  console.log(
    "monster portraits",
    sources.filter((s) => s.category === "怪物" && s.icon).length,
    "named",
    sources.filter((s) => s.portrait).length
  );
  const creatureShots = fillCreaturePortraits(sources);
  console.log("creature fronts", creatureShots);
  for (const source of sources) {
    source.refs = source.refs.map((ref) => ({
      ...ref,
      table: tables.map[String(ref.id)] || "#" + ref.id,
      title: titleByEnum[tables.map[String(ref.id)]] || pretty(tables.map[String(ref.id)] || String(ref.id)),
    }));
  }
  for (const table of dropTables) {
    const label = table.english || table.title;
    if (!/chest|lockbox|lock box|dirt mound|crate|bahra cache/i.test(label)) continue;
    sources.push({
      asset: table.asset,
      title: table.title,
      english: label,
      category: "搜刮点",
      place: table.place || "",
      look: table.look || "",
      refs: [{ field: "掉落表", id: table.id, table: table.enumName, title: table.title }],
      hints: [],
      icon: table.lootIcon || icons.chestsmall || null,
    });
  }

  console.log("reading maps");
  const regionNameKeys = {
    "Area 1 Fume Pits": "MapName_FumePits",
    "Area 5 Shanty Town": "MapName_ShantyTown",
    "Area8 - PinecrestKeep": "MapName_PinecrestKeep",
    "Area8 - Pinecrest": "MapName_PinecrestVillage",
    "Area8 - Pinecrest_1": "MapName_PinecrestVillage",
    "Area14 - DarkmoonThicket": "MapName_DarkmoonThicket",
    "Area14 - DarkmoonThicket (boss)": "MapName_DarkmoonThicket",
    "Area12 - ElvenRuins": "MapName_ElvenRuins",
    "Area12 - ElvenRuins_1": "MapName_ElvenRuins",
    "Area20 - GaleCrest": "MapName_GalecrestPlateau",
    "Area9 - Crypt": "MapName_Crypt",
    "Area6 - GY_Circle": "MapName_GraveYard",
    "Area3 - ScratAirship": "MapName_Airship",
    "Area4 - MageTower": "MapName_AncientTower",
    "Area1-Cave": "MapName_ElementalCave",
    "Area 2 Warforge": "MapName_RatbosWarforge",
  };
  function regionTitle(raw) {
    const zh = byKey.get(regionNameKeys[raw] || "");
    const chinese = zh && /[\u4e00-\u9fff]/.test(zh) ? zh.replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])/g, "$1$2") : "";
    const numbered = raw.match(/^Area (\d+)\b\s*(.*)$/);
    if (numbered) {
      const place = chinese || numbered[2].trim();
      return place ? numbered[1] + " · " + place : numbered[1];
    }
    if (chinese) return chinese;
    const poi = raw.match(/^Area\d+\s*-\s*(.+)$/) || raw.match(/^Area\d+(.*)$/);
    const place = poi ? poi[1].replace(/^[\s-]+/, "") : raw;
    return place.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/\s+/g, " ").trim();
  }
  const gameMaps = extractGameMaps(byKey).map((map) => {
    const pins = [];
    for (const pin of map.pins) {
      const tables = pin.table === "GreaterVoidPortalChestCraftingMatTable"
        ? ["GreaterVoidPortalChestCraftingMatTable", "GreaterVoidPortalChestValuableTable"]
        : [pin.table];
      const titles = tables.map((enumName) => {
        const source = sources.find((s) => s.refs.some((r) => r.table === enumName));
        const table = dropTables.find((t) => t.enumName === enumName);
        const text = (source && source.title) || (table && table.title) || "";
        return /[\u4e00-\u9fff]/.test(text) ? text : "";
      }).filter(Boolean);
      if (!titles.length) continue;
      let title = titles[0];
      if (titles.length > 1) {
        const head = titles[0].split("·")[0];
        if (head && titles.every((text) => text.startsWith(head))) title = head;
      }
      pins.push({ title, table: tables[0], tables, left: pin.left, top: pin.top });
    }
    const entrances = (map.entrances || []).map((entrance) => {
      const title = ((byKey.get(entrance.titleKey) || "").replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])/g, "$1$2"));
      const detail = ((byKey.get(entrance.detailKey) || "").replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])/g, "$1$2"));
      if (!/[\u4e00-\u9fff]/.test(title)) return null;
      return {
        title,
        detail: detail && detail !== title ? detail : "",
        kind: entrance.kind,
        left: entrance.left,
        top: entrance.top,
      };
    }).filter(Boolean);
    const regions = (map.regions || []).map((region) => ({
      title: regionTitle(region.title),
      english: region.title,
      left: region.left,
      top: region.top,
      paths: region.paths,
    }));
    function tighten(text) {
      return String(text || "").replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])/g, "$1$2");
    }
    function actorAsset(token) {
      if (!token || token === "Boss" || token === "MiniBoss") return "";
      const needle = token.toLowerCase();
      const hits = sources.filter((source) => (source.category === "怪物" || source.category === "工坊与商人") && (source.asset || "").toLowerCase().includes(needle));
      return hits.length === 1 ? hits[0].asset : "";
    }
    const actorAliases = {
      Vulkaryn: ["VulkarynItemVendor", "VulkarynInMatch"],
      Silverhook: ["SilverhookSam", "SilverhookSamInMatch"],
      Priestess: ["PriestessNpc", "PriestessInMatch"],
      Lanathar: ["LanatharLightbringer", "LanatharInMatch"],
      Gondrak: ["GondrakBlacksmith", "GondrakInMatch"],
      Milloween: ["MilloweenInMatch"],
      Vexxie: ["VexxieAlchemyCrafter", "VexxieInMatch"],
      KingFisher: ["KingFisher"],
      Widow: ["Widow"],
      WerewolfMage: ["WerewolfMage"],
      WerewolfMageHowly: ["WerewolfMageHowly"],
      EliteWolf: ["EliteWolf"],
      BlackWerewolf: ["BlackWerewolf"],
      SpiderMatriarch: ["SpiderMatriarch"],
      Necronus: ["Necronus"],
      OldBear: ["OldBear"],
      GhostWerewolf: ["GhostWerewolf"],
      GhostEliteWolf: ["GhostEliteWolf"],
      GhostCrone: ["AdvancedNPC_GhostCrone", "GhostCrone"],
      ScratMechSuitMiniBoss: ["ScratMechSuitMiniBoss"],
    };
    function namedActor(token) {
      const tries = [token].concat(actorAliases[token] || []);
      for (const key of tries) {
        const text = tighten(gameName(key));
        if (text) return text;
      }
      return "";
    }
    function placeActors(rows) {
      const placed = (rows || []).map((actor) => {
        const asset = actorAsset(actor.token);
        const source = asset ? sources.find((row) => row.asset === asset) : null;
        const sourceTitle = source && /[\u4e00-\u9fff]/.test(source.title) ? tighten(source.title) : "";
        const title = namedActor(actor.token) || sourceTitle || actor.fallback || actor.token;
        if (!title) return null;
        return {
          title,
          token: actor.token,
          fallback: actor.fallback || "",
          asset,
          left: actor.left,
          top: actor.top,
          path: (actor.path || []).map((point) => ({ left: point.left, top: point.top })),
        };
      }).filter(Boolean);
      const variants = new Map();
      for (const actor of placed) {
        if (!variants.has(actor.token)) variants.set(actor.token, new Set());
        variants.get(actor.token).add(actor.fallback);
      }
      for (const actor of placed) {
        if (variants.get(actor.token).size > 1 && actor.fallback && actor.fallback !== actor.title) {
          actor.title = actor.title + " · " + actor.fallback;
        }
        delete actor.fallback;
      }
      return placed;
    }
    const npcs = placeActors(map.npcs);
    const bosses = placeActors(map.bosses);
    console.log("regions", map.id, regions.map((region) => region.title).join(" | "));
    console.log("npcs", map.id, npcs.map((actor) => actor.title).join(" | "));
    console.log("bosses", map.id, bosses.map((actor) => actor.title + (actor.path.length >= 2 ? " path" + actor.path.length : "")).join(" | "));
    return {
      id: map.id,
      title: /[\u4e00-\u9fff]/.test(map.title) ? map.title : map.id,
      image: map.image,
      pins,
      regions,
      entrances,
      npcs,
      bosses,
    };
  });

  const usedIcons = new Set();
  for (const table of dropTables) for (const e of table.entries) if (e.itemIcon) usedIcons.add(e.itemIcon);
  for (const source of sources) if (source.icon) usedIcons.add(source.icon);
  for (const item of itemList) if (item.icon) usedIcons.add(item.icon);

  const db = {
    generatedAt: new Date().toISOString(),
    dropTables: dropTables.sort((a, b) => a.title.localeCompare(b.title, "zh-CN")),
    sources: sources.sort((a, b) => a.title.localeCompare(b.title, "zh-CN")),
    items: itemList.filter((it) => it.icon || dropTables.some((t) => t.entries.some((e) => e.item === it.id))).sort((a, b) => a.title.localeCompare(b.title, "zh-CN")),
    maps: gameMaps,
    rarity: RARITY,
    dropMode: DROP_MODE,
    outcome: OUTCOME,
  };
  fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "data", "db.json"), JSON.stringify(db));
  writeHtml(db);
  console.log("html ready, referenced icons", usedIcons.size, "db bytes", fs.statSync(path.join(ROOT, "data", "db.json")).size);
}

function writeHtml(db) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>龙窟破坏者掉落表</title>
<style>
  :root { color-scheme: dark; --bg:#12141a; --panel:#1c2030; --line:#31384d; --text:#e7ebf5; --muted:#9aa3b8; --accent:#e2b15a; --good:#7dcea0; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.45 "Segoe UI", "Microsoft YaHei", sans-serif; background:var(--bg); color:var(--text); }
  header { padding:18px 22px 10px; border-bottom:1px solid var(--line); display:flex; gap:16px; align-items:flex-end; flex-wrap:wrap; }
  h1 { margin:0; font-size:22px; }
  header p { margin:4px 0 0; color:var(--muted); }
  header .meta { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  a.gh { display:inline-flex; align-items:center; gap:5px; color:inherit; text-decoration:none; border:1px solid var(--line); border-radius:999px; padding:1px 8px 1px 6px; }
  a.gh:hover { color:var(--accent); border-color:var(--accent); }
  a.gh svg { width:14px; height:14px; display:block; }
  input, select { background:#0e1118; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:8px 10px; }
  input { min-width:260px; }
  .search { position:relative; }
  .search-history { position:absolute; z-index:30; left:0; right:0; top:calc(100% + 4px); background:#1c2030; border:1px solid var(--line); border-radius:8px; padding:4px; box-shadow:0 8px 24px rgba(0,0,0,.35); }
  .search-history[hidden] { display:none; }
  .search-history p { margin:4px 8px; color:var(--muted); font-size:12px; }
  .search-history button { display:block; width:100%; text-align:left; background:transparent; color:inherit; border:0; border-radius:6px; padding:7px 8px; cursor:pointer; font:inherit; }
  .search-history button:hover { background:#262c3e; }
  main { display:grid; grid-template-columns: 340px 1fr; min-height: calc(100vh - 78px); }
  aside { border-right:1px solid var(--line); overflow:auto; max-height: calc(100vh - 78px); }
  .list-count { margin:0; padding:10px 12px 18px; color:var(--muted); font-size:12px; }
  .row { display:flex; gap:10px; align-items:center; width:100%; text-align:left; background:transparent; color:inherit; border:0; border-bottom:1px solid #262b3c; padding:8px 12px; cursor:pointer; }
  .row:hover, .row.active { background:#262c3e; }
  .row img, img.icon, .hero img { width:42px; height:42px; object-fit:contain; background:#0e1118; border-radius:6px; vertical-align:middle; image-rendering:auto; flex:0 0 auto; }
  .hero img { width:84px; height:84px; }
  .hero img { width:84px; height:84px; }
  .row small, .muted { color:var(--muted); }
  section { padding:18px 22px 40px; overflow:auto; max-height: calc(100vh - 78px); }
  .hero { display:flex; gap:14px; align-items:center; margin-bottom:14px; }
  table { width:100%; border-collapse:collapse; }
  th, td { border-bottom:1px solid var(--line); padding:8px 6px; vertical-align:middle; text-align:left; }
  th { color:var(--muted); font-weight:600; }
  .bar { height:8px; background:#2a3144; border-radius:99px; overflow:hidden; min-width:70px; }
  .bar span { display:block; height:100%; background:var(--accent); }
  .tag { display:inline-block; margin:0 4px 4px 0; padding:2px 6px; border-radius:99px; background:#2a3144; color:var(--muted); font-size:12px; }
  .tabs button { background:transparent; color:var(--muted); border:0; border-bottom:2px solid transparent; padding:8px 12px; cursor:pointer; }
  .tabs button.on { color:var(--accent); border-color:var(--accent); }
  a { color:#8eb6ff; cursor:pointer; }
  .mapzoom { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-top:10px; }
  .zoom-btn { background:#1c2030; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:6px 14px; cursor:pointer; font:inherit; font-weight:700; }
  .zoom-btn:hover { border-color:var(--accent); color:var(--accent); }
  .zoom-btn:disabled { opacity:.4; cursor:default; color:var(--muted); border-color:var(--line); }
  .zoom-readout { color:var(--muted); min-width:52px; font-variant-numeric:tabular-nums; }
  .mapwrap { position:relative; max-width:960px; margin-top:8px; overflow:auto; border-radius:8px; background:#0e1118; touch-action:none; }
  .mapwrap.dragging, .mapwrap.dragging .pin { cursor:grabbing; }
  .mapsizer { width:0; height:0; pointer-events:none; }
  .mapstage { position:relative; width:100%; transform-origin:0 0; cursor:grab; }
  .mapstage img { width:100%; height:100%; display:block; background:#0e1118; }
  .mapstage svg { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }
  .region-label { position:absolute; z-index:1; transform:translate(-50%,-50%); font-size:13px; font-weight:700; color:#fff; white-space:nowrap; pointer-events:none; text-shadow:0 0 4px #000, 0 1px 2px #000; }
  .pin { position:absolute; z-index:2; width:12px; height:12px; margin:0; padding:0; border:1px solid #111; border-radius:50%; transform:translate(-50%,-50%); cursor:pointer; }
  .pin:hover { outline:2px solid #fff; z-index:2; }
  .gate { position:absolute; z-index:4; width:12px; height:12px; margin:0; padding:0; border:2px solid #111; background:#f7dc6f; transform:translate(-50%,-50%) rotate(45deg); }
  .gate.extract { background:#e07a7a; border-radius:2px; transform:translate(-50%,-50%); }
  .gate-label, .actor-label { position:absolute; z-index:4; transform:translate(8px,-50%); font-size:12px; font-weight:700; white-space:nowrap; pointer-events:none; text-shadow:0 0 4px #000, 0 1px 2px #000; }
  .actor { position:absolute; z-index:5; margin:0; padding:0; border:2px solid #111; transform:translate(-50%,-50%); }
  .actor.npc { width:11px; height:11px; border-radius:50%; background:#5dade2; }
  .actor.boss { width:13px; height:13px; background:#e74c3c; border-color:#fff; transform:translate(-50%,-50%) rotate(45deg); }
  button.actor { cursor:pointer; }
  .actor:hover { outline:2px solid #fff; z-index:6; }
  .legend-block { margin-top:10px; }
  .legend-tools { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-bottom:4px; }
  .legend-tools b { min-width:4.5em; }
  .bulk { cursor:pointer; border:1px solid var(--line); background:#1c2030; color:var(--text); }
  .legend { display:flex; flex-wrap:wrap; gap:6px; }
  .region-filter, .pin-filter, .gate-filter, .npc-filter, .boss-filter { cursor:pointer; border:2px solid #3a4258; background:transparent; color:#6d778c; opacity:.48; font-weight:500; box-shadow:none; }
  .region-filter.on, .pin-filter.on, .gate-filter.on, .npc-filter.on, .boss-filter.on { border:2px solid #ffe7b0; background:#46506c; color:#fff; opacity:1; font-weight:700; box-shadow:0 0 0 1px rgba(255,231,176,.55), 0 0 12px rgba(226,177,90,.55); }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:4px; }
  @media (max-width: 860px) { main { grid-template-columns: 1fr; } aside, section { max-height:none; } }
</style>
</head>
<body>
<header>
  <div>
    <h1>龙窟破坏者掉落表</h1>
    <p>从本地客户端配置和贴图解出。物品、怪物、地点和环境名称使用游戏内简体中文。掉落表 ${db.dropTables.length} 张，关联来源 ${db.sources.length} 个，地图 ${(db.maps || []).length} 张。</p>
    <p class="meta">作者 elmagnifico · 版本 v0.1 · 对应游戏版本 2.0.2137.110314（Steam build 25803617） <a class="gh" href="https://github.com/elmagnificogi/VaultbreakersWiki" target="_blank" rel="noopener noreferrer" title="在 GitHub 查看源码"><svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"></path></svg>开源</a></p>
  </div>
  <div class="search">
    <input id="q" placeholder="搜索怪物、箱子、物品" autocomplete="off" />
    <div id="history" class="search-history" hidden></div>
  </div>
  <select id="cat"></select>
  <div class="tabs">
    <button id="tab-sources" class="on">怪物与搜刮点</button>
    <button id="tab-items">物品</button>
    <button id="tab-maps">地图</button>
  </div>
</header>
<main>
  <aside id="list"></aside>
  <section id="detail"></section>
</main>
<script id="db" type="application/json">${JSON.stringify(db).replace(/</g, "\\u003c")}</script>
<script>
const db = JSON.parse(document.getElementById("db").textContent);
const listEl = document.getElementById("list");
const detailEl = document.getElementById("detail");
const qEl = document.getElementById("q");
const catEl = document.getElementById("cat");
const historyEl = document.getElementById("history");
let mode = "tables";
let current = null;
let historyLock = false;
let appliedUrl = "";
let mapObserver = null;
const lastByMode = { tables: null, sources: null, items: null, maps: null };
function icon(src, alt) {
  if (!src) return '<img class="icon" alt="" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">';
  return '<img class="icon" alt="'+(alt||"")+'" src="'+src+'">';
}
const tableById = {};
const tableByEnum = {};
for (const t of db.dropTables) {
  if (t.id != null) tableById[t.id] = t;
  tableByEnum[t.enumName] = t;
}
const dropWords = {};
function collectDropWords(table, depth, seen) {
  if (!table || depth > 2 || seen.has(table.enumName)) return "";
  seen.add(table.enumName);
  return table.entries.map(entry => {
    if (entry.outcome === 1) {
      const child = tableById[entry.nested] || tableByEnum[entry.nestedEnum];
      return (entry.nestedName || "") + " " + collectDropWords(child, depth + 1, seen);
    }
    return (entry.itemName || "") + " " + (entry.itemEnglish || "");
  }).join(" ");
}
for (const t of db.dropTables) dropWords[t.enumName] = collectDropWords(t, 0, new Set());
const directOrigin = {};
for (const source of db.sources) {
  for (const ref of source.refs) {
    if (!directOrigin[ref.table]) directOrigin[ref.table] = new Set();
    directOrigin[ref.table].add(source.category);
  }
}
const parentEnums = {};
for (const table of db.dropTables) {
  for (const entry of table.entries) {
    if (!entry.nestedEnum) continue;
    if (!parentEnums[entry.nestedEnum]) parentEnums[entry.nestedEnum] = [];
    parentEnums[entry.nestedEnum].push(table.enumName);
  }
}
const originCache = {};
function originKinds(enumName) {
  if (!enumName) return new Set();
  if (originCache[enumName]) return originCache[enumName];
  const kinds = new Set();
  originCache[enumName] = kinds;
  const local = directOrigin[enumName];
  if (local) for (const kind of local) kinds.add(kind);
  for (const parent of parentEnums[enumName] || []) for (const kind of originKinds(parent)) kinds.add(kind);
  return kinds;
}
function originTag(enumName) {
  const kinds = originKinds(enumName);
  const mob = kinds.has("怪物");
  const loot = kinds.has("搜刮点");
  if (mob && loot) return "怪物/搜刮";
  if (mob) return "怪物";
  if (loot) return "搜刮";
  if (kinds.has("工坊与商人")) return "商人";
  return "";
}
function sourceTag(category) {
  if (category === "怪物") return "怪物";
  if (category === "搜刮点") return "搜刮";
  if (category === "工坊与商人") return "商人";
  return "";
}
function withTag(title, tag) {
  const text = String(title || "");
  if (!tag || text.endsWith(" · " + tag)) return text;
  return text + " · " + tag;
}
function entryPortion(table, entry) {
  if (entry.dropMode === 1) return (entry.percent || 0) / 100;
  const weightSum = table.totalWeight || table.entries.filter(e => e.dropMode !== 1).reduce((sum, e) => sum + e.weight, 0);
  if (!weightSum) return 0;
  return entry.weight / weightSum;
}
function formatPct(portion) {
  const n = portion * 100;
  if (n >= 10) return (Math.round(n * 10) / 10).toString().replace(/\\.0$/, "") + "%";
  if (n >= 1) return n.toFixed(1) + "%";
  return n.toFixed(2) + "%";
}
function chance(table, entry) {
  return formatPct(entryPortion(table, entry));
}
function flattenDrops(table, mul, depth, seen) {
  if (!table || depth > 3 || seen.has(table.enumName)) return [];
  const nextSeen = new Set(seen);
  nextSeen.add(table.enumName);
  const rows = [];
  for (const entry of table.entries) {
    const portion = mul * entryPortion(table, entry);
    if (entry.outcome === 1) {
      const child = tableById[entry.nested] || tableByEnum[entry.nestedEnum];
      if (child && child.entries.length) rows.push(...flattenDrops(child, portion, depth + 1, nextSeen));
      else rows.push({ kind: "table", title: (child && child.title) || entry.nestedName || "子表", enumName: (child && child.enumName) || entry.nestedEnum || "", chance: portion, amount: amount(entry) });
    } else {
      rows.push({ kind: "item", id: entry.item, title: entry.itemName || "物品", icon: entry.itemIcon, chance: portion, amount: amount(entry), rarity: rarityText(entry), flags: entry.flagText || [], recipe: entry.outcome === 2, recipeId: entry.recipe });
    }
  }
  return rows;
}
function amount(entry) {
  if (entry.min === entry.max) return String(entry.min);
  return entry.min + "–" + entry.max;
}
function rarityText(entry) {
  if (!entry.rarities || !entry.rarities.length) return "";
  const sum = entry.rarities.reduce((a,b)=>a+b,0) || 1;
  return entry.rarities.map((v,i) => v ? (db.rarity[i]||("稀有度"+i)) + " " + (v/sum*100).toFixed(0) + "%" : "").filter(Boolean).join(" · ");
}
function categoriesFor(kind) {
  const values = kind === "tables" ? db.dropTables.map(t => t.category) : kind === "sources" ? db.sources.map(s => s.category) : [];
  return ["全部", ...[...new Set(values)].filter(Boolean).sort((a, b) => String(a).localeCompare(String(b), "zh"))];
}
function syncCats(preferred) {
  const cats = categoriesFor(mode);
  if (cats.length < 2) { catEl.hidden = true; return; }
  catEl.hidden = false;
  const want = preferred == null ? catEl.value : preferred;
  catEl.innerHTML = cats.map(c => '<option>'+c+'</option>').join("");
  catEl.value = cats.includes(want) ? want : "全部";
}
function clashLabel(source) {
  const title = shown(source.title);
  const group = db.sources.filter(other => other.category === source.category && shown(other.title) === title);
  if (group.length < 2) return "";
  const mine = source.english || String(source.asset || "").replace(/ConfigurationAsset$/, "");
  return mine && mine !== title ? mine : "";
}
function sourceLabel(source) {
  const base = withTag(shown(source.title), sourceTag(source.category));
  const extra = clashLabel(source);
  return extra ? base + " · " + extra : base;
}
function rowTitle(row) {
  if (!row) return "";
  if (mode === "tables") return named(row.title, row.enumName);
  if (mode === "sources") return sourceLabel(row);
  return row.title || "";
}
function filtered() {
  const q = qEl.value.trim().toLowerCase();
  const cat = catEl.value;
  let rows;
  if (mode === "tables") rows = db.dropTables.filter(t => {
    if (!t.entries.length && !q) return false;
    return (cat==="全部"||t.category===cat) && (!q || (named(t.title, t.enumName)+" "+t.title+" "+(t.english||"")+" "+t.enumName+" "+(dropWords[t.enumName]||"")).toLowerCase().includes(q));
  });
  else if (mode === "sources") rows = db.sources.filter(s => (cat==="全部"||s.category===cat) && (!q || (sourceLabel(s)+" "+s.title+" "+(s.english||"")+" "+(s.place||"")+" "+(s.look||"")+" "+s.asset+" "+s.refs.map(r=>named(r.title, r.table)+" "+(dropWords[r.table]||"")).join(" ")).toLowerCase().includes(q)));
  else if (mode === "maps") rows = (db.maps || []).filter(m => !q || (m.title + " " + m.pins.map(p => p.title).join(" ") + " " + (m.regions||[]).map(r => r.title + " " + r.english).join(" ") + " " + (m.entrances||[]).map(e => e.title + " " + e.detail).join(" ") + " " + (m.npcs||[]).map(n => n.title).join(" ") + " " + (m.bosses||[]).map(b => b.title).join(" ")).toLowerCase().includes(q));
  else rows = db.items.filter(it => (!q || (it.title+" "+(it.english||"")+" "+it.name+" "+(it.places||[]).join(" ")).toLowerCase().includes(q)));
  return rows.sort((a, b) => rowTitle(a).localeCompare(rowTitle(b), "zh"));
}
function shown(text) {
  const value = String(text || "");
  const role = value.endsWith("贵重") ? "贵重" : value.endsWith("材料") ? "材料" : "";
  if (!role) return value;
  let base = value.slice(0, -role.length);
  if (base.endsWith("·")) base = base.slice(0, -1);
  if (!base) return value;
  const hit = db.sources.some(s => {
    if (s.title === base && (s.category === "怪物" || s.category === "搜刮点")) return true;
    return s.category === "搜刮点" && (s.title === base + "·" + role || s.title === base + role);
  });
  return hit ? base : value;
}
function named(title, enumName) {
  return withTag(shown(title), originTag(enumName));
}
function renderList() {
  const rows = filtered();
  const body = rows.map((row, i) => {
    const title = rowTitle(row);
    const sub = mode==="tables" ? (row.entries.length ? row.entries.length+" 项 · "+row.category : "没有条目") : mode==="sources" ? (row.place || row.refs.map(r=>shown(r.title)).join("、")) : mode==="maps" ? ((row.regions||[]).length+" 个区域 · "+(row.entrances||[]).length+" 个入口 · "+row.pins.length+" 个固定搜刮点 · "+((row.npcs||[]).length)+" 个 NPC · "+((row.bosses||[]).length)+" 个固定怪") : ((row.places||[]).join("、"));
    const img = mode==="items" ? row.icon : mode==="tables" ? portraitOf(row) : mode==="maps" ? row.image : row.icon;
    return '<button class="row" data-i="'+i+'">'+icon(img, title)+'<span><b>'+title+'</b><br><small>'+sub+'</small></span></button>';
  }).join("");
  listEl.innerHTML = (body || '<p class="muted" style="padding:12px">没有匹配结果</p>') + (rows.length ? '<p class="list-count">共 '+rows.length+' 条</p>' : "");
  listEl.querySelectorAll(".row").forEach(btn => btn.onclick = () => {
    listEl.querySelectorAll(".row").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    open(filtered()[Number(btn.dataset.i)]);
    pushView();
  });
}
function portraitOf(table) {
  if (!table) return "";
  const owner = db.sources.find(s => s.icon && s.refs && s.refs.some(r => r.table === table.enumName));
  return owner ? owner.icon : "";
}
function show(kind, row) {
  present(kind, row);
  pushView();
}
function sourceForTable(name) {
  const table = db.dropTables.find(t => t.enumName === name || t.title === name);
  const start = table ? table.enumName : name;
  if (!start) return null;
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const current = stack.pop();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    const owner = db.sources.find(s => s.refs.some(r => r.table === current));
    if (owner) return owner;
    for (const parent of parentEnums[current] || []) stack.push(parent);
  }
  return null;
}
function openTable(name) {
  const source = sourceForTable(name);
  if (source) show("sources", source);
}
function openItem(id) {
  const item = db.items.find(it => String(it.id) === String(id));
  if (item) show("items", item);
}
function openLoot(enumName) {
  openTable(enumName);
}
function openSource(key) {
  let raw = key;
  try { raw = decodeURIComponent(key); } catch (e) {}
  const source = rowByKey(raw);
  if (source) show("sources", source);
}
function bindJumps(root) {
  root.querySelectorAll("[data-jump]").forEach(a => a.onclick = (event) => { event.preventDefault(); openTable(a.dataset.jump); });
  root.querySelectorAll("[data-item]").forEach(a => a.onclick = (event) => { event.preventDefault(); openItem(a.dataset.item); });
  root.querySelectorAll("[data-loot]").forEach(a => a.onclick = (event) => { event.preventDefault(); openLoot(a.dataset.loot); });
  root.querySelectorAll("[data-source]").forEach(a => a.onclick = (event) => { event.preventDefault(); openSource(a.dataset.source); });
}
function open(row) {
  current = row;
  if (row) lastByMode[mode] = row;
  if (mode === "tables") {
    const weightRows = row.entries.map(e => {
      const what = e.outcome === 1
        ? '<a data-jump="'+(e.nestedEnum||e.nestedName)+'">'+named(e.nestedName||"子表", e.nestedEnum)+'</a>'
        : '<a data-item="'+e.item+'">'+icon(e.itemIcon, e.itemName)+' '+e.itemName+'</a>'+(e.outcome===2?' <span class="tag">配方 '+e.recipe+'</span>':'');
      const width = Math.max(2, Math.min(100, entryPortion(row, e) * 100));
      return '<tr><td>'+what+'</td><td>'+amount(e)+'</td><td>'+(db.dropMode[e.dropMode]||e.dropMode)+'</td><td>'+chance(row,e)+'<div class="bar"><span style="width:'+width+'%"></span></div></td><td>'+rarityText(e)+(e.flagText||[]).map(f=>'<span class="tag">'+f+'</span>').join("")+'</td></tr>';
    }).join("");
    const users = db.sources.filter(s => s.refs.some(r => r.table === row.enumName));
    const where = [row.place && ("地点："+row.place), row.look && row.look !== row.title && !String(row.title).includes(row.look) && ("样子："+row.look)].filter(Boolean).join(" · ");
    const dropList = row.entries.length
      ? '<table><thead><tr><th>掉落</th><th>数量</th><th>方式</th><th>几率</th><th>稀有度 / 标记</th></tr></thead><tbody>'+weightRows+'</tbody></table>'
      : '<p class="muted">这张表没有条目。</p>';
    detailEl.innerHTML = '<div class="hero">'+icon(portraitOf(row), named(row.title, row.enumName))+'<div><h2>'+named(row.title, row.enumName)+'</h2><div class="muted">'+row.category+' · 总权重 '+row.totalWeight+'</div>'+(where ? '<p>'+where+'</p>' : '')+'</div></div>'
      + dropList
      + '<h3>谁会掉这个</h3>' + (users.length ? users.map(s => '<a class="tag" data-source="'+encodeURIComponent(rowKey("sources", s))+'">'+sourceLabel(s).replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]))+'</a>').join("") : '<p class="muted">没有在单位或容器配置里找到直接引用。它可能是别的掉落表里的子表。</p>');
    bindJumps(detailEl);
  } else if (mode === "sources") {
    const blocks = row.refs.map(ref => {
      const table = tableByEnum[ref.table];
      const drops = table ? flattenDrops(table, 1, 0, new Set()).sort((a, b) => b.chance - a.chance) : [];
      const body = drops.map(drop => {
        const what = drop.kind === "table"
          ? (sourceForTable(drop.enumName) ? '<a data-loot="'+drop.enumName+'">'+named(drop.title, drop.enumName)+'</a>' : named(drop.title, drop.enumName))
          : '<a data-item="'+drop.id+'">'+icon(drop.icon, drop.title)+' '+drop.title+'</a>'+(drop.recipe ? ' <span class="tag">配方 '+drop.recipeId+'</span>' : '');
        const extra = (drop.rarity ? drop.rarity + " " : "") + (drop.flags || []).map(flag => '<span class="tag">'+flag+'</span>').join("");
        return '<tr><td>'+what+'</td><td>'+(drop.amount||"")+'</td><td>'+formatPct(drop.chance)+'<div class="bar"><span style="width:'+Math.max(2, Math.min(100, drop.chance * 100))+'%"></span></div></td><td>'+extra+'</td></tr>';
      }).join("");
      return '<h3>'+named((table && table.title) || ref.title, (table && table.enumName) || ref.table)+'</h3>'
        + '<table><thead><tr><th>掉落</th><th>数量</th><th>几率</th><th>稀有度 / 标记</th></tr></thead><tbody>'+body+'</tbody></table>';
    }).join("");
    const where = [row.place && ("地点："+row.place), row.look && row.look !== row.title && !String(row.title).includes(row.look) && ("样子："+row.look)].filter(Boolean).join(" · ");
    detailEl.innerHTML = '<div class="hero">'+icon(row.icon, sourceLabel(row))+'<div><h2>'+sourceLabel(row).replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]))+'</h2><div class="muted">'+row.category+'</div>'+(where ? '<p>'+where+'</p>' : '')+'</div></div>' + blocks;
    bindJumps(detailEl);
  } else if (mode === "items") {
    const from = [];
    for (const source of db.sources) {
      let best = null;
      for (const ref of source.refs) {
        const table = tableByEnum[ref.table];
        if (!table) continue;
        for (const drop of flattenDrops(table, 1, 0, new Set())) {
          if (drop.kind === "item" && String(drop.id) === String(row.id) && (!best || drop.chance > best.chance)) best = drop;
        }
      }
      if (best) from.push({ source, drop: best });
    }
    from.sort((a, b) => b.drop.chance - a.drop.chance);
    const places = (row.places||[]).join("、");
    detailEl.innerHTML = '<div class="hero">'+icon(row.icon, row.title)+'<div><h2>'+row.title+'</h2>'+(places ? '<div class="muted">地点：'+places+'</div>' : '')+'</div></div>'
      + '<table><thead><tr><th>来源</th><th>数量</th><th>几率</th></tr></thead><tbody>'
      + (from.length ? from.map(({source, drop}) => '<tr><td><a data-source="'+encodeURIComponent(rowKey("sources", source))+'">'+sourceLabel(source).replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]))+'</a></td><td>'+(drop.amount||"")+'</td><td>'+formatPct(drop.chance)+'</td></tr>').join("") : '<tr><td colspan="3" class="muted">没有怪物或搜刮点掉这个</td></tr>')
      + '</tbody></table>';
    bindJumps(detailEl);
  } else if (mode === "maps") {
    const colors = ["#e2b15a", "#7dcea0", "#8eb6ff", "#e07a7a", "#c39bd3", "#f0b27a", "#76d7c4", "#f7dc6f", "#85c1e9", "#f5b7b1"];
    const regionColors = ["#7dcea0", "#8eb6ff", "#e2b15a", "#e07a7a", "#c39bd3", "#f0b27a", "#76d7c4", "#f7dc6f", "#85c1e9", "#f5b7b1", "#abebc6", "#d7bde2"];
    const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
    const titles = [...new Set(row.pins.map(pin => pin.title))];
    const colorOf = (title) => colors[titles.indexOf(title) % colors.length];
    const regions = row.regions || [];
    const q = qEl.value.trim().toLowerCase();
    const mapHit = !q || row.title.toLowerCase().includes(q);
    function legendBlock(title, group, body) {
      if (!body) return "";
      return '<div class="legend-block"><div class="legend-tools"><b>'+title+'</b><button type="button" class="tag bulk" data-bulk="'+group+'" data-on="1">全选</button><button type="button" class="tag bulk" data-bulk="'+group+'" data-on="0">全不选</button></div><div class="legend">'+body+'</div></div>';
    }
    function sourceAttr(asset) {
      if (!asset) return "";
      const source = db.sources.find(s => s.asset === asset);
      if (!source) return "";
      return ' data-source="'+encodeURIComponent(rowKey("sources", source))+'"';
    }
    const regionLegend = regions.map((region, index) => '<button type="button" class="tag region-filter on" data-key="'+index+'" aria-pressed="true" data-title="'+esc(region.title)+'"><span class="dot" style="background:'+regionColors[index % regionColors.length]+'"></span>'+esc(region.title)+'</button>').join("");
    const legend = titles.map(title => '<button type="button" class="tag pin-filter on" data-key="'+esc(title)+'" aria-pressed="true" data-title="'+esc(title)+'"><span class="dot" style="background:'+colorOf(title)+'"></span>'+esc(title)+'</button>').join("");
    const npcs = row.npcs || [];
    const bosses = row.bosses || [];
    const npcTitles = [...new Set(npcs.map(actor => actor.title))];
    const bossTitles = [...new Set(bosses.map(actor => actor.title))];
    const npcLegend = npcTitles.map(title => '<button type="button" class="tag npc-filter on" data-key="'+esc(title)+'" aria-pressed="true" data-title="'+esc(title)+'"><span class="dot" style="background:#5dade2"></span>'+esc(title)+'</button>').join("");
    const bossLegend = bossTitles.map(title => '<button type="button" class="tag boss-filter on" data-key="'+esc(title)+'" aria-pressed="true" data-title="'+esc(title)+'"><span class="dot" style="background:#e74c3c"></span>'+esc(title)+'</button>').join("");
    const shapes = regions.map((region, index) => {
      const color = regionColors[index % regionColors.length];
      const polys = region.paths.map(path => '<polygon points="'+path.map(p => p.left+","+p.top).join(" ")+'" fill="'+color+'" fill-opacity="0.16" stroke="'+color+'" stroke-width="0.28" stroke-linejoin="round"></polygon>').join("");
      return '<g data-key="'+index+'" data-title="'+esc(region.title)+'">'+polys+'</g>';
    }).join("");
    const bossPaths = bosses.filter(boss => (boss.path || []).length >= 2).map(boss => '<polyline class="boss-path" data-key="'+esc(boss.title)+'" data-title="'+esc(boss.title)+'" points="'+boss.path.map(p => p.left+","+p.top).join(" ")+'" fill="none" stroke="#e74c3c" stroke-width="0.45" stroke-dasharray="1.2 0.7" stroke-linecap="round"></polyline>').join("");
    const labels = regions.map((region, index) => '<div class="region-label" data-key="'+index+'" data-title="'+esc(region.title)+'" style="left:'+region.left+'%;top:'+region.top+'%;color:'+regionColors[index % regionColors.length]+'">'+esc(region.title)+'</div>').join("");
    const dots = row.pins.map(pin => {
      const shown = mapHit || pin.title.toLowerCase().includes(q);
      return '<button type="button" class="pin" data-loot="'+pin.table+'" data-key="'+esc(pin.title)+'" data-title="'+esc(pin.title)+'" title="'+esc(pin.title)+'" style="left:'+pin.left+'%;top:'+pin.top+'%;background:'+colorOf(pin.title)+';display:'+(shown?"":"none")+'"></button>';
    }).join("");
    const entrances = row.entrances || [];
    const gateNudges = entrances.map((entrance, index) => entrances.slice(0, index).filter(other => Math.abs(other.left - entrance.left) < 4 && Math.abs(other.top - entrance.top) < 8).length);
    const gateLegend = entrances.map((entrance, index) => '<button type="button" class="tag gate-filter on" data-key="'+index+'" aria-pressed="true" data-title="'+esc(entrance.title)+'"><span class="dot" style="background:'+(entrance.kind==="extract"?"#e07a7a":"#f7dc6f")+'"></span>'+esc(entrance.title)+'</button>').join("");
    const gates = entrances.map((entrance, index) => {
      const shown = mapHit || (entrance.title + " " + entrance.detail).toLowerCase().includes(q);
      const color = entrance.kind === "extract" ? "#e07a7a" : "#f7dc6f";
      const tip = entrance.detail ? entrance.title + "：" + entrance.detail : entrance.title;
      const labelShift = entrance.left > 70 ? "translate(calc(-100% - 8px),-50%)" : "translate(8px,-50%)";
      return '<div class="gate'+(entrance.kind==="extract"?" extract":"")+'" data-key="'+index+'" data-title="'+esc(entrance.title)+'" data-detail="'+esc(entrance.detail)+'" title="'+esc(tip)+'" style="left:'+entrance.left+'%;top:'+entrance.top+'%;display:'+(shown?"":"none")+'"></div>'
        + '<div class="gate-label" data-key="'+index+'" data-title="'+esc(entrance.title)+'" data-detail="'+esc(entrance.detail)+'" style="left:'+entrance.left+'%;top:'+entrance.top+'%;transform:'+labelShift+';margin-top:'+(gateNudges[index]*15)+'px;color:'+color+';display:'+(shown?"":"none")+'">'+esc(entrance.title)+'</div>';
    }).join("");
    function actorMarks(list, kind) {
      const nudges = list.map((actor, index) => list.slice(0, index).filter(other => other.title === actor.title && Math.abs(other.left - actor.left) < 4 && Math.abs(other.top - actor.top) < 8).length);
      return list.map((actor, index) => {
        const shown = mapHit || actor.title.toLowerCase().includes(q);
        const labelShift = actor.left > 70 ? "translate(calc(-100% - 8px),-50%)" : "translate(8px,-50%)";
        const tag = actor.asset ? "button" : "div";
        const color = kind === "boss" ? "#e74c3c" : "#5dade2";
        return '<'+tag+(tag==="button"?' type="button"':'')+' class="actor '+kind+'" data-key="'+esc(actor.title)+'" data-title="'+esc(actor.title)+'" title="'+esc(actor.title)+'"'+sourceAttr(actor.asset)+' style="left:'+actor.left+'%;top:'+actor.top+'%;display:'+(shown?"":"none")+'"></'+tag+'>'
          + '<div class="actor-label '+kind+'-label" data-key="'+esc(actor.title)+'" data-title="'+esc(actor.title)+'" style="left:'+actor.left+'%;top:'+actor.top+'%;transform:'+labelShift+';margin-top:'+(nudges[index]*15)+'px;color:'+color+';display:'+(shown?"":"none")+'">'+esc(actor.title)+'</div>';
      }).join("");
    }
    const npcMarks = actorMarks(npcs, "npc");
    const bossMarks = actorMarks(bosses, "boss");
    const pathCount = bosses.filter(boss => (boss.path || []).length >= 2).length;
    const note = [
      regions.length ? "区域轮廓 "+regions.length+" 块，沿遮罩贴图边缘描出，并去掉落在纯色空地上、以及横跨空地的部分。" : "",
      entrances.length ? "入口 "+entrances.length+" 处：菱形是场景里的传送门，方块是撤离点。" : "这张地图的场景里没有写死的传送门或撤离点。",
      row.pins.length ? "固定搜刮点 "+row.pins.length+" 处，点标记打开对应掉落。" : "这张地图的场景里没有写死的搜刮点坐标。",
      npcs.length ? "NPC "+npcs.length+" 处，蓝点是场景里写死的位置。能对上来源的点可以打开该条目。" : "这张地图的场景里没有写死的 NPC 坐标。",
      bosses.length ? "固定怪 "+bosses.length+" 处，红菱形是场景里写死、总会刷在原地的具名单位。"+(pathCount ? "虚线是同一只怪旁边分开的巡逻点。" : "") : "这张地图的场景里没有写死的具名怪物坐标。",
    ].filter(Boolean).join("");
    detailEl.innerHTML = '<h2>'+esc(row.title)+'</h2><p class="muted">'+note+'</p>'+legendBlock("区域", "region", regionLegend)+legendBlock("入口", "gate", gateLegend)+legendBlock("搜刮点", "pin", legend)+legendBlock("NPC", "npc", npcLegend)+legendBlock("固定怪", "boss", bossLegend)+'<div class="mapzoom"><button type="button" class="zoom-btn" data-zoom="in">放大</button><button type="button" class="zoom-btn" data-zoom="out" disabled>缩小</button><button type="button" class="zoom-btn" data-zoom="reset">还原</button><span class="zoom-readout">100%</span></div><div class="mapwrap"><div class="mapstage"><img draggable="false" alt="'+esc(row.title)+'" src="'+row.image+'"><svg viewBox="0 0 100 100" preserveAspectRatio="none">'+shapes+bossPaths+'</svg>'+labels+gates+dots+npcMarks+bossMarks+'</div><div class="mapsizer"></div></div>';
    bindJumps(detailEl);
    function checkedKeys(selector) {
      const buttons = [...detailEl.querySelectorAll(selector)];
      const on = new Set(buttons.filter(btn => btn.classList.contains("on")).map(btn => btn.dataset.key));
      return { buttons, on };
    }
    function showIf(el, picked) {
      const text = (el.dataset.title + " " + (el.dataset.detail || "")).toLowerCase();
      const matched = mapHit || text.includes(q);
      const shown = (!picked.buttons.length || picked.on.has(el.dataset.key)) && matched;
      el.style.display = shown ? "" : "none";
    }
    function applyRegions() {
      const picked = checkedKeys(".region-filter");
      detailEl.querySelectorAll(".mapstage svg g, .mapstage .region-label").forEach(el => showIf(el, picked));
    }
    function applyGates() {
      const picked = checkedKeys(".gate-filter");
      detailEl.querySelectorAll(".mapstage .gate, .mapstage .gate-label").forEach(el => showIf(el, picked));
    }
    function applyPins() {
      const picked = checkedKeys(".pin-filter");
      detailEl.querySelectorAll(".mapstage .pin").forEach(el => showIf(el, picked));
    }
    function applyNpcs() {
      const picked = checkedKeys(".npc-filter");
      detailEl.querySelectorAll(".mapstage .npc, .mapstage .npc-label").forEach(el => showIf(el, picked));
    }
    function applyBosses() {
      const picked = checkedKeys(".boss-filter");
      detailEl.querySelectorAll(".mapstage .boss, .mapstage .boss-label, .mapstage .boss-path").forEach(el => showIf(el, picked));
    }
    function bindChecks(selector, apply) {
      detailEl.querySelectorAll(selector).forEach(btn => btn.onclick = () => {
        const next = !btn.classList.contains("on");
        btn.classList.toggle("on", next);
        btn.setAttribute("aria-pressed", next ? "true" : "false");
        apply();
      });
    }
    function bindBulk(group, selector, apply) {
      detailEl.querySelectorAll('[data-bulk="'+group+'"]').forEach(btn => btn.onclick = () => {
        const on = btn.dataset.on === "1";
        detailEl.querySelectorAll(selector).forEach(tag => {
          tag.classList.toggle("on", on);
          tag.setAttribute("aria-pressed", on ? "true" : "false");
        });
        apply();
      });
    }
    bindChecks(".region-filter", applyRegions);
    bindChecks(".gate-filter", applyGates);
    bindChecks(".pin-filter", applyPins);
    bindChecks(".npc-filter", applyNpcs);
    bindChecks(".boss-filter", applyBosses);
    bindBulk("region", ".region-filter", applyRegions);
    bindBulk("gate", ".gate-filter", applyGates);
    bindBulk("pin", ".pin-filter", applyPins);
    bindBulk("npc", ".npc-filter", applyNpcs);
    bindBulk("boss", ".boss-filter", applyBosses);
    applyRegions();
    applyGates();
    applyPins();
    applyNpcs();
    applyBosses();
    const mapwrap = detailEl.querySelector(".mapwrap");
    const mapstage = detailEl.querySelector(".mapstage");
    const mapsizer = detailEl.querySelector(".mapsizer");
    const zoomReadout = detailEl.querySelector(".zoom-readout");
    const zoomIn = detailEl.querySelector('[data-zoom="in"]');
    const zoomOut = detailEl.querySelector('[data-zoom="out"]');
    const zoomReset = detailEl.querySelector('[data-zoom="reset"]');
    const mapImg = mapstage.querySelector("img");
    let scale = 1;
    let fitted = "";
    const minScale = 1;
    const maxScale = 8;
    function applyScale(next, anchor) {
      const prev = scale || 1;
      scale = Math.min(maxScale, Math.max(minScale, next));
      zoomReadout.textContent = Math.round(scale * 100) + "%";
      zoomIn.disabled = scale >= maxScale - 0.001;
      zoomOut.disabled = scale <= minScale + 0.001;
      const viewW = mapwrap.clientWidth;
      if (!viewW || !mapImg.naturalWidth) return;
      const baseH = Math.max(1, Math.round(viewW * mapImg.naturalHeight / mapImg.naturalWidth));
      const box = viewW + "x" + baseH + "@" + scale;
      if (!anchor && box === fitted) return;
      fitted = box;
      let ax = 0;
      let ay = 0;
      let localX = 0;
      let localY = 0;
      if (anchor) {
        const rect = mapwrap.getBoundingClientRect();
        ax = anchor.x - rect.left;
        ay = anchor.y - rect.top;
        localX = ax + mapwrap.scrollLeft;
        localY = ay + mapwrap.scrollTop;
      }
      mapstage.style.position = "absolute";
      mapstage.style.left = "0";
      mapstage.style.top = "0";
      mapstage.style.width = viewW + "px";
      mapstage.style.height = baseH + "px";
      mapstage.style.transformOrigin = "0 0";
      mapstage.style.transform = "scale(" + scale + ")";
      mapsizer.style.width = Math.round(viewW * scale) + "px";
      mapsizer.style.height = Math.round(baseH * scale) + "px";
      mapwrap.style.height = baseH + "px";
      if (anchor) {
        const k = scale / prev;
        mapwrap.scrollLeft = localX * k - ax;
        mapwrap.scrollTop = localY * k - ay;
      }
    }
    function centerAnchor() {
      const rect = mapwrap.getBoundingClientRect();
      return { x: rect.left + mapwrap.clientWidth / 2, y: rect.top + mapwrap.clientHeight / 2 };
    }
    zoomIn.onclick = () => applyScale(scale * 1.25, centerAnchor());
    zoomOut.onclick = () => applyScale(scale / 1.25, centerAnchor());
    zoomReset.onclick = () => {
      mapwrap.scrollLeft = 0;
      mapwrap.scrollTop = 0;
      applyScale(1);
    };
    if (mapImg.complete && mapImg.naturalWidth) applyScale(1);
    mapImg.addEventListener("load", () => applyScale(scale));
    if (mapObserver) mapObserver.disconnect();
    mapObserver = new ResizeObserver(() => {
      if (!mapwrap.isConnected) { mapObserver.disconnect(); mapObserver = null; return; }
      applyScale(scale);
    });
    mapObserver.observe(mapwrap);
    mapwrap.addEventListener("wheel", (event) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
      applyScale(scale * factor, { x: event.clientX, y: event.clientY });
    }, { passive: false });
    let drag = null;
    function onDragMove(event) {
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (!drag.moved) return;
      mapwrap.scrollLeft = drag.sl - dx;
      mapwrap.scrollTop = drag.st - dy;
    }
    function onDragEnd(event) {
      if (!drag || drag.id !== event.pointerId) return;
      const moved = drag.moved;
      drag = null;
      mapwrap.classList.remove("dragging");
      window.removeEventListener("pointermove", onDragMove);
      window.removeEventListener("pointerup", onDragEnd);
      window.removeEventListener("pointercancel", onDragEnd);
      if (!moved) return;
      const stop = (clickEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
        mapwrap.removeEventListener("click", stop, true);
      };
      mapwrap.addEventListener("click", stop, true);
      setTimeout(() => mapwrap.removeEventListener("click", stop, true), 0);
    }
    mapwrap.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (!event.target.closest(".mapstage")) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, sl: mapwrap.scrollLeft, st: mapwrap.scrollTop, moved: false };
      mapwrap.classList.add("dragging");
      window.addEventListener("pointermove", onDragMove);
      window.addEventListener("pointerup", onDragEnd);
      window.addEventListener("pointercancel", onDragEnd);
    });
  }
}
function setMode(next) {
  if (next === mode) return;
  mode = next;
  syncCats("全部");
  const rows = filtered();
  const remembered = lastByMode[next];
  const hit = remembered && rows.find(r => r === remembered);
  if (hit) show(next, hit);
  else if (rows[0]) show(next, rows[0]);
  else {
    document.querySelectorAll(".tabs button").forEach(b => b.classList.remove("on"));
    document.getElementById("tab-"+next).classList.add("on");
    renderList();
    current = null;
    detailEl.innerHTML = "";
    pushView();
  }
}
function rowKey(kind, row) {
  if (!row) return "";
  if (kind === "tables") return "t:" + row.enumName;
  if (kind === "sources") return "s:" + row.asset + "|" + row.title;
  if (kind === "items") return "i:" + row.id;
  return "m:" + (row.image || row.title);
}
function rowByKey(key) {
  const split = String(key || "").indexOf(":");
  if (split < 0) return null;
  const kind = key.slice(0, split);
  const rest = key.slice(split + 1);
  if (kind === "t") return db.dropTables.find(t => t.enumName === rest) || null;
  if (kind === "s") {
    const bar = rest.indexOf("|");
    const asset = bar < 0 ? rest : rest.slice(0, bar);
    const title = bar < 0 ? "" : rest.slice(bar + 1);
    return db.sources.find(s => s.asset === asset && s.title === title) || db.sources.find(s => s.asset === asset) || null;
  }
  if (kind === "i") return db.items.find(it => String(it.id) === rest) || null;
  return (db.maps || []).find(m => m.image === rest || m.title === rest) || null;
}
function viewState() {
  return { mode, id: rowKey(mode, current), q: qEl.value, cat: catEl.value || "全部" };
}
function stateUrl(state) {
  return "#" + [state.mode, encodeURIComponent(state.id || ""), encodeURIComponent(state.cat || "全部")].join("/");
}
function decodeState(hash) {
  const raw = String(hash || "").replace(/^#/, "");
  if (!raw) return null;
  const parts = raw.split("/");
  const nextMode = parts[0];
  if (!["tables", "sources", "items", "maps"].includes(nextMode)) return null;
  let id = "";
  let q = "";
  let cat = "全部";
  try {
    id = decodeURIComponent(parts[1] || "");
    cat = decodeURIComponent(parts[2] || "全部");
  } catch (e) { return null; }
  return { mode: nextMode, id, q, cat };
}
function sameState(a, b) {
  return !!a && !!b && a.mode === b.mode && a.id === b.id && a.q === b.q && a.cat === b.cat;
}
function writeState(state, replace) {
  const url = stateUrl(state);
  appliedUrl = url;
  historyLock = true;
  try {
    if (replace) history.replaceState(state, "", url);
    else history.pushState(state, "", url);
  } catch (e) {
    if (replace) location.replace(url);
    else location.hash = url;
  }
  historyLock = false;
}
function pushView() {
  const state = viewState();
  if (sameState(history.state, state)) return;
  writeState(state, false);
  rememberSearch(state.q);
}
function replaceView() {
  writeState(viewState(), true);
}
function present(kind, row) {
  if (kind === "tables") {
    row = sourceForTable(row && (row.enumName || row.title || ""));
    kind = "sources";
  }
  mode = kind;
  syncCats();
  document.querySelectorAll(".tabs button").forEach(b => b.classList.remove("on"));
  document.getElementById("tab-"+kind).classList.add("on");
  renderList();
  if (row) open(row);
  else { current = null; detailEl.innerHTML = ""; }
  const rows = filtered();
  const idx = row ? rows.findIndex(r => r === row || (r.enumName && r.enumName === row.enumName && !r.asset) || (r.id != null && row.id != null && r.id === row.id && r.name === row.name) || (r.asset && r.asset === row.asset && r.title === row.title) || (r.image && r.image === row.image)) : -1;
  const btn = idx >= 0 ? listEl.querySelector('.row[data-i="'+idx+'"]') : null;
  if (btn) {
    btn.classList.add("active");
    btn.scrollIntoView({ block: "nearest" });
  }
}
function applyView(state) {
  if (!state) return;
  const url = stateUrl(state);
  if (url === appliedUrl) return;
  appliedUrl = url;
  qEl.value = state.q || "";
  mode = state.mode;
  syncCats(state.cat);
  present(state.mode, rowByKey(state.id) || filtered()[0] || null);
}
const SEARCH_KEY = "vaultbreakers-wiki-searches";
function loadSearches() {
  try { return JSON.parse(localStorage.getItem(SEARCH_KEY) || "[]").filter(item => typeof item === "string" && item.trim()); }
  catch (e) { return []; }
}
function rememberSearch(text) {
  const q = String(text || "").trim();
  if (!q) return;
  try {
    const next = [q, ...loadSearches().filter(item => item !== q)].slice(0, 12);
    localStorage.setItem(SEARCH_KEY, JSON.stringify(next));
  } catch (e) {}
}
function renderHistory() {
  const q = qEl.value.trim().toLowerCase();
  const items = loadSearches().filter(item => !q || item.toLowerCase().includes(q)).slice(0, 8);
  if (!items.length) { historyEl.hidden = true; historyEl.innerHTML = ""; return; }
  historyEl.innerHTML = '<p>搜索历史</p>' + items.map(item => '<button type="button" data-q="'+item.replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]))+'">'+item.replace(/[&<>]/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;" }[ch]))+'</button>').join("");
  historyEl.hidden = false;
  historyEl.querySelectorAll("button").forEach(btn => {
    btn.onmousedown = (event) => event.preventDefault();
    btn.onclick = () => {
      qEl.value = btn.dataset.q || "";
      renderList();
      replaceView();
      historyEl.hidden = true;
    };
  });
}
function applyHash() {
  const state = decodeState(location.hash);
  if (state) applyView(state);
}
document.getElementById("tab-sources").onclick = () => setMode("sources");
document.getElementById("tab-items").onclick = () => setMode("items");
document.getElementById("tab-maps").onclick = () => setMode("maps");
let searchTimer = 0;
qEl.oninput = () => {
  renderList();
  replaceView();
  renderHistory();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => rememberSearch(qEl.value), 600);
};
qEl.onfocus = () => renderHistory();
qEl.onblur = () => { rememberSearch(qEl.value); setTimeout(() => { historyEl.hidden = true; }, 160); };
qEl.onkeydown = (event) => {
  if (event.key === "Enter") { rememberSearch(qEl.value); historyEl.hidden = true; }
  if (event.key === "Escape") historyEl.hidden = true;
};
catEl.onchange = () => {
  const rows = filtered();
  if (current && rows.includes(current)) {
    renderList();
    const btn = listEl.querySelector('.row[data-i="'+rows.indexOf(current)+'"]');
    if (btn) btn.classList.add("active");
    pushView();
    return;
  }
  if (rows[0]) show(mode, rows[0]);
  else {
    renderList();
    current = null;
    detailEl.innerHTML = "";
    pushView();
  }
};
window.addEventListener("popstate", (event) => {
  if (historyLock) return;
  if (event.state) applyView(event.state);
  else applyHash();
});
window.addEventListener("hashchange", () => {
  if (historyLock) return;
  applyHash();
});
mode = "sources";
{
  const saved = decodeState(location.hash);
  const savedRow = saved && rowByKey(saved.id);
  if (saved && savedRow) {
    qEl.value = saved.q || "";
    mode = saved.mode;
    syncCats(saved.cat);
    present(saved.mode, savedRow);
  } else {
    syncCats("全部");
    if (filtered()[0]) present("sources", filtered()[0]);
  }
  replaceView();
}
</script>
</body>
</html>`;
  fs.writeFileSync(path.join(ROOT, "index.html"), html);
}

main();
