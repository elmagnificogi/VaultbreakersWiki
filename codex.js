function ints(node, count) {
  const value = node && node._fixedBuffer && node._fixedBuffer.Value;
  if (!Array.isArray(value) || !value.length) return [];
  const buf = Buffer.from(value);
  const n = Math.max(0, Math.min(count == null ? node._length | 0 : count, Math.floor(buf.length / 4)));
  const out = [];
  for (let i = 0; i < n; i++) out.push(buf.readInt32LE(i * 4));
  return out;
}

function stats(node, typeOffset) {
  const value = node && node._fixedBuffer && node._fixedBuffer.Value;
  if (!Array.isArray(value) || !(node._length > 0)) return [];
  const buf = Buffer.from(value);
  const stride = 24;
  const count = Math.min(node._length | 0, Math.floor(buf.length / stride));
  const rows = [];
  for (let i = 0; i < count; i++) {
    const o = i * stride;
    const type = buf.readInt32LE(o + typeOffset);
    if (type < 0 || (typeOffset !== 0 && type === 0)) continue;
    rows.push({
      type,
      min: Number(buf.readBigInt64LE(o + 8)) / 65536,
      max: Number(buf.readBigInt64LE(o + 16)) / 65536,
    });
  }
  return rows;
}

function perks(node) {
  const value = node && node._fixedBuffer && node._fixedBuffer.Value;
  if (!Array.isArray(value) || !(node._length > 0)) return [];
  const buf = Buffer.from(value);
  const stride = 12;
  const count = Math.min(node._length | 0, Math.floor(buf.length / stride));
  const rows = [];
  for (let i = 0; i < count; i++) {
    const o = i * stride;
    const ability = buf.readInt32LE(o);
    if (ability <= 0) continue;
    rows.push({
      ability,
      item: buf.readUInt16LE(o + 4),
      level: buf.readInt32LE(o + 8),
    });
  }
  return rows;
}

function fp(value) {
  if (value == null) return null;
  if (typeof value === "object" && value.RawValue != null) return fp(value.RawValue);
  const n = typeof value === "number" ? value : typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : null;
  if (n == null) return null;
  return n / 65536;
}

function ticks(value) {
  const n = value && value._deterministicValue && value._deterministicValue.Value;
  return typeof n === "number" ? n : null;
}

