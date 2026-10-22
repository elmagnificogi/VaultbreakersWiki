const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const { parseUnityFS, extractNode } = require("./unityfs");
const { parseSerialized, readObject, readValue, R } = require("./serialized");
const { decodeTexture } = require("./dxt");
const { extractGameMaps, collectSpawns, MAP_DEFS } = require("./maps");
const { collectCodex } = require("./codex");
const { attachCombat } = require("./combat");
const { attachSalvage } = require("./salvage");
const { fillCreaturePortraits, fillNpcPortraits } = require("./render-creatures");

const ROOT = __dirname;
const GAME = path.resolve(ROOT, "..");
const BUNDLE_DIR = path.join(GAME, "Vaultbreakers_Data", "StreamingAssets", "aa", "StandaloneWindows64");
const CONFIG_BUNDLE = "0563f413959c8f3465f5b3d19fece440.bundle";
const ICON_BUNDLE = "d690eafe8fe5a7e08f9f6fa44534a52e.bundle";
const ZH_BUNDLE = "4ce0a894b5e7192d33184335bd5bec42.bundle";
const SHARED_STRINGS_BUNDLE = "0be045fb94ecb50bb5159a32ba66c0a4.bundle";
const DUMP = path.join(ROOT, "il2cpp", "dump.cs");

const RARITY = ["常见", "罕见", "稀有", "卓越", "传奇", "任务物品", "诅咒物品"];
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

function flipVertical(rgba, width, height) {
  const out = Buffer.alloc(rgba.length);
  const stride = width * 4;
  for (let y = 0; y < height; y++) rgba.copy(out, (height - 1 - y) * stride, y * stride, (y + 1) * stride);
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

const QUEST_NEED = {
  3: "收集",
  4: "携带撤离",
  5: "制作",
  13: "持有",
  14: "交付",
  20: "携带击杀",
};

function bundleForAddress(address) {
  const buf = fs.readFileSync(path.join(GAME, "Vaultbreakers_Data", "StreamingAssets", "aa", "catalog.bin"));
  const missing = 0xffffffff;
  const u32 = (o) => buf.readUInt32LE(o);
  const i32 = (o) => buf.readInt32LE(o);
  const keysOffset = u32(8);
  const count = i32(keysOffset - 4) / 4;
  const cache = new Map();
  const basic = (offset) => {
    const len = i32(offset - 4);
    if (len < 0 || len > 4000 || offset + len > buf.length) return null;
    return buf.toString("utf8", offset, offset + len);
  };
  const encoded = (value, sep) => {
    if (value === missing || value === missing - 1) return null;
    if (cache.has(value)) return cache.get(value);
    const offset = value & 0x3fffffff;
    let result;
    if ((value & 0x40000000) !== 0 && sep) {
      const parts = [];
      let at = offset;
      for (let n = 0; n < 12; n++) {
        const part = encoded(u32(at), null);
        const next = u32(at + 4);
        if (part) parts.push(part);
        if (next === missing) break;
        at = next;
      }
      result = parts.length === 1 ? parts[0] : parts.reverse().join(sep);
    } else if ((value & 0x80000000) !== 0) {
      const len = i32(offset - 4);
      result = buf.toString("utf16le", offset, offset + len);
    } else result = basic(offset);
    cache.set(value, result);
    return result;
  };
  const keyAt = (offset) => {
    const typeOff = u32(offset);
    const objOff = u32(offset + 4);
    if (!typeOff || typeOff === missing || typeOff > buf.length) return null;
    const cls = encoded(u32(typeOff + 4), ".");
    if (!cls || !String(cls).endsWith("String")) return null;
    if (objOff === missing) return "";
    const sep = String.fromCharCode(buf[objOff + 4]);
    return encoded(u32(objOff), sep && sep !== "\0" ? sep : null);
  };
  const bundleOf = (locOff, depth) => {
    if (!locOff || locOff === missing || depth > 6) return "";
    const bytes = i32(locOff - 4);
    const n = bytes / 4;
    if (!Number.isFinite(n) || n < 0 || n > 40) return "";
    for (let j = 0; j < n; j++) {
      const off = u32(locOff + j * 4);
      const internalId = encoded(u32(off + 4), "/");
      if (internalId && internalId.endsWith(".bundle")) return internalId.split(/[/\\]/).pop();
      const nested = bundleOf(u32(off + 12), depth + 1);
      if (nested) return nested;
    }
    return "";
  };
  for (let i = 0; i < count; i += 2) {
    if (keyAt(u32(keysOffset + i * 4)) !== address) continue;
    const file = bundleOf(u32(keysOffset + (i + 1) * 4), 0);
    if (file && fs.existsSync(path.join(BUNDLE_DIR, file))) return file;
  }
  throw new Error("missing address " + address);
}

const SPAWN_ALIASES = {
  PoisonSpiderlingElite: "ElitePoisonSpiderling",
  DesertSpiderlingElite: "EliteDesertSpiderling",
  MegaPebble: "MegaPebbleGolem",
  EnragedForestGolem: "EliteEnragedForestGolem",
  WanderingBear: "BearWandering",
  Howly: "WerewolfMageHowly",
  BanditDagger_Werewolf: "DaggerBanditWerewolf",
  BanditCrossbow_Werewolf: "CrossbowBanditWerewolf",
  EliteDesertSpiderling_SpiderMatriach: "SpiderMatriarch",
  EliteDesertSpiderling_Named_SpiderMatriach: "SpiderMatriarch",
  "Bahra (titan temp)": "Bahra",
  EliteBarrelScrat_Named_Red: "BigKeg",
  EliteNetterScrat_Named_Red: "BeastPoacher",
  EliteEngineerScrat_Named_Yellow: "CheeseTank",
  EliteEngineerScrat_Named_Blue: "BlueBlazer",
  EliteNetterScrat_Named_Blue: "KingFisher",
};

function spawnUnit(name) {
  const unit = name
    .replace(/_\d+$/, "")
    .replace(/_(\d+_)?Fast$/, "")
    .replace(/_Sleeping$/, "")
    .replace(/_NotRandomPath$/, "");
  return unit.startsWith("Boss_") ? unit.slice(5) : unit;
}

function attachMonsterSpawns(sources, maps) {
  const owners = new Map();
  for (const source of sources) {
    if (source.category !== "怪物") continue;
    delete source.spawns;
    const stem = String(source.asset || "").replace(/ConfigurationAsset$/, "");
    if (!stem) continue;
    const key = stem.toLowerCase();
    if (!owners.has(key)) owners.set(key, []);
    owners.get(key).push(source);
  }
  let linked = 0;
  const matched = new Set();
  for (const def of MAP_DEFS) {
    if (!maps.some((map) => map.id === def.id)) continue;
    const points = collectSpawns(def);
    console.log("spawns", def.id, points.length);
    for (const point of points) {
      const unit = SPAWN_ALIASES[spawnUnit(point.unit)] || spawnUnit(point.unit);
      const rows = owners.get(unit.toLowerCase());
      if (!rows) continue;
      for (const source of rows) {
        if (!source.spawns) source.spawns = [];
        const mark = { map: def.id, left: point.left, top: point.top };
        if (point.path) mark.path = point.path;
        source.spawns.push(mark);
      }
      matched.add(unit);
      linked++;
    }
  }
  console.log("spawn points linked", linked, "monsters", matched.size);
}

function charsOf(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length && value.every((n) => typeof n === "number" && n >= 0 && n < 256)) return Buffer.from(value).toString("utf8");
  return "";
}

