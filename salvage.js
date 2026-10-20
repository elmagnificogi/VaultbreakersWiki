const { readRecords, gameplayBytes } = require("./combat");

const RARITY = ["", "常见", "罕见", "稀有", "卓越", "传奇", "任务物品", "诅咒物品"];

function readSalvage(blob) {
  if (!blob || blob.length < 0x450) return null;
  const count = blob.readInt32LE(0x24c);
  if (count <= 0 || count > 15) return { itemType: blob.readInt32LE(0), rows: [] };
  const rows = [];
  for (let i = 0; i < count; i++) {
    const base = 0x250 + i * 0x54;
    const itemCount = blob.readInt32LE(base + 4);
    const items = [];
    const n = Math.max(0, Math.min(itemCount, 8));
    for (let j = 0; j < n; j++) {
      const at = base + 8 + j * 8;
      const amount = blob.readInt32LE(at);
      const item = blob.readInt32LE(at + 4);
      if (item > 0 && amount > 0) items.push({ item, amount });
    }
    rows.push({
      rarity: blob.readInt32LE(base),
      items,
      extraChance: blob.readInt32LE(base + 0x48),
      extraTable: blob.readInt32LE(base + 0x4c),
      extraItem: blob.readInt32LE(base + 0x50),
    });
  }
  return { itemType: blob.readInt32LE(0), rows };
}

function attachSalvage(items, dropTables, named) {
  const titleOf = new Map();
  for (const row of named || []) if (row && row.id != null && row.title) titleOf.set(row.id, row.title);
  for (const item of items) if (item && item.id != null && item.title) titleOf.set(item.id, item.title);
  const tableById = new Map((dropTables || []).map((table) => [table.id, table]));
  const incoming = new Map();
  const seen = new Set();
  const push = (itemId, row) => {
    const key = [itemId, row.item || "", row.pool || "", row.rarity || "", row.count || "", row.chance ? 1 : 0].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    if (!incoming.has(itemId)) incoming.set(itemId, []);
    incoming.get(itemId).push(row);
  };
  const poolSeen = new Set();
  for (const record of readRecords(gameplayBytes())) {
    const value = record.values.find((row) => row.type === "ItemConfiguration");
    if (!value) continue;
    const parsed = readSalvage(value.blob);
    if (!parsed) continue;
    const sourceTitle = titleOf.get(parsed.itemType) || "";
    for (const row of parsed.rows) {
      const rarity = RARITY[row.rarity] || "";
      if (sourceTitle) {
        for (const product of row.items) push(product.item, { item: parsed.itemType, title: sourceTitle, rarity, count: product.amount });
        if (row.extraChance > 0 && row.extraItem > 0) push(row.extraItem, { item: parsed.itemType, title: sourceTitle, rarity, chance: true });
      }
      if (row.extraChance > 0 && row.extraTable > 0) {
        const table = tableById.get(row.extraTable);
        if (!table) continue;
        for (const entry of table.entries || []) {
          if (!entry.item || entry.outcome === 1) continue;
          const key = entry.item + "|" + table.id;
          if (poolSeen.has(key)) continue;
          poolSeen.add(key);
          push(entry.item, { pool: table.title, chance: true });
        }
      }
    }
  }
  const order = new Map(RARITY.map((name, index) => [name, index]));
  let linked = 0;
  for (const item of items) {
    delete item.salvage;
    const rows = incoming.get(item.id);
    if (!rows || !rows.length) continue;
    rows.sort((a, b) => (a.chance === true) - (b.chance === true)
      || String(a.title || a.pool || "").localeCompare(String(b.title || b.pool || ""), "zh-CN")
      || (order.get(a.rarity) || 0) - (order.get(b.rarity) || 0)
      || (a.count || 0) - (b.count || 0));
    item.salvage = rows;
    linked++;
  }
  console.log("salvage items", linked);
}

module.exports = { attachSalvage };