function round(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function maskOf(node) {
  const raw = node && (node._value != null ? node._value : node);
  if (typeof raw === "bigint") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return BigInt(raw);
  if (typeof raw === "string" && /^-?\d+$/.test(raw)) return BigInt(raw);
  return 0n;
}

function collectCodex(sf, readObject, ctx) {
  const { asString, walk, byKey, textIds, chinese, abilities, classes, stats: statEnum, specials, iconFor, search, itemById, rarityNames, displayText } = ctx;
  const clean = (text) => (displayText ? displayText(text || "") : String(text || ""));
  const zh = (key) => {
    const text = clean(key && byKey.get(key));
    return text && /[\u4e00-\u9fff]/.test(text) ? text : "";
  };
  const zhId = (id) => {
    const n = id && typeof id === "object" ? id.Value != null ? id.Value : id.value__ : id;
    return zh(textIds.map[String(n)] || "");
  };
  const localized = (node) => {
    const id = node && node.m_TableEntryReference && node.m_TableEntryReference.m_KeyId;
    if (!id || id === "0") return "";
    const text = clean(chinese.get(String(id)) || "");
    return /[\u4e00-\u9fff]/.test(text) ? text : "";
  };
  const keyText = (value) => zh(asString(value) || "");

  const statText = new Map();
  const specialText = new Map();
  const rawAbilities = [];
  const rawCharacters = [];
  const rawGear = [];

  for (const obj of sf.objects) {
    let value;
    try {
      value = readObject(sf, obj).value;
    } catch {
      continue;
    }
    if (Array.isArray(value.BaseStatDescriptions)) {
      for (const row of value.BaseStatDescriptions) {
        const text = zhId(row && row.FullFormat);
        if (row && text) statText.set(row.Type, text);
      }
    }
    if (Array.isArray(value.SpecialStatDescriptions)) {
      for (const row of value.SpecialStatDescriptions) {
        const text = zhId(row && row.FullFormat);
        if (row && text) specialText.set(row.Type, text);
      }
    }

    let asset = "";
    walk(value, (key, child) => {
      const text = asString(child);
      if (!asset && text && /ConfigurationAsset$/.test(text)) asset = text;
    });
    if (!asset) continue;

    if (value.CharacterConfigurationValues && value.CharacterDescription) {
      rawCharacters.push({ asset, value });
    }
    if (value.ActiveAbilityConfigurationValues || value.PassiveAbilityConfigurationValues) {
      rawAbilities.push({ asset, value });
    }
    if (value.GearItemConfiguration && value.ItemConfiguration) {
      rawGear.push({ asset, value });
    }
  }

  const className = (id) => classes.map[String(id)] || "";
  const abilityName = (id) => abilities.map[String(id)] || "";
  const slotOrder = [
    [256n, "Weapon"],
    [8n, "Helmet"],
    [16n, "Pauldrons"],
    [32n, "Armor"],
    [64n, "Gloves"],
    [128n, "Boots"],
    [512n, "Amulet"],
    [1024n, "Ring"],
    [536870912n, "Trinket"],
    [4096n, "Activatable"],
    [2048n, "Consumable"],
  ];
  const gearBits = slotOrder.reduce((sum, [bit]) => sum | bit, 2n | 4n);

  function abilityRecord(asset, value) {
    const enumName = asset.replace(/ConfigurationAsset$/, "");
    const id = abilities.nameToId[enumName];
    if (id == null) return null;
    const active = value.ActiveAbilityConfigurationValues || null;
    const passive = value.PassiveAbilityConfigurationValues || null;
    const description = value.Description || {};
    const nameKey = asString(description.Name) || enumName;
    const title = keyText(description.Name) || zh(enumName) || zh(nameKey) || "";
    const top = keyText(description.TopTooltip) || zh(enumName + "_topTooltip") || zh(enumName + "Tier1") || "";
    const bottom = keyText(description.BottomTooltip) || zh(enumName + "_bottomTooltip") || "";
    const cooldownTicks = active ? ticks(active.CooldownSeconds) : null;
    const cast = active ? fp(active.CastingTimeInSeconds) : null;
    const range = active ? fp(active.Range) : null;
    return {
      id,
      name: enumName,
      title,
      top,
      bottom,
      icon: iconFor(asString(value.IconFileName) || "") || iconFor(enumName) || null,
      passive: !!passive && !active,
      cooldown: cooldownTicks > 0 ? round(cooldownTicks / 30) : null,
      cast: cast > 0 ? round(cast) : null,
      range: range > 0 ? round(range) : null,
      english: (search[asset] && search[asset].name) || enumName,
    };
  }

  const abilityByName = new Map();
  for (const row of rawAbilities) {
    const record = abilityRecord(row.asset, row.value);
    if (!record) continue;
    const prev = abilityByName.get(record.name);
    if (!prev || (!prev.title && record.title) || (!prev.top && record.top)) abilityByName.set(record.name, record);
  }

  const characters = [];
  for (const row of rawCharacters) {
    const enumName = row.asset.replace(/CharacterConfigurationAsset$/, "");
    const classId = classes.nameToId[enumName];
    if (classId == null || enumName === "TestOnlyCharacter") continue;
    const statsNode = row.value.CharacterConfigurationValues;
    const desc = row.value.CharacterDescription || {};
    const basic = statsNode.BasicAttack | 0;
    const passiveIds = ints(statsNode.InnatePassives).filter((id) => id > 0);
    const activeIds = ints(statsNode.InnateActives).filter((id) => id > 0);
    const perkRows = perks(statsNode.SelectablePerks).filter((perk) => perk.level >= 0 && perk.level < 100);
    const title = zhId(desc.CharacterName) || zh(enumName);
    if (!title) continue;
    const originKey = textIds.map[String(desc.CharacterOrigin)] || "";
    const origin = originKey === "Invalid" || originKey === "InvalidString" ? "" : zh(originKey);
    const sheet = [];
    const addSheet = (name, value) => {
      if (value == null) return;
      const named = name === "Armor" ? zh("ArmorStat") : zh(name);
      const fromFormat = (zh("StatFormat" + name + "_1A") || "").replace(/\{0\}/g, "").replace(/[+%]/g, "").trim();
      const label = named && named.length <= 8 ? named : fromFormat;
      if (!label || !/[\u4e00-\u9fff]/.test(label) || label.length > 16) return;
      sheet.push({ label, value: String(value) });
    };
    addSheet("Health", typeof statsNode.Health === "number" ? statsNode.Health : null);
    addSheet("NormalDamage", round(fp(statsNode.NormalDamage)));
    addSheet("SpecialDamage", round(fp(statsNode.SpecialDamage)));
    addSheet("TrueDamage", round(fp(statsNode.TrueDamage)));
    addSheet("Armor", round(fp(statsNode.Armor)));
    addSheet("MagicResistance", round(fp(statsNode.MagicResistance)));
    addSheet("MovementSpeed", round(fp(statsNode.MoveSpeed)));
    const energyLabel = zh("Energy");
    if (energyLabel && energyLabel.length <= 8 && typeof statsNode.MaxEnergyStacks === "number") {
      sheet.push({ label: energyLabel, value: String(statsNode.MaxEnergyStacks) });
    }
    characters.push({
      id: enumName,
      classId,
      title,
      role: zhId(desc.RoleDescription),
      description: zhId(desc.CharacterDescription),
      strengths: zhId(desc.CharacterStrengths),
      weaknesses: zhId(desc.CharacterWeaknesses),
      origin,
      originDescription: zhId(desc.OriginDescription),
      quote: zhId(desc.OriginQuote),
      energy: keyText(row.value.EnergyDescription && row.value.EnergyDescription.TopTooltip),
      icon: iconFor(asString(row.value.CharSelectIconNameString) || "") || iconFor(asString(row.value.SmallIconNameString) || "") || iconFor(asString(row.value.CodexChampionIconNameString) || "") || null,
      locked: row.value.IsSelectionUnlocked ? "" : zh("UnlockCharInFullGame") || zh("CharLocked_FeatureToggle"),
      health: typeof statsNode.Health === "number" ? statsNode.Health : null,
      energyStacks: typeof statsNode.MaxEnergyStacks === "number" ? statsNode.MaxEnergyStacks : null,
      damage: round(fp(statsNode.NormalDamage)),
      specialDamage: round(fp(statsNode.SpecialDamage)),
      trueDamage: round(fp(statsNode.TrueDamage)),
      move: round(fp(statsNode.MoveSpeed)),
      armor: round(fp(statsNode.Armor)),
      resist: round(fp(statsNode.MagicResistance)),
      vision: round(fp(statsNode.VisionRange)),
      stats: sheet,
      basic,
      passives: passiveIds,
      actives: activeIds,
      perks: perkRows.map((perk) => ({
        ability: perk.ability,
        level: perk.level,
        item: perk.item,
        itemTitle: (itemById[perk.item] && itemById[perk.item].title) || "",
      })),
    });
  }
  characters.sort((a, b) => a.classId - b.classId);

  const used = new Set();
  for (const character of characters) {
    used.add(character.basic);
    for (const id of character.passives) used.add(id);
    for (const id of character.actives) used.add(id);
    for (const perk of character.perks) used.add(perk.ability);
  }

  const missingPhrases = new Set();
  function phrase(name, abilityTitle) {
    if (!name) return "";
    const accept = (text) => text && /[\u4e00-\u9fff]/.test(text) ? text : "";
    const format = accept(zh("StatFormat" + name + "_1A"));
    if (format && (format.includes("{0}") || format.length <= 40)) return format;
    const named = accept(zh(name));
    if (named && named.length <= 16) return named;
    const ability = accept(abilityTitle);
    if (ability && ability.length <= 40 && !/\{(?!0\})/.test(ability)) return ability;
    const stripped = name.replace(/Increase$/, "");
    if (stripped !== name) {
      const alt = accept(zh("StatFormat" + stripped + "_1A"));
      if (alt && alt.includes("{0}")) return alt;
    }
    const itemAbility = name.replace(/ItemAbility$/, "Ability");
    if (itemAbility !== name) {
      const alt = accept(zh("StatFormat" + itemAbility + "_1A"));
      if (alt) return alt;
    }
    const stem = name.replace(/(ItemAbility|ItemPassive|Ability|Buffs)$/, "");
    const aliases = {
      PvEMagicResistance: "StatFormatPvEMagicResistanceIncrease_1A",
      BossDamage: "StatFormatDamageVsBosses_1A",
      ConsumeFoodTier1Ability: "StatFormatFoodTier1ItemAbility",
      ConsumeFoodTier2Ability: "StatFormatFoodTier2ItemAbility",
      ConsumeFoodTier3Ability: "StatFormatFoodTier3ItemAbility",
      ConsumeTaintedAshcapAbility: "StatFormatTaintedAshcapItemAbility",
      ADStandingStillItemPassive: "StatFormatStandingADIncreaseOverTime_1A",
      APStandingStillItemPassive: "StatFormatStandingAPIncreaseOverTime_1A",
      PlaceFootballAbility: "StatFormatPlaceFootball",
      FrostFeatherFlyByItemAbility: "StatFormatFlyByAbility_1A",
      TemporaryHastePotionAbility: "ConsumableTemporaryHasteTier1",
      SlicerAxeAbility: "SlicerAbilityTier1",
      ActivatableAxeThrowAbility: "StatFormatAxeThrowAbility_1A",
      ActivatableMovementInvisibilityItemAbility: "StatFormatActivatableInvisibilityAbility_1A",
    };
    const keys = [
      aliases[name],
      stem + "AbilityTier1",
      stem + "Tier1",
      stem + "PassiveTier1",
      stem + "ItemDescription",
      stem + "_topTooltip",
      stem + "Buff_topTooltip",
      "StatFormat" + stem + "ItemAbility_1A",
      "StatFormat" + stem + "ItemAbility",
      "StatFormat" + stem + "Ability_1A",
    ];
    let best = "";
    for (const key of keys) {
      const text = key && accept(zh(key));
      if (!text || /\{(?!0\})/.test(text)) continue;
      if (!best || text.length < best.length) best = text;
    }
    if (best) return best;
    if (format && !/\{(?!0\})/.test(format)) return format;
    missingPhrases.add(name);
    return "";
  }
  function formatStat(text, min, max) {
    if (!text || !/[\u4e00-\u9fff]/.test(text)) return "";
    const left = round(min);
    const right = round(max);
    const value = left === right ? String(left) : left + "–" + right;
    if (text.includes("{0}")) return text.replace(/\{0\}/g, value);
    if (left === 1 && right === 1 && (text.length > 8 || text.includes("："))) return text;
    return value + " " + text.replace(/^\+\s*/, "");
  }
  function baseLines(rows) {
    return rows.map((row) => formatStat(phrase(statEnum.map[String(row.type)] || ""), row.min, row.max)).filter(Boolean);
  }
  function specialLines(rows) {
    return rows.map((row) => {
      const name = specials.map[String(row.type)] || "";
      const ability = abilityByName.get(name);
      const label = phrase(name, ability && ability.title);
      const granted = ability && label === ability.title && round(row.min) === 1 && round(row.max) === 1;
      return {
        text: granted ? ability.title : formatStat(label, row.min, row.max),
        skill: ability ? name : "",
      };
    }).filter((row) => row.text || row.skill);
  }

  const gearSkillNames = new Set();
  const gear = [];
  for (const row of rawGear) {
    const enumName = row.asset.replace(/ConfigurationAsset$/, "");
    const item = row.value.ItemConfiguration || {};
    const gearNode = row.value.GearItemConfiguration || {};
    const bits = maskOf(item.ItemCategoryMask);
    if ((bits & gearBits) === 0n) continue;
    const title = localized(row.value.NameLocalized) || zh(enumName);
    if (!title) continue;
    let slot = "";
    let slotKey = "";
    for (const [bit, key] of slotOrder) {
      if (bits & bit) {
        slotKey = key;
        slot = zh(key) || key;
        break;
      }
    }
    if (!slot) continue;
    const forced = specialLines(stats(gearNode.ForcedSpecialStats, 4));
    const pool = specialLines(stats(gearNode.SpecialStats, 4));
    for (const line of forced.concat(pool)) if (line.skill) gearSkillNames.add(line.skill);
    const required = ints(gearNode.RequiredClasses).map(className).filter((name) => name && name !== "None" && name !== "TestOnlyCharacter");
    const rarityId = item.ForcedRarity | 0;
    gear.push({
      id: item.ItemType,
      name: enumName,
      title,
      description: localized(row.value.DescriptionLocalized),
      icon: iconFor(asString(row.value.IconFileName) || "") || (itemById[item.ItemType] && itemById[item.ItemType].icon) || null,
      slot,
      slotKey,
      named: !!(bits & 16384n) || !!gearNode.IsNamedItem,
      rarity: rarityId > 0 ? rarityNames[rarityId - 1] || "" : "",
      classes: required.map((name) => zh(name) || name),
      classIds: required,
      base: baseLines(stats(gearNode.BaseStats, 0)),
      forced: forced.map((line) => line.text).filter(Boolean),
      forcedSkills: forced.map((line) => line.skill).filter(Boolean),
      pool: pool.map((line) => line.text).filter(Boolean),
      poolSkills: pool.map((line) => line.skill).filter(Boolean),
    });
  }

  for (const name of gearSkillNames) {
    const record = abilityByName.get(name);
    if (record) used.add(record.id);
  }

  const basicIds = new Set(characters.map((character) => character.basic));
  const skills = [];
  for (const record of abilityByName.values()) {
    const referenced = used.has(record.id);
    if (!referenced && !record.title) continue;
    const title = record.title || record.english;
    const invalidTitle = zh("InvalidString") || zh("Invalid");
    if (!title || (invalidTitle && title === invalidTitle)) continue;
    if (/药水|药剂/.test(title) || /Potion/.test(record.name)) continue;
    const kindKey = basicIds.has(record.id) || /BasicAttack/.test(record.name) ? "BasicAttack" : record.passive ? "Passive" : "Active";
    const kindRaw = zh(kindKey);
    const kind = kindRaw && kindRaw.length <= 12 ? kindRaw : "";
    const owners = characters.filter((character) => character.basic === record.id || character.passives.includes(record.id) || character.actives.includes(record.id) || character.perks.some((perk) => perk.ability === record.id)).map((character) => character.id);
    skills.push({
      id: record.id,
      name: record.name,
      title,
      kind,
      icon: record.icon,
      cooldown: record.cooldown,
      cast: record.cast,
      range: record.range,
      top: record.top,
      bottom: record.bottom,
      owners,
      fromGear: gearSkillNames.has(record.name),
    });
  }

  const skillById = new Map(skills.map((skill) => [skill.id, skill]));
  for (const character of characters) {
    const link = (id) => {
      const skill = skillById.get(id);
      return skill ? { id: skill.name, title: skill.title } : null;
    };
    character.basicSkill = link(character.basic);
    character.passiveSkills = character.passives.map(link).filter(Boolean);
    character.activeSkills = character.actives.map(link).filter(Boolean);
    character.perks = character.perks.map((perk) => {
      const skill = link(perk.ability);
      return skill ? { ...perk, id: skill.id, title: skill.title } : null;
    }).filter(Boolean);
    delete character.basic;
    delete character.passives;
    delete character.actives;
  }

  const labels = {
    base: zh("BaseStats"),
    special: zh("SpecialStats"),
    named: zh("NamedItem"),
    level: zh("Level"),
    cooldown: zh("CooldownZero_1A"),
    cast: zh("CastSpeed"),
    heroes: zh("Heroes") || zh("DifficultySelection_NameBreaker"),
    perks: zh("CharacterPerks") || zh("Perks"),
    random: zh("RandomStat"),
  };
  if (missingPhrases.size) console.log("unlabeled stats", [...missingPhrases].join(", "));

  return {
    characters,
    skills: skills.sort((a, b) => a.title.localeCompare(b.title, "zh-CN")),
    gear: gear.sort((a, b) => a.title.localeCompare(b.title, "zh-CN")),
    labels,
  };
}

module.exports = { collectCodex };
