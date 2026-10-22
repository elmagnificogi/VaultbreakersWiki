const fs = require("fs");
const path = require("path");
const { extractNode } = require("./unityfs");
const { readPack, envelopePayload } = require("./artifacts");

const QUEST_TYPE = { 0: "支线", 1: "主线", 2: "每日", 3: "每周", 4: "建筑升级", 5: "物品交付", 6: "可重复" };
const OBJECTIVE = {
  0: "撤离", 1: "击杀敌人", 2: "互动", 3: "取得物品", 4: "携带物品撤离", 5: "制作",
  6: "进入地图", 7: "进入地点", 8: "积累神器能量", 9: "完成任务节点", 10: "击杀玩家",
  11: "唤醒神器", 12: "触发事件", 13: "持有物品", 14: "交付物品", 15: "把独特建筑升到指定等级",
  16: "炸开宝库", 17: "携带指定装备栏撤离", 18: "交付指定装备栏的物品", 19: "完成指定目标",
  20: "持有物品时击杀敌人", 21: "解锁图鉴", 22: "完成一组任务节点", 23: "分解物品类别",
  24: "命中脆弱敌人", 25: "拥有能量", 26: "使用弹跳花", 27: "自动完成", 28: "解锁制作配方",
  29: "关闭大型虚空传送门",
};
const RARITY = { 1: "常见", 2: "罕见", 3: "稀有", 4: "卓越", 5: "传奇", 6: "任务物品", 7: "诅咒物品" };
const REWARD = {
  0: "物品", 1: "配方", 2: "序章点数", 3: "神器能量", 4: "通用进度", 5: "永久进度", 6: "解锁配方列表",
  10: "解锁商店", 11: "解锁炼金", 12: "解锁天赋", 13: "解锁仓库", 14: "解锁挑战", 15: "解锁职业选择",
  16: "解锁迪奥娜商人", 17: "解锁沃尔卡林商人", 18: "解锁锻造", 19: "解锁神器", 30: "解锁精炼厂",
  40: "解锁护符栏", 41: "解锁第3消耗品栏", 42: "解锁戒指栏", 43: "解锁武器栏",
  50: "解锁仓库一行", 51: "解锁背包一格", 52: "解锁仓库页", 60: "永久解锁弹跳花",
};
const AREA_BITS = [[2, "Wolfswood"], [4, "Refinery"], [8, "Haven"], [16, "Bloodswamp"], [32, "DragonVault"], [64, "TitanFactory"]];
const MAPS = { 0: "Refinery", 1: "Bloodswamp", 2: "Pinewood", 3: "CrystalMountains", 4: "AccursedPlains", 5: "TitanFactory", 100: "DragonVault", 1000: "Lobby" };
const ITEM_OBJECTIVE = new Set([3, 4, 5, 13, 14, 18, 20, 28]);

function decode(buf, o) {
  const tag = buf[o++];
  if (tag <= 0x7f) return { value: tag, o };
  if (tag >= 0xe0) return { value: tag - 256, o };
  if (tag === 0xc0) return { value: null, o };
  if (tag === 0xc2) return { value: false, o };
  if (tag === 0xc3) return { value: true, o };
  if (tag === 0xcc) return { value: buf[o], o: o + 1 };
  if (tag === 0xcd) return { value: buf.readUInt16BE(o), o: o + 2 };
  if (tag === 0xce) return { value: buf.readUInt32BE(o), o: o + 4 };
  if (tag === 0xcf) return { value: buf.readBigUInt64BE(o).toString(), o: o + 8 };
  if (tag === 0xd0) return { value: buf.readInt8(o), o: o + 1 };
  if (tag === 0xd1) return { value: buf.readInt16BE(o), o: o + 2 };
  if (tag === 0xd2) return { value: buf.readInt32BE(o), o: o + 4 };
  if (tag === 0xd3) return { value: buf.readBigInt64BE(o).toString(), o: o + 8 };
  if (tag === 0xca) return { value: buf.readFloatBE(o), o: o + 4 };
  if (tag === 0xcb) return { value: buf.readDoubleBE(o), o: o + 8 };
  if ((tag & 0xe0) === 0xa0) {
    const n = tag & 0x1f;
    return { value: buf.toString("utf8", o, o + n), o: o + n };
  }
  if (tag === 0xd9) {
    const n = buf[o];
    return { value: buf.toString("utf8", o + 1, o + 1 + n), o: o + 1 + n };
  }
  if (tag === 0xda) {
    const n = buf.readUInt16BE(o);
    return { value: buf.toString("utf8", o + 2, o + 2 + n), o: o + 2 + n };
  }
  if (tag === 0xdb) {
    const n = buf.readUInt32BE(o);
    return { value: buf.toString("utf8", o + 4, o + 4 + n), o: o + 4 + n };
  }
  if ((tag & 0xf0) === 0x90) return readArray(buf, o, tag & 0x0f);
  if (tag === 0xdc) return readArray(buf, o + 2, buf.readUInt16BE(o));
  if (tag === 0xdd) return readArray(buf, o + 4, buf.readUInt32BE(o));
  throw new Error("quest messagepack tag " + tag.toString(16) + " at " + (o - 1));
}

