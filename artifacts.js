const { extractNode } = require("./unityfs");

function read7(buf, o) {
  let value = 0;
  let shift = 0;
  for (let i = 0; i < 5; i++) {
    const byte = buf[o++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, o };
    shift += 7;
  }
  throw new Error("bad 7-bit int at " + o);
}

function readPack(data, at) {
  if (data.toString("ascii", at, at + 4) !== "HVPK") throw new Error("not an artifact pack");
  const headerSize = data.readUInt16LE(at + 6);
  const count = data.readUInt32LE(at + 8);
  let p = at + headerSize;
  const entries = [];
  for (let i = 0; i < count; i++) {
    const nameLen = data.readUInt16LE(p);
    p += 2;
    const name = data.toString("utf8", p, p + nameLen);
    p += nameLen;
    const offset = data.readUInt32LE(p);
    p += 4;
    const length = data.readUInt32LE(p);
    p += 4;
    entries.push({ name, offset, length });
  }
  return { at, entries };
}

function messagePackBytes(buf) {
  let o = 0;
  if (buf[o++] !== 0x91 || buf[o++] !== 0xdd) throw new Error("gameplay payload is not a byte array");
  const count = buf.readUInt32BE(o);
  o += 4;
  const out = Buffer.allocUnsafe(count);
  for (let i = 0; i < count; i++) {
    const tag = buf[o++];
    if (tag <= 0x7f) out[i] = tag;
    else if (tag === 0xcc || tag === 0xd0) out[i] = buf[o++];
    else throw new Error("unexpected messagepack tag " + tag.toString(16));
  }
  return out;
}

function envelopePayload(data, at) {
  if (data.toString("ascii", at, at + 4) !== "HVAF") throw new Error("not an artifact envelope");
  const headerSize = data.readUInt16LE(at + 6);
  const stored = Number(data.readBigUInt64LE(at + 44));
  return data.subarray(at + headerSize, at + headerSize + stored);
}

function readGameplay(bundle) {
  const node = bundle.nodes.find((item) => !item.path.includes("."));
  const data = extractNode(bundle, node);
  let packAt = 0;
  let pack = null;
  while ((packAt = data.indexOf("HVPK", packAt)) >= 0) {
    const candidate = readPack(data, packAt);
    if (!pack || candidate.entries.length > pack.entries.length) pack = candidate;
    packAt += 4;
  }
  const entry = pack.entries.find((item) => item.name === "SimulationGameplayConfiguration.bytes");
  if (!entry) throw new Error("missing SimulationGameplayConfiguration");
  const payload = envelopePayload(data, pack.at + entry.offset);
  const raw = messagePackBytes(payload);
  const records = [];
  let o = 0;
  while (o < raw.length) {
    const name = read7(raw, o);
    o = name.o;
    const asset = raw.toString("utf8", o, o + name.value);
    o += name.value;
    const id = raw.readInt32LE(o);
    const count = raw.readInt32LE(o + 12);
    o += 16;
    const parts = [];
    for (let i = 0; i < count; i++) {
      const type = read7(raw, o);
      o = type.o;
      const typeName = raw.toString("utf8", o, o + type.value);
      o += type.value;
      const size = raw.readInt32LE(o);
      o += 4;
      parts.push({
        type: typeName.split(",")[0].split(".").pop(),
        payload: raw.subarray(o, o + size),
      });
      o += size;
    }
    records.push({ asset, id, parts });
  }
  return records;
}

function part(record, type) {
  return record.parts.find((item) => item.type === type) || null;
}

function arrayNode(payload, offset, stride) {
  if (offset + 4 > payload.length) return { _length: 0, _fixedBuffer: { Value: [] } };
  const length = payload.readInt32LE(offset);
  const count = Math.max(0, Math.min(length, 256));
  const bytes = payload.subarray(offset + 4, offset + 4 + count * stride);
  return { _length: count, _fixedBuffer: { Value: [...bytes] } };
}

function fixed(payload, offset) {
  if (offset + 8 > payload.length) return 0;
  return Number(payload.readBigInt64LE(offset));
}

function ticks(payload, offset) {
  return { _deterministicValue: { Value: payload.readInt32LE(offset) } };
}

function codexObjects(records) {
  const objects = [];
  for (const record of records) {
    const active = part(record, "ActiveAbilityConfigurationValues");
    const passive = part(record, "PassiveAbilityConfigurationValues");
    if (active || passive) {
      const value = { m_Name: record.asset, Description: {} };
      if (active) {
        value.ActiveAbilityConfigurationValues = {
          CooldownSeconds: ticks(active.payload, 0),
          CastingTimeInSeconds: fixed(active.payload, 0x20),
          Range: fixed(active.payload, 0x38),
        };
      }
      if (passive) value.PassiveAbilityConfigurationValues = {};
      objects.push({ value });
    }
    const character = part(record, "CharacterConfigurationValues");
    if (character && character.payload.length >= 0x470) {
      const body = character.payload;
      objects.push({
        value: {
          m_Name: record.asset,
          IsSelectionUnlocked: body[0x4] !== 0,
          CharacterDescription: {},
          CharacterConfigurationValues: {
            BasicAttack: body.readInt32LE(0x10),
            InnatePassives: arrayNode(body, 0x118, 4),
            InnateActives: arrayNode(body, 0x19c, 4),
            SelectablePerks: arrayNode(body, 0x1e0, 12),
            NormalDamage: fixed(body, 0x428),
            SpecialDamage: fixed(body, 0x430),
            TrueDamage: fixed(body, 0x438),
            MoveSpeed: fixed(body, 0x440),
            Health: body.readInt32LE(0x448),
            Armor: fixed(body, 0x450),
            MagicResistance: fixed(body, 0x458),
            VisionRange: fixed(body, 0x468),
          },
        },
      });
    }
    const gear = part(record, "GearItemConfiguration");
    const item = part(record, "ItemConfiguration");
    if (gear && item && item.payload.length >= 0x44 && gear.payload.length >= 0x400) {
      objects.push({
        value: {
          m_Name: record.asset,
          ItemConfiguration: {
            ItemType: item.payload.readInt32LE(0),
            ItemCategoryMask: item.payload.readBigInt64LE(0x8),
            ForcedRarity: item.payload.readUInt16LE(0x42),
          },
          GearItemConfiguration: {
            IsNamedItem: gear.payload[0] !== 0,
            RequiredClasses: arrayNode(gear.payload, 0x4, 4),
            BaseStats: arrayNode(gear.payload, 0x10c, 24),
            SpecialStats: arrayNode(gear.payload, 0x190, 24),
            ForcedSpecialStats: arrayNode(gear.payload, 0x398, 24),
          },
        },
      });
    }
  }
  return objects;
}

module.exports = { readGameplay, part, codexObjects };