function collectQuestNeeds() {
  const sharedName = bundleForAddress("Assets/Core/Localization/Data/Tables/QuestStrings Shared Data.asset");
  const zhName = bundleForAddress("QuestStrings_zh");
  const shared = loadBundle(sharedName);
  const sharedSf = parseSerialized(extractNode(shared, shared.nodes.find((n) => !n.path.includes("."))));
  const keyToId = new Map();
  for (const obj of sharedSf.objects) {
    const typ = sharedSf.types[obj.typeId];
    if (!typ || !typ.node || !typ.node.children.some((child) => child.name === "m_TableCollectionName")) continue;
    let parsed;
    try { parsed = readSharedStringKeys(sharedSf, obj); } catch { continue; }
    if (parsed.collection !== "QuestStrings" && parsed.collection !== "DefaultStrings") continue;
    for (const [key, id] of parsed.keyToId) keyToId.set(key, id);
  }
  const zh = loadBundle(zhName);
  const zhSf = parseSerialized(extractNode(zh, zh.nodes.find((n) => !n.path.includes("."))));
  const rawById = new Map();
  for (const obj of zhSf.objects) {
    let value;
    try { value = readObject(zhSf, obj).value; } catch { continue; }
    const tableName = utf8(value["#427"]);
    if (tableName !== "QuestStrings_zh" && tableName !== "DefaultStrings_zh") continue;
    for (const row of value.m_TableData || []) {
      const text = utf8(row.m_Localized);
      if (text) rawById.set(String(row.m_Id), text);
    }
  }
  const byKey = new Map();
  for (const [key, id] of keyToId) {
    const text = rawById.get(String(id));
    if (text) byKey.set(key, text);
  }
  const expand = (text, depth) => {
    if (!text || depth > 4) return text || "";
    return text.replace(/<ref>([A-Za-z0-9_]+)<\/ref>/g, (all, key) => {
      const next = byKey.get(key);
      return next ? expand(next, depth + 1) : all;
    }).replace(/\{@[A-Za-z0-9_]+\.([A-Za-z0-9_]+)\}/g, (all, key) => {
      const next = byKey.get(key);
      return next ? expand(next, depth + 1) : all;
    });
  };
  const questTitle = (id) => {
    const keyId = keyToId.get(id + "-Name");
    return keyId ? displayText(expand(rawById.get(String(keyId)) || "", 0)) : "";
  };

  const graph = loadBundle(bundleForAddress("QuestGraph.asset"));
  const sf = parseSerialized(extractNode(graph, graph.nodes.find((n) => !n.path.includes("."))));
  const obj = sf.objects.find((row) => {
    const typ = sf.types[row.typeId];
    return typ && typ.node && typ.node.children.some((child) => child.name === "references");
  });
  const root = sf.types[obj.typeId].node;
  const byClass = new Map(sf.refTypes.map((typ) => [typ.className, typ]));
  const reader = new R(sf.buf, sf.endian);
  reader.o = sf.dataOffset + obj.byteStart;
  for (const child of root.children) {
    if (child.name === "references") break;
    readValue(reader, child);
  }
  const refNode = root.children.find((child) => child.name === "references");
  readValue(reader, refNode.children[0]);
  const element = refNode.children[1].children[0].children[1];
  const count = reader.i32();
  const needs = new Map();
  const seen = new Set();
  const quests = [];
  const questSeen = new Set();
  const textOf = (key) => {
    const keyId = keyToId.get(key);
    return keyId ? displayText(expand(rawById.get(String(keyId)) || "", 0)) : "";
  };
  const chinese = (text) => /[\u4e00-\u9fff]/.test(text || "") ? text : "";
  const npcEnum = parseEnum(fs.readFileSync(DUMP, "utf8"), "NpcType");
  const npcName = (id) => {
    const en = npcEnum.map[String(id | 0)];
    if (!en) return "";
    return chinese(textOf("Name_" + en) || textOf(en));
  };
  const areaKeys = [[2, "MapName_Pinewood"], [4, "MapName_Refinery"], [8, "MapName_Haven"], [16, "MapName_Bloodswamp"], [32, "MapName_Dragonvault"], [64, "MapName_TitanFactory"]];
  const areaName = new Map(areaKeys.map(([flag, key]) => [flag, chinese(textOf(key))]));
  const shortLabel = (keys) => {
    for (const key of keys) {
      const text = chinese(textOf(key));
      if (text && text.length <= 8 && !/[A-Za-z]/.test(text)) return text;
    }
    return "";
  };
  const typeName = {
    1: shortLabel(["QuestType_MainQuestLine", "MainQuestLine", "Quest_MainQuestLine"]),
    2: shortLabel(["QuestType_Daily", "DailyQuest", "Quest_Daily"]),
    3: shortLabel(["QuestType_Weekly", "WeeklyQuest", "Quest_Weekly"]),
    4: shortLabel(["QuestType_BuildingUpgrade", "BuildingUpgradeQuest"]),
    5: shortLabel(["QuestType_ObjectDelivery", "ObjectDeliveryQuest"]),
    6: shortLabel(["QuestType_Repeatable", "RepeatableQuest", "Quest_Repeatable"]),
  };
  for (let i = 0; i < count; i++) {
    readValue(reader, element.children[0]);
    const type = readValue(reader, element.children[1]);
    const cls = charsOf(type.class);
    const typ = byClass.get(cls);
    if (!typ) throw new Error("unknown quest node " + cls);
    const value = readValue(reader, typ.node);
    if (cls !== "QuestNode") continue;
    const questId = charsOf(value._questId);
    const title = questTitle(questId);
    if (!title || !/[\u4e00-\u9fff]/.test(title)) continue;
    if (!questSeen.has(questId)) {
      questSeen.add(questId);
      const steps = [];
      const stepSeen = new Set();
      for (const objective of value.Objectives || []) {
        const kind = QUEST_NEED[objective.Type];
        const itemId = objective.ItemType | 0;
        const amount = objective.Count > 0 ? objective.Count : 1;
        if (kind && itemId > 0) {
          const stepKey = kind + "|" + itemId + "|" + amount;
          if (!stepSeen.has(stepKey)) {
            stepSeen.add(stepKey);
            steps.push({ kind: objective.Optional ? kind + "（可选）" : kind, item: itemId, count: amount });
          }
          continue;
        }
        if (!objective.UseCustomDescription) continue;
        const custom = displayText(expand(charsOf(objective.CustomDescription), 0));
        if (!chinese(custom) || /[A-Za-z]{4,}/.test(custom)) continue;
        const text = objective.Optional && !custom.includes("可选") ? custom + "（可选）" : custom;
        if (stepSeen.has(text)) continue;
        stepSeen.add(text);
        steps.push({ text, count: amount > 1 ? amount : 0 });
      }
      const rewards = [];
      const rewardSeen = new Set();
      for (const reward of value.Rewards || []) {
        if ((reward.RewardType | 0) !== 0) continue;
        const itemId = reward.ItemType | 0;
        if (itemId <= 0 || rewardSeen.has(itemId)) continue;
        rewardSeen.add(itemId);
        rewards.push({ item: itemId, count: reward.StackSize > 0 ? reward.StackSize : 1 });
      }
      const areas = [];
      const flags = value.QuestAreaFlags | 0;
      for (const [flag, name] of areaName) if (name && (flags & flag)) areas.push(name);
      const kind = typeName[value.QuestType | 0] || "";
      if (kind && !areas.includes(kind)) areas.push(kind);
      const giver = npcName(value.Sender);
      const turnIn = npcName(value.Receiver);
      quests.push({
        id: questId,
        title,
        description: chinese(textOf(questId + "-Desc")),
        handIn: chinese(textOf(questId + "-HandIn")),
        giver,
        turnIn: turnIn && turnIn !== giver ? turnIn : "",
        areas,
        steps,
        rewards,
      });
    }
    for (const objective of value.Objectives || []) {
      const kind = QUEST_NEED[objective.Type];
      const itemId = objective.ItemType | 0;
      if (!kind || itemId <= 0) continue;
      const amount = objective.Count > 0 ? objective.Count : 1;
      const key = questId + "|" + itemId + "|" + objective.Type + "|" + amount;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!needs.has(itemId)) needs.set(itemId, []);
      needs.get(itemId).push({ quest: title, id: questId, kind: objective.Optional ? kind + "（可选）" : kind, count: amount });
    }
  }
  for (const rows of needs.values()) rows.sort((a, b) => a.quest.localeCompare(b.quest, "zh-CN") || a.kind.localeCompare(b.kind, "zh-CN"));
  quests.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
  return { needs, quests };
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
    png.data = flipVertical(rgba, value.m_Width, value.m_Height);
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
      const upright = flipVertical(rgba, value.m_Width, value.m_Height);
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
      title = ashen;
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
  const npcShots = fillNpcPortraits();
  let npcIcons = 0;
  for (const source of sources) {
    if (source.icon || !npcShots.assets[source.asset]) continue;
    source.icon = npcShots.assets[source.asset];
    npcIcons++;
  }
  console.log("npc fronts", Object.keys(npcShots.tokens).length, "source icons", npcIcons);
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
          icon: (source && source.icon) || npcShots.tokens[actor.token] || "",
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
      links: map.links || [],
      pickups: map.pickups || [],
    };
  });

  attachMonsterSpawns(sources, gameMaps);

  console.log("reading characters, skills, gear");
  const codex = collectCodex(sf, readObject, {
    asString,
    walk,
    byKey,
    textIds,
    chinese,
    abilities: parseEnum(dump, "AbilityType"),
    classes: parseEnum(dump, "CharacterClass"),
    stats: parseEnum(dump, "StatType"),
    specials: parseEnum(dump, "LoadoutSpecialStatType"),
    iconFor,
    search,
    itemById,
    rarityNames: RARITY,
    displayText,
  });
  console.log("characters", codex.characters.length, "skills", codex.skills.length, "gear", codex.gear.length);

  attachCombat(sources);

  const questCatalog = collectQuestNeeds();
  const questNeeds = questCatalog.needs;
  let questItems = 0;
  for (const item of itemList) {
    const rows = questNeeds.get(item.id);
    if (!rows) continue;
    item.needs = rows;
    questItems++;
  }
  console.log("quest items", questItems);
  attachSalvage(itemList, dropTables, codex.gear);

  const usedIcons = new Set();
  for (const table of dropTables) for (const e of table.entries) if (e.itemIcon) usedIcons.add(e.itemIcon);
  for (const source of sources) if (source.icon) usedIcons.add(source.icon);
  for (const item of itemList) if (item.icon) usedIcons.add(item.icon);

  const db = {
    generatedAt: new Date().toISOString(),
    dropTables: dropTables.sort((a, b) => a.title.localeCompare(b.title, "zh-CN")),
    sources: sources.sort((a, b) => a.title.localeCompare(b.title, "zh-CN")),
    items: itemList.filter((it) => it.needs || it.icon || dropTables.some((t) => t.entries.some((e) => e.item === it.id))).sort((a, b) => a.title.localeCompare(b.title, "zh-CN")),
    quests: questCatalog.quests,
    characters: codex.characters,
    skills: codex.skills,
    gear: codex.gear,
    labels: codex.labels,
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
<title>龙窟破坏者WIKI</title>
<style>
  :root { color-scheme: dark; --bg:#12141a; --panel:#1c2030; --line:#31384d; --text:#e7ebf5; --muted:#9aa3b8; --accent:#e2b15a; --good:#7dcea0; }
  * { box-sizing: border-box; }
  html, body { height:100%; }
  html { overflow:hidden; }
  body { margin:0; height:100vh; overflow:hidden; display:flex; flex-direction:column; font:15px/1.45 "Segoe UI", "Microsoft YaHei", sans-serif; background:var(--bg); color:var(--text); }
  header { padding:18px 22px 0; border-bottom:1px solid var(--line); display:flex; flex-direction:column; align-items:stretch; gap:10px; }
  .toolbar { display:flex; flex-wrap:wrap; gap:8px 16px; align-items:flex-end; }
  #cat { width:14em; }
  #cat[hidden] { display:inline-block; visibility:hidden; pointer-events:none; }
  h1 { margin:0; font-size:22px; }
  header p { margin:4px 0 0; color:var(--muted); }
  header .meta { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  a.gh { display:inline-flex; align-items:center; gap:5px; color:inherit; text-decoration:none; border:1px solid var(--line); border-radius:999px; padding:1px 8px 1px 6px; }
  a.gh:hover { color:var(--accent); border-color:var(--accent); }
  a.gh svg { width:14px; height:14px; display:block; }
  input, select { background:#0e1118; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:8px 10px; }
  input { min-width:260px; }
  .search { position:relative; }
  .search[hidden] { display:block; visibility:hidden; pointer-events:none; }
  .search-history { position:absolute; z-index:30; left:0; right:0; top:calc(100% + 4px); background:#1c2030; border:1px solid var(--line); border-radius:8px; padding:4px; box-shadow:0 8px 24px rgba(0,0,0,.35); }
  .search-history[hidden] { display:none; }
  .search-history p { margin:4px 8px; color:var(--muted); font-size:12px; }
  .search-history button { display:block; width:100%; text-align:left; background:transparent; color:inherit; border:0; border-radius:6px; padding:7px 8px; cursor:pointer; font:inherit; }
  .search-history button:hover { background:#262c3e; }
  main { flex:1 1 auto; min-height:0; display:grid; grid-template-columns: 340px 1fr; grid-template-rows: minmax(0, 1fr); }
  aside { border-right:1px solid var(--line); overflow:auto; min-height:0; overflow-anchor:none; }
  .list-count { margin:0; padding:10px 12px 18px; color:var(--muted); font-size:12px; }
  .row { display:flex; gap:10px; align-items:center; width:100%; text-align:left; background:transparent; color:inherit; border:0; border-bottom:1px solid #262b3c; padding:8px 12px; cursor:pointer; }
  .row:hover, .row.active { background:#262c3e; }
  .row img, img.icon, .hero img { width:42px; height:42px; object-fit:contain; background:#0e1118; border-radius:6px; vertical-align:middle; image-rendering:auto; flex:0 0 auto; }
  .hero img { width:84px; height:84px; }
  .hero img { width:84px; height:84px; }
  .row small, .muted { color:var(--muted); }
  section { padding:18px 22px 40px; overflow:auto; min-height:0; overflow-anchor:none; }
  .hero { display:flex; gap:14px; align-items:center; margin-bottom:14px; }
  table { width:100%; border-collapse:collapse; }
  h3 { margin:16px 0 8px; font-size:16px; }
  th, td { border-bottom:1px solid var(--line); padding:8px 6px; vertical-align:middle; text-align:left; }
  th { color:var(--muted); font-weight:600; }
  .bar { height:8px; background:#2a3144; border-radius:99px; overflow:hidden; min-width:70px; }
  .bar span { display:block; height:100%; background:var(--accent); }
  .tag { display:inline-block; margin:0 4px 4px 0; padding:2px 6px; border-radius:99px; background:#2a3144; color:var(--muted); font-size:12px; }
  .tabs { display:flex; flex-wrap:wrap; flex:1 0 100%; }
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
  .ground { position:absolute; z-index:3; width:12px; height:12px; margin:0; padding:0; border:2px solid #111; border-radius:2px; transform:translate(-50%,-50%); cursor:pointer; }
  .pin.maybe { background:transparent; border-style:dashed; border-width:2px; }
  .ground-zoom { max-width:560px; margin:8px 0 12px; }
  .ground-zoom .mapwrap { max-width:none; margin-top:0; }
  .ground-zoom .spawn-map { max-width:none; margin:0; }
  .spawn-map { position:relative; max-width:560px; margin:8px 0 4px; }
  .spawn-map img { width:100%; display:block; }
  .spawn-map svg { position:absolute; inset:0; width:100%; height:100%; }
  .spawn-map .route { fill:none; stroke:#f2d27a; stroke-width:0.45; stroke-dasharray:1.2 0.7; stroke-linecap:round; stroke-linejoin:round; }
  .spawn-map i { position:absolute; z-index:1; width:8px; height:8px; border:1px solid #1a120c; border-radius:50%; background:#e74c3c; transform:translate(-50%,-50%); }
  .spawn-map i.fixed { border-radius:2px; background:#e2b15a; }
  .pin:hover { outline:2px solid #fff; z-index:2; }
  .gate { position:absolute; z-index:4; width:12px; height:12px; margin:0; padding:0; border:2px solid #111; background:#f7dc6f; transform:translate(-50%,-50%) rotate(45deg); }
  .hop { position:absolute; z-index:5; width:11px; height:11px; border:2px solid #111; border-radius:50%; transform:translate(-50%,-50%); }
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
  .region-filter, .pin-filter, .ground-filter, .gate-filter, .link-filter, .npc-filter, .boss-filter { cursor:pointer; border:2px solid #3a4258; background:transparent; color:#6d778c; opacity:.48; font-weight:500; box-shadow:none; }
  .npc-filter { display:inline-flex; align-items:center; gap:6px; border-radius:8px; padding:3px 8px 3px 3px; }
  .npc-filter img { width:36px; height:48px; object-fit:contain; background:#0e1118; border-radius:6px; }
  .region-filter.on, .pin-filter.on, .ground-filter.on, .gate-filter.on, .link-filter.on, .npc-filter.on, .boss-filter.on { border:2px solid #ffe7b0; background:#46506c; color:#fff; opacity:1; font-weight:700; box-shadow:0 0 0 1px rgba(255,231,176,.55), 0 0 12px rgba(226,177,90,.55); }
  .ground:hover { outline:2px solid #fff; z-index:6; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:4px; }
  .dps h2 { margin:0 0 8px; font-size:20px; }
  main.dps-mode { grid-template-columns: 1fr; }
  main.dps-mode aside, main.dps-mode #detail { display: none; }
  #dps { display: none; }
  main.dps-mode #dps { display: block; overflow: auto; }
  .dps p { margin:6px 0 8px; }
  .dps-sets { display:flex; flex-wrap:wrap; gap:18px 28px; }
  .dps-set { display:grid; grid-template-columns:6.8em 7.5em; gap:6px 8px; align-items:center; }
  .dps-head { grid-column:1 / -1; display:flex; align-items:center; justify-content:space-between; gap:8px; }
  .dps-apply { display:flex; align-items:center; gap:6px; }
  .dps-apply select { min-width:0; width:auto; padding:2px 4px; font:inherit; font-size:12px; }
  .dps-copy { cursor:pointer; border:1px solid var(--line); background:#1c2030; color:var(--text); border-radius:8px; padding:2px 8px; font:inherit; font-size:12px; }
  .dps-copy:hover { border-color:var(--accent); color:var(--accent); }
  .dps input { min-width:0; width:100%; padding:6px 8px; }
  #dps-out { max-width:980px; margin-top:8px; }
  #dps-out tr.best td, #opt-out tr.best td { color:var(--good); font-weight:700; }
  .opt-base, .opt-item, .opt-slot-head, .opt-actions { display:flex; flex-wrap:wrap; gap:8px 12px; align-items:center; }
  .opt-slot { border:1px solid var(--line); border-radius:8px; padding:10px 12px; margin:10px 0; max-width:980px; }
  .opt-slot-name { font-weight:700; min-width:3em; }
  .opt-buff { display:flex; flex-wrap:wrap; gap:8px 12px; align-items:center; margin:8px 0; }
  .dps .opt-buff-name { width:8em; }
  .dps .opt-buff input[type="number"] { width:5.5em; }
  .dps .opt-use { width:auto; }
  .opt-item input[type="number"], .opt-base input { width:5.5em; }
  .opt-btn { cursor:pointer; border:1px solid var(--line); background:#1c2030; color:var(--text); border-radius:8px; padding:6px 10px; font:inherit; }
  .opt-btn:hover { border-color:var(--accent); color:var(--accent); }
  #opt-out { max-width:1180px; margin-top:8px; }
  #rules { display:none; }
  main.rules-mode { grid-template-columns: 1fr; }
  main.rules-mode aside, main.rules-mode #detail, main.rules-mode #dps { display:none; }
  main.rules-mode #rules { display:block; overflow:auto; }
  .rules h2 { margin:22px 0 8px; font-size:20px; }
  .rules h2:first-child { margin-top:0; }
  .rules p, .rules li { max-width:920px; }
  .rules p { margin:6px 0 8px; }
  .rules table { max-width:920px; margin:8px 0 14px; }
  .rules td { vertical-align:top; }
  @media (max-width: 860px) { html { overflow:auto; } body { height:auto; overflow:auto; display:block; } main { display:block; } aside, section { overflow:visible; } }
</style>
</head>
<body>
<header>
  <div>
    <h1>龙窟破坏者WIKI</h1>
    <p>从本地客户端配置和贴图解出。物品、怪物、地点和环境名称使用游戏内简体中文。掉落表 ${db.dropTables.length} 张，关联来源 ${db.sources.length} 个，地图 ${(db.maps || []).length} 张，角色 ${(db.characters || []).length} 个，技能 ${(db.skills || []).length} 个，装备 ${(db.gear || []).length} 件，任务 ${(db.quests || []).length} 个。</p>
    <p class="meta">作者 elmagnifico · 版本 v0.5 · 对应游戏版本 2.0.2244.110866（Steam build 25959928） <a class="gh" href="https://github.com/elmagnificogi/VaultbreakersWiki" target="_blank" rel="noopener noreferrer" title="在 GitHub 查看源码"><svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"></path></svg>开源</a></p>
  </div>
  <div class="toolbar">
    <div class="search">
      <input id="q" placeholder="搜索怪物、箱子、物品、任务、角色、技能、装备" autocomplete="off" />
      <div id="history" class="search-history" hidden></div>
    </div>
    <select id="cat"></select>
    <div class="tabs">
      <button id="tab-sources" class="on">怪物与搜刮点</button>
      <button id="tab-characters">角色</button>
      <button id="tab-skills">技能</button>
      <button id="tab-gear">装备</button>
      <button id="tab-items">物品</button>
      <button id="tab-quests">任务</button>
      <button id="tab-maps">地图</button>
      <button id="tab-rules">难度与多人</button>
      <button id="tab-dps">速算</button>
    </div>
  </div>
</header>
<main>
  <aside id="list"></aside>
  <section id="detail"></section>
  <section id="dps" class="dps">
    <h2>基础攻击速算</h2>
    <p class="muted">填面板上的数字，最多对比 3 套。暴击伤害 215 表示暴击打出 2.15 倍。攻击速度 1 是正常出手，2 表示基础攻击次数翻倍，留空按 1 算。对小兵伤害、对Boss伤害填百分比，18 表示打这类目标时最终伤害再乘 1.18，两项分开算，不叠在同一次攻击上，留空按 0。相对每秒按同一把武器的基础攻速比较，只覆盖基础攻击。</p>
    <div class="dps-sets">
      <div class="dps-set">
        <div class="dps-head"><b>第 1 套</b><span class="dps-apply"><select class="dps-from"><option value="1">第 2 套</option><option value="2">第 3 套</option></select><button type="button" class="dps-copy" data-to="0">套用</button></span></div>
        <span>攻击伤害</span><input id="dps-0-atk" type="number" value="88" step="any" />
        <span>暴击率</span><input id="dps-0-crit" type="number" value="28" step="any" />
        <span>暴击伤害</span><input id="dps-0-critd" type="number" value="215" step="any" />
        <span>攻击速度</span><input id="dps-0-spd" type="number" value="1" step="any" />
        <span>对小兵伤害</span><input id="dps-0-minion" type="number" step="any" />
        <span>对Boss伤害</span><input id="dps-0-boss" type="number" step="any" />
      </div>
      <div class="dps-set">
        <div class="dps-head"><b>第 2 套</b><span class="dps-apply"><select class="dps-from"><option value="0">第 1 套</option><option value="2">第 3 套</option></select><button type="button" class="dps-copy" data-to="1">套用</button></span></div>
        <span>攻击伤害</span><input id="dps-1-atk" type="number" value="81" step="any" />
        <span>暴击率</span><input id="dps-1-crit" type="number" value="33" step="any" />
        <span>暴击伤害</span><input id="dps-1-critd" type="number" value="215" step="any" />
        <span>攻击速度</span><input id="dps-1-spd" type="number" value="1" step="any" />
        <span>对小兵伤害</span><input id="dps-1-minion" type="number" step="any" />
        <span>对Boss伤害</span><input id="dps-1-boss" type="number" step="any" />
      </div>
      <div class="dps-set">
        <div class="dps-head"><b>第 3 套</b><span class="dps-apply"><select class="dps-from"><option value="0">第 1 套</option><option value="1">第 2 套</option></select><button type="button" class="dps-copy" data-to="2">套用</button></span></div>
        <span>攻击伤害</span><input id="dps-2-atk" type="number" step="any" />
        <span>暴击率</span><input id="dps-2-crit" type="number" step="any" />
        <span>暴击伤害</span><input id="dps-2-critd" type="number" step="any" />
        <span>攻击速度</span><input id="dps-2-spd" type="number" placeholder="1" step="any" />
        <span>对小兵伤害</span><input id="dps-2-minion" type="number" step="any" />
        <span>对Boss伤害</span><input id="dps-2-boss" type="number" step="any" />
      </div>
    </div>
    <table id="dps-out"></table>
    <p id="dps-note" class="muted"></p>
    <h2 style="margin-top:28px">装备穷举</h2>
    <p class="muted">部位是固定的。勾选你有的候选，页面会把勾中的组合算一遍。常驻的额外攻击、额外攻速一直算在里面。限时增益按覆盖时间加权，覆盖时间是持续秒数除以冷却秒数。对小兵伤害、对Boss伤害填百分比，先把同一项加总，再分别乘到最终伤害上，不叠在同一次攻击里。下面是妮弭拉的例子：基础攻击 70、暴击率 5%、暴击伤害 175%、攻速 1，特性额外攻击 30、额外攻速 0.33。默认增益是额外攻击 50、额外攻速 0.5，持续 4 秒、冷却 9 秒，可以改成你测到的数字。暴击伤害 25 表示再加 25%。攻速 0.25 表示再快 25%。只覆盖基础攻击。</p>
    <div class="opt-base">
      <span>攻击</span><input id="opt-atk" type="number" value="70" step="any" />
      <span>暴击率</span><input id="opt-crit" type="number" value="5" step="any" />
      <span>暴击伤害</span><input id="opt-critd" type="number" value="175" step="any" />
      <span>攻速</span><input id="opt-spd" type="number" value="1" step="any" />
      <span>对小兵伤害</span><input id="opt-minion" type="number" step="any" />
      <span>对Boss伤害</span><input id="opt-boss" type="number" step="any" />
      <span>额外攻击</span><input id="opt-extra-atk" type="number" value="30" step="any" />
      <span>额外攻速</span><input id="opt-extra-spd" type="number" value="0.33" step="any" />
    </div>
    <div id="opt-buffs"></div>
    <div class="opt-actions">
      <button type="button" class="opt-btn" id="opt-add-buff">添加增益</button>
    </div>
    <div id="opt-slots"></div>
    <p id="opt-note" class="muted"></p>
    <table id="opt-out"></table>
  </section>
  <section id="rules" class="rules">
    <h2>难度与多人</h2>
    <p>进图之后看两件事：你选的是冒险、核心还是破阵者，以及你是单排、双排还是三排。这两件事分开算。</p>
    <p>冒险、核心、破阵者不改变怪物原来的血量和伤害，也不会让它们更爱追人。人数也不会让所有怪一起变强。双排和三排里，只有一部分怪会变成精英或噩梦。</p>

    <h2>冒险、核心、破阵者</h2>
    <p>在庇护所切换。变的是你的收益、从哪出生，以及箱子里能开出什么。</p>
    <table>
      <thead>
        <tr><th></th><th>冒险</th><th>核心</th><th>破阵者</th></tr>
      </thead>
      <tbody>
        <tr>
          <td>怪物</td>
          <td>血量、伤害都不变</td>
          <td>血量、伤害都不变</td>
          <td>血量、伤害都不变</td>
        </tr>
        <tr>
          <td>你自己</td>
          <td>护甲和魔法抗性 +100。出发点有安全撤离。从固定地点出生。</td>
          <td>经验是原来的 2 倍。从固定地点出生。</td>
          <td>经验是原来的 3 倍。随机出生，任务里会遇到其他玩家。</td>
        </tr>
        <tr>
          <td>箱子里的品质</td>
          <td>不会开出卓越和传奇。稀有可以。</td>
          <td>同样不会开出卓越和传奇。</td>
          <td>可以开出卓越和传奇。</td>
        </tr>
        <tr>
          <td>箱子里的金币</td>
          <td>数量减半</td>
          <td>数量不变</td>
          <td>数量变为 3 倍</td>
        </tr>
        <tr>
          <td>箱子里的基础材料</td>
          <td>数量不变</td>
          <td>数量不变</td>
          <td>数量变为 2 倍</td>
        </tr>
        <tr>
          <td>死亡</td>
          <td colspan="2">有 25% 的几率损坏装备。身上装备评分低于 8，至少坏 1 件；达到 8，至少坏 2 件。</td>
          <td>身上穿的装备全部掉落，并且永久丢失。</td>
        </tr>
      </tbody>
    </table>
    <p>物品品质按游戏内名称：常见、罕见、稀有、卓越、传奇。稀有还能开到；冒险和核心开不出卓越和传奇，破阵者可以。任务和难度提示里把卓越写成史诗，核心的提示写着全队都选核心就能找到史诗与传奇，这版实际开箱仍然开不出卓越和传奇。</p>
    <p>如果一件东西本来就定好了是卓越或传奇，冒险和核心也还能拿到。受限制的是箱子临时决定品质的那些物品。怪物掉出来再开的箱子也一样。</p>
    <p>举例：一个箱子本来会给你 40 个金币，旁边还有机会掉一把武器。冒险你拿到 20 个金币，核心拿到 40 个，破阵者拿到 120 个。那把武器出不出，三种难度一样。破阵者如果开到基础材料，个数是原来的 2 倍，也不是更容易开到。</p>
    <p>庇护所里另有一项「敌人难度」。它按你看到的百分比，同时提高敌人的生命和伤害，奖励还是按原来的阶层算。它和冒险、核心、破阵者不是一回事。</p>

    <h2>双排和三排</h2>
    <p>有的怪自带一个标记：低、中、高，或者 Boss。没有标记的怪一直是普通怪。这个标记做这只怪的时候就定了，不是它的等级，也跟你选冒险还是核心无关。</p>
    <p>单排里，这些怪都还是普通的。教学关里也不会变。双排和三排里，每只带标记的怪各自有机会变成精英或噩梦。下面是一只怪自己的概率，不是地图上会多刷几只。</p>
    <table>
      <thead>
        <tr><th>这只怪的标记</th><th>单排</th><th>双排</th><th>三排</th></tr>
      </thead>
      <tbody>
        <tr><td>低</td><td>普通</td><td>精英 85%，普通 15%</td><td>噩梦 50%，精英 45%，普通 5%</td></tr>
        <tr><td>中</td><td>普通</td><td>精英 50%，噩梦 20%，普通 30%</td><td>噩梦 70%，精英 30%</td></tr>
        <tr><td>高</td><td>普通</td><td>噩梦 70%，精英 30%</td><td>全部是噩梦</td></tr>
        <tr><td>Boss</td><td>普通</td><td>全部是精英</td><td>全部是噩梦</td></tr>
      </tbody>
    </table>
    <p>变成之后，用的是它自己原来的数值：</p>
    <table>
      <thead>
        <tr><th></th><th>血量</th><th>伤害</th><th>跑速</th><th>其他</th></tr>
      </thead>
      <tbody>
        <tr><td>精英</td><td>2 倍</td><td>1.2 倍</td><td>1.2 倍</td><td></td></tr>
        <tr><td>噩梦</td><td>3 倍</td><td>1.4 倍</td><td>1.4 倍</td><td>连续晕它会越来越难</td></tr>
      </tbody>
    </table>
    <p>同一只怪只会变成其中一种，不会先变精英再叠成噩梦。没变成的普通怪，单排、双排、三排的血量一样。带 Boss 标记的怪没有另一套加成，双排就是上表的精英，三排就是上表的噩梦。</p>
    <p>举例：假如一只狼的标记是「低」。单排它就是普通狼。双排大约 85% 变成精英，血量和伤害按上表变高，剩下 15% 还是普通狼。三排大约一半变成噩梦，45% 变成精英，只有 5% 还是普通狼。头狼是另一只怪，不是这只狼变出来的。</p>
    <p>所以双排时，你会觉得一部分敌人比单排更强，也可能遇到单排或双排的玩家。三排时，更多敌人比单排、双排更强，也可能遇到单排、双排或三排的玩家。</p>
    <p>人数不会让整张地图的怪物按一个倍数变多。金库是单人、双人、三人各一套布置。撤离时，附近如果还有别的玩家，会多刷一些，那只影响这次撤离，不是全图的怪都变多。</p>
  </section>
</main>
<script id="db" type="application/json">${JSON.stringify(db).replace(/</g, "\\u003c")}</script>
<script>
const db = JSON.parse(document.getElementById("db").textContent);
(function () {
  function num(id) {
    const el = document.getElementById(id);
    if (!el || String(el.value).trim() === "") return null;
    const n = Number(el.value);
    return Number.isFinite(n) ? n : null;
  }
  function build(i) {
    const atk = num("dps-" + i + "-atk");
    if (atk == null) return null;
    const crit = num("dps-" + i + "-crit");
    const critd = num("dps-" + i + "-critd");
    const spd = num("dps-" + i + "-spd");
    const chance = Math.min(100, Math.max(0, crit == null ? 0 : crit)) / 100;
    const mult = (critd == null ? 100 : critd) / 100;
    const rate = Math.max(0, spd == null ? 1 : spd);
    const minionPct = num("dps-" + i + "-minion");
    const bossPct = num("dps-" + i + "-boss");
    const minion = minionPct == null ? 0 : minionPct;
    const boss = bossPct == null ? 0 : bossPct;
    const hit = atk * (1 - chance + chance * mult);
    const dps = hit * rate;
    return { hit: hit, critHit: atk * mult, dps: dps, minionDps: dps * (1 + minion / 100), bossDps: dps * (1 + boss / 100), minion: minion, boss: boss };
  }
  function fmt(n) {
    return (Math.round(n * 10) / 10).toString();
  }
  function renderDps() {
    const rows = [0, 1, 2].map(build);
    let best = null;
    rows.forEach(row => { if (row && (best == null || row.dps > best)) best = row.dps; });
    const first = rows[0];
    const body = rows.map((row, i) => {
      if (!row) return "";
      const pct = first && first.dps ? Math.round(row.dps / first.dps * 1000) / 10 : "";
      const mark = best != null && row.dps === best ? " class='best'" : "";
      return "<tr" + mark + "><td>第 " + (i + 1) + " 套</td><td>" + fmt(row.hit) + "</td><td>" + fmt(row.critHit) + "</td><td>" + fmt(row.dps) + "</td><td>" + fmt(row.minionDps) + "</td><td>" + fmt(row.bossDps) + "</td><td>" + (pct === "" ? "" : pct + "%") + "</td></tr>";
    }).join("");
    document.getElementById("dps-out").innerHTML = "<thead><tr><th></th><th>单次期望</th><th>暴击一下</th><th>相对每秒</th><th>对小兵每秒</th><th>对Boss每秒</th><th>对比第 1 套</th></tr></thead><tbody>" + body + "</tbody>";
    const filled = rows.map((row, i) => row ? i : -1).filter(i => i >= 0);
    const winners = filled.filter(i => rows[i].dps === best);
    const note = document.getElementById("dps-note");
    if (!winners.length) note.textContent = "";
    else if (winners.length > 1) note.textContent = winners.map(i => "第 " + (i + 1) + " 套").join("、") + " 的相对每秒伤害相同。";
    else {
      const others = filled.filter(i => i !== winners[0] && rows[i].dps > 0).map(i => "第 " + (i + 1) + " 套高 " + fmt((rows[winners[0]].dps / rows[i].dps - 1) * 100) + "%");
      note.textContent = "第 " + (winners[0] + 1) + " 套的相对每秒伤害最高" + (others.length ? "，比" + others.join("，比") : "") + "。";
    }
    const split = rows.some(row => row && (row.minion || row.boss));
    if (split && note.textContent) {
      function topText(label, key) {
        let top = null;
        filled.forEach(function (i) { if (top == null || rows[i][key] > rows[top][key]) top = i; });
        const ties = filled.filter(function (i) { return rows[i][key] === rows[top][key]; });
        if (ties.length > 1) return ties.map(function (i) { return "第 " + (i + 1) + " 套"; }).join("、") + " 的" + label + "同为 " + fmt(rows[top][key]) + "。";
        return "第 " + (top + 1) + " 套的" + label + "最高，是 " + fmt(rows[top][key]) + "。";
      }
      note.textContent += topText("对小兵每秒", "minionDps") + topText("对Boss每秒", "bossDps");
    }
  }
  function optNum(el) {
    if (!el || String(el.value).trim() === "") return 0;
    const n = Number(el.value);
    return Number.isFinite(n) ? n : 0;
  }
  function optVal(n) {
    return n ? String(n) : "";
  }
  function optItemHtml(item) {
    const row = item || { name: "", atk: 0, crit: 0, cd: 0, as: 0, minion: 0, boss: 0 };
    return '<div class="opt-item"><input class="opt-use" type="checkbox" checked><input class="opt-item-name" value="' + String(row.name || "").replace(/"/g, "") + '">' +
      '<input class="opt-item-atk" type="number" step="any" placeholder="攻击" value="' + optVal(row.atk) + '">' +
      '<input class="opt-item-crit" type="number" step="any" placeholder="暴击率" value="' + optVal(row.crit) + '">' +
      '<input class="opt-item-cd" type="number" step="any" placeholder="爆伤" value="' + optVal(row.cd) + '">' +
      '<input class="opt-item-as" type="number" step="any" placeholder="攻速" value="' + optVal(row.as) + '">' +
      '<input class="opt-item-minion" type="number" step="any" placeholder="小兵%" value="' + optVal(row.minion) + '">' +
      '<input class="opt-item-boss" type="number" step="any" placeholder="Boss%" value="' + optVal(row.boss) + '">' +
      '<button type="button" class="opt-btn opt-del-item">删除</button></div>';
  }
  function optBuffHtml(buff) {
    const row = buff || { name: "", atk: 0, as: 0, dur: 0, cd: 0 };
    return '<div class="opt-buff"><input class="opt-buff-name" placeholder="增益名称" value="' + String(row.name || "").replace(/"/g, "") + '"><span>额外攻击</span><input class="opt-buff-atk" type="number" step="any" value="' + optVal(row.atk) + '"><span>额外攻速</span><input class="opt-buff-as" type="number" step="any" value="' + optVal(row.as) + '"><span>持续秒</span><input class="opt-buff-dur" type="number" step="any" value="' + optVal(row.dur) + '"><span>冷却秒</span><input class="opt-buff-cd" type="number" step="any" value="' + optVal(row.cd) + '"><button type="button" class="opt-btn opt-del-buff">删除</button></div>';
  }
  function addOptBuff(buff) {
    const box = document.createElement("div");
    box.innerHTML = optBuffHtml(buff);
    document.getElementById("opt-buffs").appendChild(box.firstChild);
  }
  function addOptSlot(slot) {
    const box = document.createElement("div");
    box.className = "opt-slot";
    const items = (slot.items || []).map(optItemHtml).join("");
    box.innerHTML = '<div class="opt-slot-head"><b class="opt-slot-name">' + slot.slot + '</b><button type="button" class="opt-btn opt-add-item">添加候选</button></div>' + items;
    document.getElementById("opt-slots").appendChild(box);
  }
  function optItemLabel(item, index) {
    if (item.name) return item.name;
    const bits = [];
    if (item.atk) bits.push(item.atk + "攻击");
    if (item.crit) bits.push(item.crit + "%暴击");
    if (item.cd) bits.push(item.cd + "%爆伤");
    if (item.as) bits.push(Math.round(item.as * 1000) / 10 + "%攻速");
    if (item.minion) bits.push(item.minion + "%小兵");
    if (item.boss) bits.push(item.boss + "%Boss");
    return bits.join(" ") || ("候选" + (index + 1));
  }
  function optFmt(n) {
    return (Math.round(n * 100) / 100).toString();
  }
  function renderOpt() {
    const baseAtk = optNum(document.getElementById("opt-atk"));
    const baseCrit = optNum(document.getElementById("opt-crit"));
    const baseCd = optNum(document.getElementById("opt-critd"));
    const baseSpd = optNum(document.getElementById("opt-spd"));
    const baseMinion = optNum(document.getElementById("opt-minion"));
    const baseBoss = optNum(document.getElementById("opt-boss"));
    const extraAtk = optNum(document.getElementById("opt-extra-atk"));
    const extraSpd = optNum(document.getElementById("opt-extra-spd"));
    const buffs = [];
    let buffIgnored = 0;
    document.querySelectorAll("#opt-buffs .opt-buff").forEach(function (row) {
      const buff = {
        name: (row.querySelector(".opt-buff-name").value || "增益").trim() || "增益",
        atk: optNum(row.querySelector(".opt-buff-atk")),
        as: optNum(row.querySelector(".opt-buff-as")),
        dur: optNum(row.querySelector(".opt-buff-dur")),
        cd: optNum(row.querySelector(".opt-buff-cd"))
      };
      if (!buff.atk && !buff.as) return;
      if (!(buff.dur > 0 && buff.cd > 0)) { buffIgnored += 1; return; }
      buff.u = Math.min(1, buff.dur / buff.cd);
      buffs.push(buff);
    });
    const slots = [];
    document.querySelectorAll("#opt-slots .opt-slot").forEach(function (slotEl) {
      const slotName = (slotEl.querySelector(".opt-slot-name").textContent || "部位").trim();
      const items = [];
      slotEl.querySelectorAll(".opt-item").forEach(function (row, index) {
        const use = row.querySelector(".opt-use");
        if (use && !use.checked) return;
        const item = {
          name: (row.querySelector(".opt-item-name").value || "").trim(),
          atk: optNum(row.querySelector(".opt-item-atk")),
          crit: optNum(row.querySelector(".opt-item-crit")),
          cd: optNum(row.querySelector(".opt-item-cd")),
          as: optNum(row.querySelector(".opt-item-as")),
          minion: optNum(row.querySelector(".opt-item-minion")),
          boss: optNum(row.querySelector(".opt-item-boss"))
        };
        if (!item.name && !item.atk && !item.crit && !item.cd && !item.as && !item.minion && !item.boss) return;
        item.label = slotName + " " + optItemLabel(item, index);
        items.push(item);
      });
      if (items.length) slots.push(items);
    });
    let combos = [{ atk: 0, crit: 0, cd: 0, as: 0, minion: 0, boss: 0, picks: [] }];
    let capped = false;
    slots.forEach(function (items) {
      if (capped) return;
      const next = [];
      combos.forEach(function (combo) {
        items.forEach(function (item) {
          if (next.length > 200000) return;
          next.push({
            atk: combo.atk + item.atk,
            crit: combo.crit + item.crit,
            cd: combo.cd + item.cd,
            as: combo.as + item.as,
            minion: combo.minion + item.minion,
            boss: combo.boss + item.boss,
            picks: combo.picks.concat(item.label)
          });
        });
      });
      if (next.length > 200000) capped = true;
      else combos = next;
    });
    const ranked = combos.map(function (combo) {
      const crit = baseCrit + combo.crit;
      const cd = baseCd + combo.cd;
      const minionMult = 1 + (baseMinion + combo.minion) / 100;
      const bossMult = 1 + (baseBoss + combo.boss) / 100;
      const chance = Math.min(100, Math.max(0, crit)) / 100;
      const mult = cd / 100;
      const states = 1 << buffs.length;
      let weighted = 0;
      let calm = 0;
      let hot = 0;
      for (let mask = 0; mask < states; mask++) {
        let atk = baseAtk + extraAtk + combo.atk;
        let as = baseSpd + extraSpd + combo.as;
        let p = 1;
        for (let i = 0; i < buffs.length; i++) {
          if (mask & (1 << i)) { atk += buffs[i].atk; as += buffs[i].as; p *= buffs[i].u; }
          else p *= 1 - buffs[i].u;
        }
        as = Math.max(0, as);
        const dps = atk * (1 - chance + chance * mult) * as;
        weighted += p * dps;
        if (mask === 0) calm = dps;
        if (mask === states - 1) hot = dps;
      }
      return { crit: crit, cd: cd, calm: calm, hot: hot, dps: weighted, minionDps: weighted * minionMult, bossDps: weighted * bossMult, calmMinion: calm * minionMult, hotMinion: hot * minionMult, calmBoss: calm * bossMult, hotBoss: hot * bossMult, picks: combo.picks };
    }).sort(function (a, b) { return b.dps - a.dps; });
    const best = ranked[0];
    const shown = ranked.slice(0, 8);
    const note = document.getElementById("opt-note");
    if (!best) note.textContent = "";
    else {
      const cover = buffs.map(function (buff) { return buff.name + " 覆盖 " + optFmt(buff.u * 100) + "%（持续 " + optFmt(buff.dur) + " 秒，冷却 " + optFmt(buff.cd) + " 秒）"; }).join("；");
      let extra = "";
      if (ranked.some(function (row) { return row.minionDps !== row.dps || row.bossDps !== row.dps; })) {
        let bestMinion = ranked[0];
        let bestBoss = ranked[0];
        ranked.forEach(function (row) {
          if (row.minionDps > bestMinion.minionDps) bestMinion = row;
          if (row.bossDps > bestBoss.bossDps) bestBoss = row;
        });
        function pickText(row) { return row.picks.join("、") || "只算基础"; }
        extra = "对小兵加权最高 " + optFmt(bestMinion.minionDps) + "（平时 " + optFmt(bestMinion.calmMinion) + "，全开 " + optFmt(bestMinion.hotMinion) + "，" + pickText(bestMinion) + "）。对Boss加权最高 " + optFmt(bestBoss.bossDps) + "（平时 " + optFmt(bestBoss.calmBoss) + "，全开 " + optFmt(bestBoss.hotBoss) + "，" + pickText(bestBoss) + "）。";
      }
      note.textContent = "算了 " + ranked.length + " 种搭配。" + (capped ? "再往后组合超过 20 万，没有继续算。" : "") + (cover ? cover + "。" : "") + (buffIgnored ? "有增益没填持续和冷却，没有计入。" : "") + "加权每秒伤害 " + optFmt(best.dps) + "。平时 " + optFmt(best.calm) + "，增益全开 " + optFmt(best.hot) + "。暴击率 " + optFmt(best.crit) + "%，暴击伤害 " + optFmt(best.cd) + "%。" + extra;
    }
    document.getElementById("opt-out").innerHTML = "<thead><tr><th></th><th>搭配</th><th>暴击率</th><th>暴击伤害</th><th>平时每秒</th><th>增益全开</th><th>加权每秒</th><th>对小兵每秒</th><th>对Boss每秒</th><th>对比最高</th></tr></thead><tbody>" + shown.map(function (row, i) {
      const pct = best && best.dps ? Math.round(row.dps / best.dps * 1000) / 10 : "";
      return "<tr" + (i === 0 ? " class='best'" : "") + "><td>第 " + (i + 1) + " 套</td><td>" + (row.picks.map(function (text) { return String(text).replace(/[&<>]/g, function (ch) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]; }); }).join("、") || "只算基础") + "</td><td>" + optFmt(row.crit) + "%</td><td>" + optFmt(row.cd) + "%</td><td>" + optFmt(row.calm) + "</td><td>" + optFmt(row.hot) + "</td><td>" + optFmt(row.dps) + "</td><td>" + optFmt(row.minionDps) + "</td><td>" + optFmt(row.bossDps) + "</td><td>" + pct + "%</td></tr>";
    }).join("") + "</tbody>";
  }
  document.getElementById("dps").addEventListener("input", function () { renderDps(); renderOpt(); });
  document.getElementById("dps").addEventListener("change", renderOpt);
  document.getElementById("dps").addEventListener("click", function (ev) {
    const addItem = ev.target.closest(".opt-add-item");
    if (addItem) { addItem.closest(".opt-slot").insertAdjacentHTML("beforeend", optItemHtml()); renderOpt(); return; }
    const delItem = ev.target.closest(".opt-del-item");
    if (delItem) { delItem.closest(".opt-item").remove(); renderOpt(); return; }
    if (ev.target.id === "opt-add-buff") { addOptBuff(); renderOpt(); return; }
    const delBuff = ev.target.closest(".opt-del-buff");
    if (delBuff) { delBuff.closest(".opt-buff").remove(); renderOpt(); }
  });
  [
    { slot: "饰品", items: [{ name: "6攻击 5%爆伤", atk: 6, cd: 5 }] },
    { slot: "护符", items: [{ name: "10%爆伤", cd: 10 }] },
    { slot: "武器", items: [{ name: "6攻击", atk: 6 }, { name: "6%暴击", crit: 6 }] },
    { slot: "护胸", items: [{ name: "25%攻速", as: 0.25 }, { name: "10%攻速 15攻击", atk: 15, as: 0.1 }, { name: "10%攻速 8%暴击", crit: 8, as: 0.1 }, { name: "17攻击", atk: 17 }] },
    { slot: "腿甲", items: [{ name: "6攻击 5%爆伤", atk: 6, cd: 5 }, { name: "25%爆伤", cd: 25 }, { name: "8%暴击", crit: 8 }, { name: "6攻击", atk: 6 }] },
    { slot: "头盔", items: [{ name: "7攻击", atk: 7 }, { name: "8%暴击", crit: 8 }, { name: "9攻击", atk: 9 }] },
    { slot: "项链", items: [{ name: "13%攻速 7%暴击", crit: 7, as: 0.13 }] },
    { slot: "手指", items: [{ name: "6攻击 2%攻速", atk: 6, as: 0.02 }, { name: "8%暴击", crit: 8 }, { name: "7攻击", atk: 7 }] },
    { slot: "双手", items: [{ name: "11%暴击 7%攻速", crit: 11, as: 0.07 }] }
  ].forEach(addOptSlot);
  addOptBuff({ name: "技能增伤", atk: 50, as: 0.5, dur: 4, cd: 9 });
  document.getElementById("dps").addEventListener("click", function (ev) {
    const btn = ev.target.closest(".dps-copy");
    if (!btn) return;
    const to = btn.getAttribute("data-to");
    const pick = btn.parentNode.querySelector(".dps-from");
    const from = pick ? pick.value : "0";
    ["atk", "crit", "critd", "spd", "minion", "boss"].forEach(function (key) {
      const src = document.getElementById("dps-" + from + "-" + key);
      const dst = document.getElementById("dps-" + to + "-" + key);
      if (src && dst) dst.value = src.value;
    });
    renderDps();
  });
  renderDps();
  renderOpt();
})();
const listEl = document.getElementById("list");
const detailEl = document.getElementById("detail");
const qEl = document.getElementById("q");
const catEl = document.getElementById("cat");
const historyEl = document.getElementById("history");
let mode = "tables";
let current = null;
let historyLock = false;
let appliedUrl = "";
let mapObservers = [];
const lastByMode = { tables: null, sources: null, items: null, maps: null, characters: null, skills: null, gear: null };
const listScroll = {};
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
      rows.push({ kind: "item", id: entry.item, title: entry.itemName || "物品", icon: entry.itemIcon, chance: portion, amount: amount(entry), rarity: rarityText(entry), rarities: entry.rarities || [], flags: entry.flagText || [], recipe: entry.outcome === 2, recipeId: entry.recipe });
    }
  }
  return rows;
}
function mergeGearDrops(drops) {
  const gearIds = {};
  for (const gear of db.gear || []) gearIds[String(gear.id)] = true;
  const out = [];
  const groups = new Map();
  for (const drop of drops) {
    if (drop.kind !== "item" || !gearIds[String(drop.id)]) {
      out.push(drop);
      continue;
    }
    const key = String(drop.id) + "|" + drop.amount;
    let group = groups.get(key);
    if (!group) {
      group = { kind: "item", id: drop.id, title: drop.title, icon: drop.icon, chance: 0, amount: drop.amount, rarity: drop.rarity, flags: drop.flags, recipe: false, count: 0, parts: [] };
      groups.set(key, group);
      out.push(group);
    }
    group.count++;
    group.chance += drop.chance;
    group.parts.push({
      chance: drop.chance,
      rarities: drop.rarities || [],
      flags: drop.flags || [],
      recipe: !!(drop.recipe || (drop.flags || []).indexOf("配方书") >= 0),
    });
  }
  for (const group of groups.values()) {
    if (group.count < 2) continue;
    const gearParts = [];
    const bookParts = [];
    for (const part of group.parts) (part.recipe ? bookParts : gearParts).push(part);
    const gearText = rarityChanceText(gearParts);
    const bookText = rarityChanceText(bookParts);
    const lines = [];
    if (gearText) lines.push(gearText);
    if (bookText) lines.push("配方书 " + bookText);
    group.oddsText = lines.join(" · ");
    group.rarity = "";
    const base = gearParts.length ? gearParts : bookParts;
    const shared = [];
    for (const flag of (base[0] && base[0].flags) || []) {
      if (flag === "配方书") continue;
      if (base.every(part => part.flags.indexOf(flag) >= 0)) shared.push(flag);
    }
    group.flags = shared;
  }
  return out;
}
function rarityChanceText(parts) {
  const shares = [];
  let plain = 0;
  for (const part of parts) {
    const weights = part.rarities || [];
    const sum = weights.reduce((total, value) => total + value, 0);
    if (!sum) { plain += part.chance; continue; }
    for (let i = 0; i < weights.length; i++) {
      if (!weights[i]) continue;
      shares[i] = (shares[i] || 0) + part.chance * weights[i] / sum;
    }
  }
  const bits = [];
  for (let i = 0; i < shares.length; i++) {
    if (!shares[i]) continue;
    bits.push((db.rarity[i] || ("稀有度" + i)) + " " + formatPct(shares[i]));
  }
  if (plain) bits.push(formatPct(plain));
  return bits.join(" · ");
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
  const values = kind === "tables" ? db.dropTables.map(t => t.category) : kind === "sources" ? db.sources.map(s => s.category) : kind === "characters" ? (db.characters || []).map(c => c.origin) : kind === "skills" ? (db.skills || []).map(s => s.kind) : kind === "gear" ? (db.gear || []).map(g => g.slot) : kind === "quests" ? (db.quests || []).flatMap(q => q.areas || []) : [];
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
function itemTitle(id) {
  if (!id) return "";
  const item = (db.items || []).find(it => String(it.id) === String(id));
  return item ? item.title : "";
}
function groundSpots(id) {
  const spots = [];
  for (const map of db.maps || []) {
    for (const spot of map.pickups || []) {
      if (String(spot.item) !== String(id)) continue;
      const title = itemTitle(spot.item);
      if (!/[\u4e00-\u9fff]/.test(title)) continue;
      spots.push({ map: map.title, mapId: map.id, amount: spot.amount, left: spot.left, top: spot.top });
    }
  }
  return spots;
}
function filtered() {
  const q = qEl.value.trim().toLowerCase();
  const cat = catEl.value;
  let rows;
  if (mode === "tables") rows = db.dropTables.filter(t => {
    if (!t.entries.length && !q) return false;
    return (cat==="全部"||t.category===cat) && (!q || (named(t.title, t.enumName)+" "+t.title+" "+(t.english||"")+" "+t.enumName+" "+(dropWords[t.enumName]||"")).toLowerCase().includes(q));
  });
  else if (mode === "sources") rows = db.sources.filter(s => (cat==="全部"||s.category===cat) && (!q || (sourceLabel(s)+" "+s.title+" "+(s.english||"")+" "+(s.place||"")+" "+(s.look||"")+" "+s.asset+" "+combatWords(s)+" "+s.refs.map(r=>named(r.title, r.table)+" "+(dropWords[r.table]||"")).join(" ")).toLowerCase().includes(q)));
  else if (mode === "maps") rows = (db.maps || []).filter(m => !q || (m.title + " " + m.pins.map(p => p.title).join(" ") + " " + (m.pickups||[]).map(p => itemTitle(p.item)).join(" ") + " " + (m.regions||[]).map(r => r.title + " " + r.english).join(" ") + " " + (m.entrances||[]).map(e => e.title + " " + e.detail).join(" ") + " " + (m.links||[]).map(l => l.title).join(" ") + " " + (m.npcs||[]).map(n => n.title).join(" ") + " " + (m.bosses||[]).map(b => b.title).join(" ")).toLowerCase().includes(q));
  else if (mode === "characters") rows = (db.characters || []).filter(c => (cat==="全部"||c.origin===cat) && (!q || (c.title+" "+c.role+" "+c.origin+" "+c.description+" "+characterSummary(c)+" "+(c.stats||[]).map(s => s.label+" "+s.value).join(" ")+" "+(c.perks||[]).map(p => p.title).join(" ")).toLowerCase().includes(q)));
  else if (mode === "skills") rows = (db.skills || []).filter(s => (cat==="全部"||s.kind===cat) && (!q || (s.title+" "+s.kind+" "+s.top+" "+s.bottom+" "+(s.owners||[]).map(id => { const character = (db.characters || []).find(c => c.id === id); return character ? character.title : ""; }).join(" ")).toLowerCase().includes(q)));
  else if (mode === "gear") rows = (db.gear || []).filter(g => (cat==="全部"||g.slot===cat) && (!q || (g.title+" "+g.slot+" "+g.description+" "+(g.base||[]).join(" ")+" "+(g.forced||[]).join(" ")+" "+(g.pool||[]).join(" ")).toLowerCase().includes(q)));
  else if (mode === "quests") rows = (db.quests || []).filter(quest => (cat==="全部"||(quest.areas||[]).includes(cat)) && (!q || (quest.title+" "+(quest.description||"")+" "+(quest.handIn||"")+" "+(quest.giver||"")+" "+(quest.turnIn||"")+" "+(quest.areas||[]).join(" ")+" "+(quest.steps||[]).map(step => (step.kind||"")+" "+(step.text||"")+" "+itemTitle(step.item)).join(" ")+" "+(quest.rewards||[]).map(reward => itemTitle(reward.item)).join(" ")).toLowerCase().includes(q)));
  else rows = db.items.filter(it => (!q || (it.title+" "+(it.english||"")+" "+it.name+" "+(it.places||[]).join(" ")+" "+(it.needs||[]).map(n => n.quest+" "+n.kind).join(" ")+" "+(it.salvage||[]).map(s => (s.title||s.pool||"")+" "+(s.rarity||"")).join(" ")).toLowerCase().includes(q)));
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
    const sub = mode==="quests" ? [row.giver, (row.areas||[]).join("、"), (row.steps||[]).length ? (row.steps.length+" 个目标") : ""].filter(Boolean).join(" · ") : mode==="tables" ? (row.entries.length ? row.entries.length+" 项 · "+row.category : "没有条目") : mode==="sources" ? [row.place || row.refs.map(r=>shown(r.title)).join("、"), combatSummary(row), spawnSummary(row)].filter(Boolean).join(" · ") : mode==="maps" ? ((row.regions||[]).length+" 个区域 · "+(row.entrances||[]).length+" 个入口 · "+row.pins.length+" 个固定搜刮点 · "+((row.pickups||[]).length)+" 个地上物品 · "+((row.npcs||[]).length)+" 个 NPC · "+((row.bosses||[]).length)+" 个固定怪") : mode==="characters" ? [characterSummary(row), row.role || row.origin || ""].filter(Boolean).join(" · ") : mode==="skills" ? [row.kind, row.cooldown != null && db.labels && db.labels.cooldown ? db.labels.cooldown.replace("{0}", row.cooldown) : ""].filter(Boolean).join(" · ") : mode==="gear" ? [row.slot, row.rarity].filter(Boolean).join(" · ") : [(row.places||[]).join("、"), groundSpots(row.id).length ? (groundSpots(row.id).length+" 处固定搜刮") : "", (row.needs||[]).length ? (row.needs.length+" 个任务需要") : "", (row.salvage||[]).length ? (row.salvage.length+" 个拆解来源") : ""].filter(Boolean).join(" · ");
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
function combatSummary(row) {
  const combat = row.combat;
  if (!combat) return "";
  const hit = (combat.attacks || []).find(atk => (atk.hits || []).length);
  const first = hit && hit.hits[0];
  return "生命 " + combat.health + (first ? " · " + first.kind + " " + first.amount + (first.tick ? " 每跳" : "") : "");
}
function combatWords(row) {
  const combat = row.combat;
  if (!combat) return "";
  return (combat.attacks || []).map(atk => (atk.title || "") + " " + (atk.hits || []).map(hit => hit.kind + " " + hit.amount + (hit.tick ? " 每跳" : "")).join(" ")).join(" ");
}
function combatBlock(row) {
  const combat = row.combat;
  if (!combat) return "";
  const text = (n) => {
    if (typeof n !== "number") return "";
    if (Math.abs(n - Math.round(n)) < 0.001) return String(Math.round(n));
    return String(Math.round(n * 100) / 100);
  };
  const cd = (value) => !value ? "" : (Array.isArray(value) ? text(value[0]) + "–" + text(value[1]) : text(value)) + " 秒";
  const weak = combat.armor < combat.resist ? "护甲更低，更怕物理伤害。" : combat.resist < combat.armor ? "魔法抗性更低，更怕魔法伤害。" : combat.armor === 0 ? "没有护甲和魔法抗性，物理伤害和魔法伤害都不减免。" : "护甲和魔法抗性相同。";
  const attacks = (combat.attacks || []).map(atk => {
    const hurt = (atk.hits || []).map(hit => hit.kind + " " + text(hit.amount) + (hit.max ? "–" + text(hit.max) : "") + (hit.tick ? " 每跳" : "")).join("、");
    return "<tr><td>" + esc(atk.title || hurt || "攻击") + "</td><td>" + esc(hurt) + "</td><td>" + esc(cd(atk.cooldown)) + "</td><td>" + esc(atk.range ? text(atk.range) : "") + "</td></tr>";
  }).join("");
  return '<h3>属性</h3><table><tbody><tr><td>生命值</td><td>' + text(combat.health) + '</td></tr><tr><td>护甲</td><td>' + text(combat.armor) + '</td></tr><tr><td>魔法抗性</td><td>' + text(combat.resist) + '</td></tr></tbody></table><p class="muted">' + weak + ' 每点护甲或魔法抗性，大约相当于多用 1% 生命去承受对应伤害。这是普通形态，精英、噩梦和庇护所的敌人难度还会再提高生命和伤害。</p>'
    + (attacks ? '<h3>攻击</h3><table><thead><tr><th>技能</th><th>伤害</th><th>冷却</th><th>射程</th></tr></thead><tbody>' + attacks + '</tbody></table>' : '');
}
function characterSummary(row) {
  const stats = row && row.stats || [];
  const value = (label) => {
    const stat = stats.find(item => item.label === label);
    return stat ? String(stat.value) : "";
  };
  const parts = [];
  if (value("生命值")) parts.push("生命 " + value("生命值"));
  if (value("物理伤害")) parts.push("物理 " + value("物理伤害"));
  if (value("魔法伤害") && value("魔法伤害") !== "0") parts.push("魔法 " + value("魔法伤害"));
  if (value("护甲")) parts.push("护甲 " + value("护甲"));
  if (value("魔法抗性")) parts.push("魔法抗性 " + value("魔法抗性"));
  return parts.join(" · ");
}
function innateNote(row) {
  if (!row || row.armor == null || row.resist == null) return "";
  const line = Number(row.armor) < Number(row.resist) ? "护甲更低，更怕物理伤害。" : Number(row.resist) < Number(row.armor) ? "魔法抗性更低，更怕魔法伤害。" : Number(row.armor) === 0 ? "没有护甲和魔法抗性，物理伤害和魔法伤害都不减免。" : "护甲和魔法抗性相同。";
  return '<p class="muted">' + line + " 每点护甲或魔法抗性，大约相当于多用 1% 生命去承受对应伤害。攻击速度、暴击率和冷却缩减没有写在角色的天生属性里。</p>";
}
function spawnSummary(row) {
  const spawns = row.spawns || [];
  if (!spawns.length) return "";
  const counts = new Map();
  for (const point of spawns) counts.set(point.map, (counts.get(point.map) || 0) + 1);
  return [...counts].map(([id, count]) => {
    const map = (db.maps || []).find(item => item.id === id);
    return (map ? map.title : id) + " " + count + " 处";
  }).join("、");
}
function spawnMaps(row) {
  const spawns = row.spawns || [];
  if (!spawns.length) return "";
  const ids = [...new Set(spawns.map(point => point.map))];
  return ids.map(id => {
    const map = (db.maps || []).find(item => item.id === id);
    if (!map || !map.image) return "";
    const here = spawns.filter(point => point.map === id);
    const dots = here.map(point => '<i style="left:'+point.left+'%;top:'+point.top+'%"></i>').join("");
    const routes = here.filter(point => (point.path || []).length >= 2).map(point => '<polyline class="route" points="'+point.path.map(p => p.left+","+p.top).join(" ")+'"></polyline>').join("");
    const svg = routes ? '<svg viewBox="0 0 100 100" preserveAspectRatio="none">'+routes+'</svg>' : "";
    const routeNote = routes ? " 虚线是巡逻路线。" : "";
    return '<div class="ground-zoom"><div class="mapzoom"><button type="button" class="zoom-btn" data-zoom="in">放大</button><button type="button" class="zoom-btn" data-zoom="out" disabled>缩小</button><button type="button" class="zoom-btn" data-zoom="reset">还原</button><span class="zoom-readout">100%</span></div><div class="mapwrap"><div class="mapstage spawn-map"><img draggable="false" alt="'+esc(map.title)+'" src="'+map.image+'">'+svg+dots+'</div><div class="mapsizer"></div></div><p class="muted">'+esc(map.title)+'，可能刷新 '+here.length+' 处。一局里不一定每处都会出现。'+routeNote+'</p></div>';
  }).join("");
}
function groundMaps(spots) {
  const ids = [];
  for (const spot of spots) if (ids.indexOf(spot.mapId) < 0) ids.push(spot.mapId);
  return ids.map(id => {
    const map = (db.maps || []).find(item => item.id === id);
    if (!map || !map.image) return "";
    const here = spots.filter(spot => spot.mapId === id);
    const dots = here.map(spot => '<i class="fixed" style="left:'+spot.left+'%;top:'+spot.top+'%"></i>').join("");
    const amounts = [];
    for (const spot of here) {
      let group = null;
      for (const item of amounts) if (item.amount === spot.amount) group = item;
      if (!group) {
        group = { amount: spot.amount, count: 0 };
        amounts.push(group);
      }
      group.count++;
    }
    const detail = amounts.map(group => group.count + " 处 ×" + group.amount).join("，");
    return '<div class="ground-zoom"><div class="mapzoom"><button type="button" class="zoom-btn" data-zoom="in">放大</button><button type="button" class="zoom-btn" data-zoom="out" disabled>缩小</button><button type="button" class="zoom-btn" data-zoom="reset">还原</button><span class="zoom-readout">100%</span></div><div class="mapwrap"><div class="mapstage spawn-map"><img draggable="false" alt="'+esc(map.title)+'" src="'+map.image+'">'+dots+'</div><div class="mapsizer"></div></div><p class="muted"><a data-map="'+esc(map.id)+'">'+esc(map.title)+'</a>，固定出现 '+detail+'。</p></div>';
  }).join("");
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
function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
}
function bindJumps(root) {
  root.querySelectorAll("[data-jump]").forEach(a => a.onclick = (event) => { event.preventDefault(); openTable(a.dataset.jump); });
  root.querySelectorAll("[data-item]").forEach(a => a.onclick = (event) => { event.preventDefault(); openItem(a.dataset.item); });
  root.querySelectorAll("[data-loot]").forEach(a => a.onclick = (event) => { event.preventDefault(); openLoot(a.dataset.loot); });
  root.querySelectorAll("[data-source]").forEach(a => a.onclick = (event) => { event.preventDefault(); openSource(a.dataset.source); });
  root.querySelectorAll("[data-skill]").forEach(a => a.onclick = (event) => { event.preventDefault(); const row = (db.skills || []).find(s => s.name === a.dataset.skill); if (row) show("skills", row); });
  root.querySelectorAll("[data-character]").forEach(a => a.onclick = (event) => { event.preventDefault(); const row = (db.characters || []).find(c => c.id === a.dataset.character); if (row) show("characters", row); });
  root.querySelectorAll("[data-gear]").forEach(a => a.onclick = (event) => { event.preventDefault(); const row = (db.gear || []).find(g => String(g.id) === a.dataset.gear); if (row) show("gear", row); });
  root.querySelectorAll("[data-map]").forEach(a => a.onclick = (event) => { event.preventDefault(); const map = (db.maps || []).find(m => m.id === a.dataset.map); if (map) show("maps", map); });
}
function clearMapZoom() {
  for (const observer of mapObservers) observer.disconnect();
  mapObservers = [];
}
function bindMapZoom(box) {
  const mapwrap = box.querySelector(".mapwrap");
  const mapstage = box.querySelector(".mapstage");
  const mapsizer = box.querySelector(".mapsizer");
  const zoomReadout = box.querySelector(".zoom-readout");
  const zoomIn = box.querySelector('[data-zoom="in"]');
  const zoomOut = box.querySelector('[data-zoom="out"]');
  const zoomReset = box.querySelector('[data-zoom="reset"]');
  if (!mapwrap || !mapstage || !mapsizer || !zoomReadout || !zoomIn || !zoomOut || !zoomReset) return;
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
    const boxSize = viewW + "x" + baseH + "@" + scale;
    if (!anchor && boxSize === fitted) return;
    fitted = boxSize;
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
  const observer = new ResizeObserver(() => {
    if (!mapwrap.isConnected) { observer.disconnect(); return; }
    applyScale(scale);
  });
  mapObservers.push(observer);
  observer.observe(mapwrap);
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
function open(row) {
  clearMapZoom();
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
      let drops = table ? flattenDrops(table, 1, 0, new Set()) : [];
      if (row.category === "怪物") drops = mergeGearDrops(drops);
      drops.sort((a, b) => b.chance - a.chance);
      const body = drops.map(drop => {
        const what = drop.kind === "table"
          ? (sourceForTable(drop.enumName) ? '<a data-loot="'+drop.enumName+'">'+named(drop.title, drop.enumName)+'</a>' : named(drop.title, drop.enumName))
          : '<a data-item="'+drop.id+'">'+icon(drop.icon, drop.title)+' '+drop.title+'</a>'+(drop.recipe ? ' <span class="tag">配方 '+drop.recipeId+'</span>' : '');
        const chanceCell = drop.oddsText
          ? drop.oddsText + '<div class="bar"><span style="width:'+Math.max(2, Math.min(100, drop.chance * 100))+'%"></span></div>'
          : formatPct(drop.chance)+'<div class="bar"><span style="width:'+Math.max(2, Math.min(100, drop.chance * 100))+'%"></span></div>';
        const extra = (drop.rarity ? drop.rarity + " " : "") + (drop.flags || []).map(flag => '<span class="tag">'+flag+'</span>').join("");
        return '<tr><td>'+what+'</td><td>'+(drop.amount||"")+'</td><td>'+chanceCell+'</td><td>'+extra+'</td></tr>';
      }).join("");
      return '<h3>'+named((table && table.title) || ref.title, (table && table.enumName) || ref.table)+'</h3>'
        + '<table><thead><tr><th>掉落</th><th>数量</th><th>几率</th><th>稀有度 / 标记</th></tr></thead><tbody>'+body+'</tbody></table>';
    }).join("");
    const where = [row.place && ("地点："+row.place), row.look && row.look !== row.title && !String(row.title).includes(row.look) && ("样子："+row.look)].filter(Boolean).join(" · ");
    const spots = spawnMaps(row);
    detailEl.innerHTML = '<div class="hero">'+icon(row.icon, sourceLabel(row))+'<div><h2>'+sourceLabel(row).replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]))+'</h2><div class="muted">'+row.category+'</div>'+(where ? '<p>'+where+'</p>' : '')+'</div></div>' + combatBlock(row) + (spots ? '<h3>可能刷新</h3>'+spots : '') + blocks;
    bindJumps(detailEl);
    detailEl.querySelectorAll(".ground-zoom").forEach(bindMapZoom);
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
    const needs = row.needs || [];
    const needTable = '<h3>任务需要</h3><table><thead><tr><th>任务</th><th>要求</th><th>数量</th></tr></thead><tbody>'
      + (needs.length ? needs.map(need => {
        const quest = (db.quests || []).find(q => (need.id && q.id === need.id) || q.title === need.quest);
        const name = quest ? '<a data-quest="'+esc(quest.id)+'">'+esc(need.quest)+'</a>' : esc(need.quest);
        return '<tr><td>'+name+'</td><td>'+esc(need.kind)+'</td><td>'+need.count+'</td></tr>';
      }).join("") : '<tr><td colspan="3" class="muted">没有任务需要这个</td></tr>')
      + '</tbody></table>';
    const salvage = row.salvage || [];
    const salvageTable = salvage.length ? '<h3>拆解得到</h3><table><thead><tr><th>来源</th><th>品质</th><th>数量</th></tr></thead><tbody>'
      + salvage.map(src => {
        const item = src.item && (db.items || []).find(it => String(it.id) === String(src.item));
        const gear = !item && src.item && (db.gear || []).find(g => String(g.id) === String(src.item));
        const name = item ? '<a data-item="'+item.id+'">'+esc(item.title)+'</a>' : gear ? '<a data-gear="'+gear.id+'">'+esc(gear.title)+'</a>' : esc(src.pool || src.title || "");
        return '<tr><td>'+name+'</td><td>'+esc(src.rarity || "")+'</td><td>'+(src.chance ? "有几率" : src.count)+'</td></tr>';
      }).join("")
      + '</tbody></table>' + (salvage.some(src => src.chance) ? '<p class="muted">有几率的来源是拆解时额外可能开出的，不是每次都有。</p>' : "") : "";
    const ground = groundSpots(row.id);
    const groundTable = ground.length ? '<h3>地图上的固定搜刮</h3>'+groundMaps(ground)+'<p class="muted">方块是场景里写死的位置，每次都在原地，不是箱子里开出来的。</p>' : "";
    const dropTable = '<h3>哪里掉</h3><table><thead><tr><th>来源</th><th>数量</th><th>几率</th></tr></thead><tbody>'
      + (from.length ? from.map(({source, drop}) => '<tr><td><a data-source="'+encodeURIComponent(rowKey("sources", source))+'">'+sourceLabel(source).replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]))+'</a></td><td>'+(drop.amount||"")+'</td><td>'+formatPct(drop.chance)+'</td></tr>').join("") : '<tr><td colspan="3" class="muted">没有怪物或搜刮点掉这个</td></tr>')
      + '</tbody></table>';
    detailEl.innerHTML = '<div class="hero">'+icon(row.icon, row.title)+'<div><h2>'+row.title+'</h2>'+(places ? '<div class="muted">地点：'+places+'</div>' : '')+'</div></div>'
      + needTable
      + salvageTable
      + groundTable
      + (from.length || !ground.length ? dropTable : "");
    bindJumps(detailEl);
    detailEl.querySelectorAll(".ground-zoom").forEach(bindMapZoom);
  } else if (mode === "quests") {
    const itemLink = (id) => {
      const title = itemTitle(id);
      return title ? '<a data-item="'+id+'">'+esc(title)+'</a>' : "";
    };
    const stepRows = (row.steps || []).map(step => {
      const what = step.item ? itemLink(step.item) : esc(step.text || "");
      if (!what) return "";
      return '<tr><td>'+esc(step.kind || "")+'</td><td>'+what+'</td><td>'+(step.count || "")+'</td></tr>';
    }).filter(Boolean).join("");
    const rewardRows = (row.rewards || []).map(reward => {
      const what = itemLink(reward.item);
      if (!what) return "";
      return '<tr><td>'+what+'</td><td>'+reward.count+'</td></tr>';
    }).filter(Boolean).join("");
    const who = [row.giver ? "委托人："+row.giver : "", row.turnIn ? "交付："+row.turnIn : "", (row.areas||[]).length ? "地点："+row.areas.join("、") : ""].filter(Boolean).join(" · ");
    detailEl.innerHTML = '<div class="hero"><div><h2>'+esc(row.title)+'</h2>'+(who ? '<div class="muted">'+esc(who)+'</div>' : '')+'</div></div>'
      + (row.description ? '<p>'+esc(row.description)+'</p>' : '')
      + '<h3>目标</h3>' + (stepRows ? '<table><thead><tr><th>要求</th><th>内容</th><th>数量</th></tr></thead><tbody>'+stepRows+'</tbody></table>' : '<p class="muted">没有写明的目标。</p>')
      + '<h3>奖励</h3>' + (rewardRows ? '<table><thead><tr><th>物品</th><th>数量</th></tr></thead><tbody>'+rewardRows+'</tbody></table>' : '<p class="muted">没有写明的物品奖励。</p>')
      + (row.handIn ? '<h3>交付时</h3><p>'+esc(row.handIn)+'</p>' : '');
    bindJumps(detailEl);
  } else if (mode === "characters") {
    const labels = db.labels || {};
    const skillLink = (skill) => skill ? '<a data-skill="'+esc(skill.id)+'">'+esc(skill.title)+'</a>' : "";
    const perkRows = (row.perks || []).map(perk => {
      const item = perk.item && (db.items || []).find(it => String(it.id) === String(perk.item));
      const itemCell = item ? '<a data-item="'+esc(item.id)+'">'+esc(perk.itemTitle || item.title)+'</a>' : esc(perk.itemTitle || "");
      return '<tr><td>'+skillLink(perk)+'</td><td>'+esc(perk.level)+'</td><td>'+itemCell+'</td></tr>';
    }).join("");
    const innate = (row.stats || []).slice();
    if (row.vision) innate.push({ label: "视野范围", value: row.vision });
    const statRows = innate.map(stat => '<tr><td>'+esc(stat.label)+'</td><td>'+esc(stat.value)+'</td></tr>').join("");
    detailEl.innerHTML = '<div class="hero">'+icon(row.icon, row.title)+'<div><h2>'+esc(row.title)+'</h2><div class="muted">'+esc([row.origin, row.role].filter(Boolean).join(" · "))+'</div>'+(row.locked ? '<p>'+esc(row.locked)+'</p>' : '')+'</div></div>'
      + (row.description ? '<p>'+esc(row.description)+'</p>' : '')
      + (row.strengths || row.weaknesses ? '<p>'+[row.strengths, row.weaknesses].filter(Boolean).map(esc).join("<br>")+'</p>' : '')
      + (row.originDescription ? '<p>'+esc(row.originDescription)+'</p>' : '')
      + (row.quote ? '<p class="muted">'+esc(row.quote)+'</p>' : '')
      + (row.energy ? '<p>'+esc(row.energy)+'</p>' : '')
      + (statRows ? '<h3>'+esc(labels.base || "基础属性")+'</h3><table><tbody>'+statRows+'</tbody></table>'+innateNote(row) : '')
      + (row.basicSkill ? '<h3>'+skillLink(row.basicSkill)+'</h3>' : '')
      + ((row.activeSkills || []).length ? '<p>'+(row.activeSkills || []).map(skillLink).join("、")+'</p>' : '')
      + ((row.passiveSkills || []).length ? '<p>'+(row.passiveSkills || []).map(skillLink).join("、")+'</p>' : '')
      + (perkRows ? '<h3>'+esc(labels.perks || "")+'</h3><table><thead><tr><th></th><th>'+esc(labels.level || "")+'</th><th></th></tr></thead><tbody>'+perkRows+'</tbody></table>' : '');
    bindJumps(detailEl);
  } else if (mode === "skills") {
    const labels = db.labels || {};
    const castText = row.cast == null || !labels.cast ? "" : labels.cast.indexOf("{0}") >= 0 ? labels.cast.replace("{0}", row.cast) : labels.cast + " " + row.cast;
    const meta = [row.kind, row.cooldown != null && labels.cooldown ? labels.cooldown.replace("{0}", row.cooldown) : "", castText].filter(Boolean).join(" · ");
    const owners = (row.owners || []).map(id => { const character = (db.characters || []).find(c => c.id === id); return character ? '<a data-character="'+esc(character.id)+'">'+esc(character.title)+'</a>' : ""; }).filter(Boolean).join("、");
    const gearLinks = (db.gear || []).filter(g => (g.forcedSkills || []).indexOf(row.name) >= 0 || (g.poolSkills || []).indexOf(row.name) >= 0).map(g => '<a data-gear="'+esc(g.id)+'">'+esc(g.title)+'</a>').join("、");
    detailEl.innerHTML = '<div class="hero">'+icon(row.icon, row.title)+'<div><h2>'+esc(row.title)+'</h2><div class="muted">'+esc(meta)+'</div></div></div>'
      + (row.top ? '<p>'+esc(row.top)+'</p>' : '')
      + (row.bottom ? '<p>'+esc(row.bottom)+'</p>' : '')
      + (owners ? '<p>'+owners+'</p>' : '')
      + (gearLinks ? '<p>'+gearLinks+'</p>' : '');
    bindJumps(detailEl);
  } else if (mode === "gear") {
    const labels = db.labels || {};
    const lines = (title, rows) => rows && rows.length ? '<h3>'+esc(title)+'</h3><ul>'+rows.map(text => '<li>'+esc(text)+'</li>').join("")+'</ul>' : '';
    const classes = (row.classes || []).map((title, index) => {
      const id = (row.classIds || [])[index];
      const character = (db.characters || []).find(c => c.id === id);
      return character ? '<a data-character="'+esc(character.id)+'">'+esc(character.title)+'</a>' : esc(title);
    }).join("、");
    const linked = {};
    (row.forcedSkills || []).concat(row.poolSkills || []).forEach(name => { linked[name] = true; });
    const skillLinks = Object.keys(linked).map(name => {
      const skill = (db.skills || []).find(s => s.name === name);
      return skill ? '<a data-skill="'+esc(skill.name)+'">'+esc(skill.title)+'</a>' : "";
    }).filter(Boolean).join("、");
    detailEl.innerHTML = '<div class="hero">'+icon(row.icon, row.title)+'<div><h2>'+esc(row.title)+'</h2><div class="muted">'+esc([row.slot, row.rarity].filter(Boolean).join(" · "))+'</div>'+(classes ? '<p>'+classes+'</p>' : '')+'</div></div>'
      + (row.description ? '<p>'+esc(row.description)+'</p>' : '')
      + lines(labels.base, row.base)
      + lines(labels.special, row.forced)
      + lines(labels.random, row.pool)
      + (skillLinks ? '<p>'+skillLinks+'</p>' : '')
      + (db.items && db.items.some(it => String(it.id) === String(row.id)) ? '<p><a data-item="'+esc(row.id)+'">'+esc(row.title)+'</a></p>' : '');
    bindJumps(detailEl);
  } else if (mode === "maps") {
    const colors = ["#e2b15a", "#7dcea0", "#8eb6ff", "#e07a7a", "#c39bd3", "#f0b27a", "#76d7c4", "#f7dc6f", "#85c1e9", "#f5b7b1"];
    const regionColors = ["#7dcea0", "#8eb6ff", "#e2b15a", "#e07a7a", "#c39bd3", "#f0b27a", "#76d7c4", "#f7dc6f", "#85c1e9", "#f5b7b1", "#abebc6", "#d7bde2"];
    const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
    const maybe = [];
    for (const source of db.sources) {
      if (source.category !== "搜刮点") continue;
      const table = source.refs && source.refs[0] ? source.refs[0].table : "";
      for (const point of source.spawns || []) {
        if (point.map !== row.id) continue;
        const placed = row.pins.some(pin => pin.title === source.title && Math.abs(pin.left - point.left) < 1.2 && Math.abs(pin.top - point.top) < 1.2);
        if (placed) continue;
        maybe.push({ title: source.title, table: table, left: point.left, top: point.top });
      }
    }
    const ground = (row.pickups || []).map(spot => {
      const title = itemTitle(spot.item);
      if (!/[\u4e00-\u9fff]/.test(title)) return null;
      return { title: title, item: spot.item, amount: spot.amount, left: spot.left, top: spot.top };
    }).filter(Boolean);
    const titles = [...new Set(row.pins.map(pin => pin.title).concat(maybe.map(pin => pin.title)))];
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
    const npcLegend = npcTitles.map(title => {
      const actor = npcs.find(item => item.title === title);
      const face = actor && actor.icon ? '<img alt="" src="'+esc(actor.icon)+'">' : '<span class="dot" style="background:#5dade2"></span>';
      return '<button type="button" class="tag npc-filter on" data-key="'+esc(title)+'" aria-pressed="true" data-title="'+esc(title)+'">'+face+esc(title)+'</button>';
    }).join("");
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
    }).join("") + maybe.map(pin => {
      const shown = mapHit || pin.title.toLowerCase().includes(q);
      return '<button type="button" class="pin maybe" data-loot="'+pin.table+'" data-key="'+esc(pin.title)+'" data-title="'+esc(pin.title)+'" title="'+esc(pin.title)+'" style="left:'+pin.left+'%;top:'+pin.top+'%;background:transparent;border-color:'+colorOf(pin.title)+';display:'+(shown?"":"none")+'"></button>';
    }).join("");
    const groundTitles = [...new Set(ground.map(spot => spot.title))];
    const groundColor = (title) => colors[groundTitles.indexOf(title) % colors.length];
    const groundLegend = groundTitles.map(title => '<button type="button" class="tag ground-filter on" data-key="'+esc(title)+'" aria-pressed="true" data-title="'+esc(title)+'"><span class="dot" style="background:'+groundColor(title)+'"></span>'+esc(title)+'</button>').join("");
    const groundMarks = ground.map(spot => {
      const shown = mapHit || spot.title.toLowerCase().includes(q);
      const tip = spot.amount > 1 ? spot.title + " ×" + spot.amount : spot.title;
      return '<button type="button" class="ground" data-item="'+spot.item+'" data-key="'+esc(spot.title)+'" data-title="'+esc(spot.title)+'" title="'+esc(tip)+'" style="left:'+spot.left+'%;top:'+spot.top+'%;background:'+groundColor(spot.title)+';display:'+(shown?"":"none")+'"></button>';
    }).join("");
    const links = row.links || [];
    const linkColors = ["#f5b041", "#5dade2", "#af7ac5", "#58d68d", "#ec7063", "#f4d03f"];
    const linkTitles = [...new Set(links.map(link => link.title))];
    const linkLegend = linkTitles.map(title => '<button type="button" class="tag link-filter on" data-key="'+esc(title)+'" aria-pressed="true" data-title="'+esc(title)+'"><span class="dot" style="background:#f5b041"></span>'+esc(title)+'</button>').join("");
    const linkLines = links.map((link, index) => '<line data-key="'+esc(link.title)+'" data-title="'+esc(link.title)+'" x1="'+link.a.left+'" y1="'+link.a.top+'" x2="'+link.b.left+'" y2="'+link.b.top+'" stroke="'+linkColors[index % linkColors.length]+'" stroke-width="0.55" stroke-linecap="round"></line>').join("");
    const hops = links.map((link, index) => [link.a, link.b].map(point => '<div class="hop" data-key="'+esc(link.title)+'" data-title="'+esc(link.title)+'" title="'+esc(link.title)+'" style="left:'+point.left+'%;top:'+point.top+'%;background:'+linkColors[index % linkColors.length]+'"></div>').join("")).join("");
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
      links.length ? "同色圆点和连线是一组传送，两端互通。" : "",
      (row.pins.length || maybe.length) ? "实心点 "+row.pins.length+" 处是场景里摆好的搜刮点。虚线圆 "+maybe.length+" 处是配置里另外写下的位置，一局不一定都会刷出来。点标记打开对应掉落。" : (ground.length ? "" : "这张地图的场景里没有写好的搜刮点坐标。"),
      ground.length ? "方块 "+ground.length+" 处是直接放在地上的物品，位置是场景里写死的。点一下打开该物品。" : "",
      npcs.length ? "NPC "+npcs.length+" 处，蓝点是场景里写死的位置。能对上来源的点可以打开该条目。" : "这张地图的场景里没有写死的 NPC 坐标。",
      bosses.length ? "固定怪 "+bosses.length+" 处，红菱形是场景里写死、总会刷在原地的具名单位。"+(pathCount ? "虚线是同一只怪旁边分开的巡逻点。" : "") : "这张地图的场景里没有写死的具名怪物坐标。",
    ].filter(Boolean).join("");
    detailEl.innerHTML = '<h2>'+esc(row.title)+'</h2><p class="muted">'+note+'</p>'+legendBlock("区域", "region", regionLegend)+legendBlock("入口", "gate", gateLegend)+legendBlock("传送", "link", linkLegend)+legendBlock("搜刮点", "pin", legend)+legendBlock("地上物品", "ground", groundLegend)+legendBlock("NPC", "npc", npcLegend)+legendBlock("固定怪", "boss", bossLegend)+'<div class="mapzoom"><button type="button" class="zoom-btn" data-zoom="in">放大</button><button type="button" class="zoom-btn" data-zoom="out" disabled>缩小</button><button type="button" class="zoom-btn" data-zoom="reset">还原</button><span class="zoom-readout">100%</span></div><div class="mapwrap"><div class="mapstage"><img draggable="false" alt="'+esc(row.title)+'" src="'+row.image+'"><svg viewBox="0 0 100 100" preserveAspectRatio="none">'+shapes+bossPaths+linkLines+'</svg>'+labels+gates+hops+dots+groundMarks+npcMarks+bossMarks+'</div><div class="mapsizer"></div></div>';
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
    function applyLinks() {
      const picked = checkedKeys(".link-filter");
      detailEl.querySelectorAll(".mapstage svg line, .mapstage .hop").forEach(el => showIf(el, picked));
    }
    function applyPins() {
      const picked = checkedKeys(".pin-filter");
      detailEl.querySelectorAll(".mapstage .pin").forEach(el => showIf(el, picked));
    }
    function applyGround() {
      const picked = checkedKeys(".ground-filter");
      detailEl.querySelectorAll(".mapstage .ground").forEach(el => showIf(el, picked));
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
    bindChecks(".link-filter", applyLinks);
    bindChecks(".pin-filter", applyPins);
    bindChecks(".ground-filter", applyGround);
    bindChecks(".npc-filter", applyNpcs);
    bindChecks(".boss-filter", applyBosses);
    bindBulk("region", ".region-filter", applyRegions);
    bindBulk("gate", ".gate-filter", applyGates);
    bindBulk("link", ".link-filter", applyLinks);
    bindBulk("pin", ".pin-filter", applyPins);
    bindBulk("ground", ".ground-filter", applyGround);
    bindBulk("npc", ".npc-filter", applyNpcs);
    bindBulk("boss", ".boss-filter", applyBosses);
    applyRegions();
    applyGates();
    applyLinks();
    applyPins();
    applyGround();
    applyNpcs();
    applyBosses();
    bindMapZoom(detailEl);
  }
  detailEl.scrollTop = 0;
}
function syncChrome() {
  const solo = mode === "dps" || mode === "rules";
  const main = document.querySelector("main");
  main.classList.toggle("dps-mode", mode === "dps");
  main.classList.toggle("rules-mode", mode === "rules");
  document.querySelector(".search").hidden = solo;
  if (solo) catEl.hidden = true;
}
function setMode(next) {
  if (next === mode) return;
  if (mode !== "dps" && mode !== "rules") listScroll[mode] = listEl.scrollTop;
  mode = next;
  if (next === "dps" || next === "rules") {
    present(next, null);
    pushView();
    return;
  }
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
    if (listScroll[next]) listEl.scrollTop = listScroll[next];
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
  if (kind === "characters") return "c:" + row.id;
  if (kind === "skills") return "k:" + row.name;
  if (kind === "gear") return "g:" + row.id;
  if (kind === "quests") return "q:" + row.id;
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
  if (kind === "c") return (db.characters || []).find(c => c.id === rest) || null;
  if (kind === "k") return (db.skills || []).find(s => s.name === rest) || null;
  if (kind === "g") return (db.gear || []).find(g => String(g.id) === rest) || null;
  if (kind === "q") return (db.quests || []).find(q => q.id === rest) || null;
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
  if (!["tables", "sources", "items", "maps", "characters", "skills", "gear", "quests", "dps", "rules"].includes(nextMode)) return null;
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
  if (listEl && mode !== kind && mode !== "dps" && mode !== "rules") listScroll[mode] = listEl.scrollTop;
  if (kind === "dps" || kind === "rules") {
    mode = kind;
    document.querySelectorAll(".tabs button").forEach(b => b.classList.remove("on"));
    document.getElementById("tab-" + kind).classList.add("on");
    syncChrome();
    return;
  }
  if (kind === "tables") {
    row = sourceForTable(row && (row.enumName || row.title || ""));
    kind = "sources";
  }
  mode = kind;
  syncCats();
  document.querySelectorAll(".tabs button").forEach(b => b.classList.remove("on"));
  document.getElementById("tab-"+kind).classList.add("on");
  syncChrome();
  renderList();
  if (listScroll[kind]) listEl.scrollTop = listScroll[kind];
  if (row) open(row);
  else { current = null; detailEl.innerHTML = ""; }
  const rows = filtered();
  const idx = row ? rows.findIndex(r => r === row || (r.enumName && r.enumName === row.enumName && !r.asset) || (r.id != null && row.id != null && r.id === row.id && r.name === row.name) || (r.asset && r.asset === row.asset && r.title === row.title) || (r.image && r.image === row.image)) : -1;
  const btn = idx >= 0 ? listEl.querySelector('.row[data-i="'+idx+'"]') : null;
  if (btn) {
    btn.classList.add("active");
    const listRect = listEl.getBoundingClientRect();
    const rowRect = btn.getBoundingClientRect();
    if (rowRect.top < listRect.top) listEl.scrollTop -= listRect.top - rowRect.top;
    else if (rowRect.bottom > listRect.bottom) listEl.scrollTop += rowRect.bottom - listRect.bottom;
  }
}
function applyView(state) {
  if (!state) return;
  const url = stateUrl(state);
  if (url === appliedUrl) return;
  appliedUrl = url;
  qEl.value = state.q || "";
  if (listEl && mode !== state.mode && mode !== "dps" && mode !== "rules") listScroll[mode] = listEl.scrollTop;
  mode = state.mode;
  if (state.mode === "dps" || state.mode === "rules") {
    present(state.mode, null);
    return;
  }
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
document.getElementById("tab-characters").onclick = () => setMode("characters");
document.getElementById("tab-skills").onclick = () => setMode("skills");
document.getElementById("tab-gear").onclick = () => setMode("gear");
document.getElementById("tab-items").onclick = () => setMode("items");
document.getElementById("tab-quests").onclick = () => setMode("quests");
document.getElementById("tab-maps").onclick = () => setMode("maps");
document.getElementById("tab-rules").onclick = () => setMode("rules");
document.getElementById("tab-dps").onclick = () => setMode("dps");
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
  const savedRow = saved && saved.mode !== "dps" && saved.mode !== "rules" && rowByKey(saved.id);
  if (saved && (saved.mode === "dps" || saved.mode === "rules")) {
    present(saved.mode, null);
  } else if (saved && savedRow) {
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
  fs.writeFileSync(path.join(ROOT, "龙窟破坏者WIKI.html"), html);
}

main();