function readArray(buf, o, count) {
  const value = [];
  for (let i = 0; i < count; i++) {
    const item = decode(buf, o);
    value.push(item.value);
    o = item.o;
  }
  return { value, o };
}

function parseEnum(text, name) {
  const start = text.indexOf(`public enum ${name}`);
  if (start < 0) throw new Error("missing enum " + name);
  const end = text.indexOf("\n}", start);
  const map = {};
  for (const match of text.slice(start, end).matchAll(/public const \w+ (\w+) = (-?\d+);/g)) map[match[2]] = match[1];
  return map;
}

function questPayload(bundle) {
  const node = bundle.nodes.find((item) => !item.path.includes("."));
  const data = extractNode(bundle, node);
  let at = 0;
  while ((at = data.indexOf("HVPK", at)) >= 0) {
    const pack = readPack(data, at);
    const entry = pack.entries.find((item) => item.name === "NpcQuestConfiguration.bytes");
    if (entry) return envelopePayload(data, pack.at + entry.offset);
    at += 4;
  }
  throw new Error("missing NpcQuestConfiguration");
}

function collectQuests(options) {
  const dump = fs.readFileSync(options.dumpPath, "utf8");
  const itemType = parseEnum(dump, "ItemType");
  const npcType = parseEnum(dump, "NpcType");
  const slotType = parseEnum(dump, "LoadoutSlotType");
  const itemCategory = parseEnum(dump, "ItemCategory");
  const nameFromKeys = options.nameFromKeys;
  const textForKey = options.textForKey;
  const displayText = options.displayText;
  const itemTitle = (id) => {
    const numeric = Number(id) || 0;
    if (!numeric) return "";
    const known = options.itemTitle && options.itemTitle(numeric);
    if (known && /[\u4e00-\u9fff]/.test(known)) return known;
    const enumName = itemType[String(numeric)] || "";
    if (!enumName || enumName === "INVALID") return numeric ? "物品#" + numeric : "";
    return nameFromKeys(enumName) || enumName;
  };
  const npcTitle = (id) => {
    if (id == null || id < 0) return "";
    const enumName = npcType[String(id)] || "";
    if (!enumName) return "NPC#" + id;
    const stripped = enumName.replace(/(InMatch|InLobby|Vines|Chest|Npc)$/g, "");
    return nameFromKeys(enumName) || (stripped !== enumName && nameFromKeys(stripped)) || enumName;
  };
  const resolveText = (raw) => {
    if (!raw) return "";
    return String(raw)
      .replace(/<ref>([^<]+)<\/ref>/g, (_, key) => nameFromKeys(key) || displayText(textForKey(key)) || key)
      .replace(/\{@([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\}/g, (_, _table, key) => displayText(textForKey(key)) || key)
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
  };
  const areaTitle = (flags) => {
    if (!flags) return "";
    return AREA_BITS.filter(([bit]) => flags & bit).map(([, name]) => {
      return nameFromKeys(name) || nameFromKeys("MapName_" + name) || displayText(textForKey("MapName_" + name)) || name;
    }).join("+");
  };
  const mapTitle = (id) => {
    const name = MAPS[id];
    if (!name) return "";
    return nameFromKeys(name) || displayText(textForKey("MapName_" + name)) || name;
  };
  const slotTitle = (id) => {
    const enumName = slotType[String(id)] || "";
    if (!enumName || enumName === "Invalid") return "";
    return nameFromKeys(enumName) || enumName;
  };
  const categoryTitle = (mask) => {
    const numeric = Number(mask) || 0;
    if (!numeric) return "";
    return Object.entries(itemCategory)
      .filter(([id]) => { const bit = Number(id); return bit > 0 && (numeric & bit) === bit; })
      .map(([, enumName]) => nameFromKeys(enumName) || enumName)
      .join("+");
  };

  const root = decode(questPayload(options.bundle), 0).value;
  const rawQuests = root[0];
  const lines = root[1];
  const byGuid = new Map();
  for (const raw of rawQuests) {
    byGuid.set(raw[0], {
      id: raw[0],
      parent: raw[1] || "",
      title: resolveText(raw[2]) || String(raw[2] || ""),
      area: areaTitle(raw[5]),
      sender: npcTitle(raw[7]),
      receiver: npcTitle(raw[8]),
      type: QUEST_TYPE[raw[11]] || ("类型" + raw[11]),
      energy: raw[27] || 0,
      objectives: raw[44] || [],
      future: raw[45] || [],
      rewards: raw[46] || [],
      alternative: raw[47] || [],
      gain: raw[48] || [],
      sort: raw[6] || 0,
      index: raw[3] || 0,
    });
  }
  const rewardRows = (rows) => (rows || []).map((reward) => ({
    kind: REWARD[reward[3]] || ("奖励类型" + reward[3]),
    itemId: Number(reward[0]) || 0,
    name: itemTitle(reward[0]),
    count: reward[1] || 0,
    rarity: (reward[3] === 0 || reward[3] === 1) ? (RARITY[reward[2]] || "") : "",
    variant: reward[4] || 0,
    unlocks: (reward[5] || []).map((row) => itemTitle(Array.isArray(row) ? row[0] : row)).filter(Boolean),
  }));
  const children = new Map();
  for (const quest of byGuid.values()) {
    if (!children.has(quest.parent)) children.set(quest.parent, []);
    children.get(quest.parent).push(quest);
  }
  for (const list of children.values()) list.sort((a, b) => a.sort - b.sort || a.index - b.index);
  const ordered = [];
  const seen = new Set();
  const walk = (guid) => {
    const quest = byGuid.get(guid);
    if (!quest || seen.has(guid)) return;
    seen.add(guid);
    ordered.push(quest);
    for (const child of children.get(guid) || []) walk(child.id);
  };
  for (const line of lines) walk(line[1]);
  for (const quest of byGuid.values()) if (!seen.has(quest.id)) ordered.push(quest);

  return ordered.map((quest, order) => {
    const objectives = quest.objectives.map((objective) => {
      const custom = objective[20] ? resolveText(objective[21]) : "";
      const item = itemTitle(objective[5]);
      const count = objective[2] || 0;
      const bits = [];
      if (custom) bits.push(custom);
      else {
        bits.push(OBJECTIVE[objective[1]] || ("目标" + objective[1]));
        if (item) bits.push(count > 1 ? item + "×" + count : item);
        else if (count > 1 && objective[1] !== 27) bits.push("×" + count);
        const slot = slotTitle(objective[6]);
        const map = objective[9] ? mapTitle(objective[9]) : "";
        const category = categoryTitle(objective[24]);
        const node = objective[25] && byGuid.get(objective[25]);
        if (slot) bits.push(slot);
        if (map) bits.push(map);
        if (objective[3]) bits.push("等级" + objective[3]);
        if (category) bits.push(category);
        if (node) bits.push("前置节点 " + node.title);
      }
      if (objective[17] && !objective[18]) bits.push("可选");
      return bits.filter(Boolean).join(" ");
    });
    const needs = [];
    for (const objective of quest.objectives) {
      if (!ITEM_OBJECTIVE.has(objective[1]) && objective[1] !== 18) continue;
      const name = itemTitle(objective[5]);
      if (!name) continue;
      needs.push({
        itemId: Number(objective[5]) || 0,
        name,
        count: objective[2] || 1,
        optional: !!(objective[17] && !objective[18]),
      });
    }
    return {
      id: quest.id,
      title: quest.title,
      type: quest.type,
      area: quest.area,
      sender: quest.sender,
      receiver: quest.receiver,
      parent: byGuid.has(quest.parent) ? quest.parent : "",
      energy: quest.energy,
      objectives,
      needs,
      rewards: rewardRows(quest.rewards),
      alternative: rewardRows(quest.alternative),
      preview: rewardRows(quest.future),
      gain: rewardRows(quest.gain),
      order,
    };
  });
}

module.exports = { collectQuests };
