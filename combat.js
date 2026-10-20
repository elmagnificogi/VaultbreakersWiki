const fs = require("fs");
const path = require("path");
const { parseUnityFS, extractNode } = require("./unityfs");
const { parseSerialized, readObject } = require("./serialized");

const ROOT = __dirname;
const GAME = path.resolve(ROOT, "..");
const BUNDLE_DIR = path.join(GAME, "Vaultbreakers_Data", "StreamingAssets", "aa", "StandaloneWindows64");
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

function utf8(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || !value.length || value.length > 8000) return "";
  if (!value.every((n) => typeof n === "number" && n >= 0 && n < 256)) return "";
  return Buffer.from(value).toString("utf8");
}

function displayText(value) {
  return String(value || "").replace(/<[^>]*>/g, "").replace(/\{@[^}]*\}/g, "").replace(/\s+/g, " ").trim();
}

class Reader {
  constructor(buf) {
    this.b = buf;
    this.p = 0;
  }
  byte() {
    const b = this.b[this.p++];
    if (b === 0xcc && this.b[this.p] >= 0x80) return this.b[this.p++];
    return b;
  }
  i32() {
    return this.byte() | (this.byte() << 8) | (this.byte() << 16) | (this.byte() << 24);
  }
  bytes(n) {
    const out = Buffer.alloc(n);
    for (let i = 0; i < n; i++) out[i] = this.byte();
    return out;
  }
  str7() {
    let len = 0;
    let shift = 0;
    for (;;) {
      const b = this.b[this.p++];
      len |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    const text = this.b.toString("utf8", this.p, this.p + len);
    this.p += len;
    return text;
  }
}

function round(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function fp(buf, offset) {
  return Number(buf.readBigInt64LE(offset)) / 65536;
}

function slots(buf, offset) {
  const count = buf.readInt32LE(offset);
  const ids = [];
  for (let i = 0; i < count && i < 32; i++) ids.push(buf.readInt32LE(offset + 4 + i * 4));
  return ids.filter((id) => id > 0);
}

const DAMAGE_FIELDS = {
  "HunterOrbValues": [[4,0,"MinDamage"],[276,0,"MaxDamage"]],
  "AirshipCaptainHookConfigurationValues": [[24,0,"Damage"]],
  "CorruptedDragonFireBreathConfigurationValues": [[0,1,"DamagePerProc"]],
  "CorruptedDragonFireLinesConfigurationValues": [[88,0,"Damage"]],
  "CorruptedDragonFireWallConfigurationValues": [[0,1,"TickDamage"]],
  "CorruptedDragonFlyBombardConfigurationValues": [[40,0,"ExplosionDamage"],[344,0,"BurnDamage"]],
  "CorruptedDragonPassiveConfigurationValues": [[1072,0,"DebrisDamage"]],
  "CorruptedDragonSlicingStormPassiveConfigurationValues": [[4,0,"Damage"]],
  "CorruptedDragonTailSwipeConfigurationValues": [[20,0,"Damage"]],
  "CorruptedDragonkinShieldFieryBlockConfigurationValues": [[20,0,"RetaliateDamage"]],
  "CorruptedDragonkinShieldFlameSwipeConfigurationValues": [[0,0,"Damage"]],
  "CorruptedDragonkinShieldShieldChargeConfigurationValues": [[32,0,"Damage"]],
  "CorruptedDragonkinShieldSlamConfigurationValues": [[0,0,"Damage"]],
  "DesertBeastShotAttackConfigurationValues": [[0,0,"DamageValues"]],
  "EliteBanditDaggerConeAttackConfigurationValues": [[0,0,"Damage"]],
  "EliteBanditDaggerThrowDaggersConfigurationValues": [[76,0,"Damage"]],
  "ActivatableAxeThrowConfigurationValues": [[32,0,"ProjectileDamageBase"]],
  "ActivatableEnergyProjectileConfigurationValues": [[24,0,"Damage"]],
  "ActivatableFireballConfigurationValues": [[32,0,"Damage"]],
  "ActivatableLightningConfigurationValues": [[36,0,"LightningDamage"]],
  "ActivatablePullNearbyConfigurationValues": [[4,0,"Damage"]],
  "ActivatableSelfExplodeConfigurationValues": [[4,0,"Damage"]],
  "ArcticEmbraceConfigurationValues": [[4,0,"Damage"]],
  "ArmoredSwarmerBasicAttackConfigurationValues": [[0,0,"Damage"]],
  "ArmoredSwarmerChargeAttackConfigurationValues": [[0,0,"Damage"]],
  "ArrowOfThornsConfigurationValues": [[28,0,"Damage"],[300,0,"AddedDamagePerMark"]],
  "AvalancheAxeAbilityConfigurationValues": [[0,0,"Damage"]],
  "BahraMoonBeamBarrageConfigurationValues": [[8,0,"ExplosionDamage"]],
  "BahraMoonMatchingConfigurationValues": [[44,0,"ExplosionDamage"]],
  "BahraVineLinesConfigurationValues": [[0,0,"VineDamage"]],
  "BanditAlericShotAttackConfigurationValues": [[0,0,"DamageValues"]],
  "BanditAlericVolleyAttackConfigurationValues": [[8,0,"ExplosionDamage"]],
  "BanditCrossbowShotAttackConfigurationValues": [[0,0,"DamageValues"]],
  "BanditCrossbowVolleyAttackConfigurationValues": [[8,0,"ExplosionDamage"]],
  "BanditDaggerConeAttackConfigurationValues": [[0,0,"Damage"]],
  "BanditDaggerThrowDaggersConfigurationValues": [[76,0,"Damage"]],
  "BanditKingConeAttackConfigurationValues": [[0,0,"Damage"]],
  "BanditKingThrowDaggersConfigurationValues": [[76,0,"Damage"]],
  "BarrelScratBasicAttackConfigurationValues": [[0,0,"Damage"]],
  "BarrelScratConeAttackConfigurationValues": [[0,0,"Damage"]],
  "BarrelScratSpinAttackConfigurationValues": [[16,1,"DamagePerTick"]],
  "BattleAxeAbilityConfigurationValues": [[4,0,"Damage"]],
  "BazookaScratBasicAttackConfigurationValues": [[0,0,"Damage"]],
  "BazookaScratFollowingAttackConfigurationValues": [[0,0,"Damage"]],
  "BearWanderingChargeConfigurationValues": [[0,0,"Damage"],[344,0,"StompDamage"]],
  "BearWanderingSwipeAttackConfigurationValues": [[0,0,"Damage"]],
  "BeastPoacherSkillShotConfigurationValues": [[0,0,"DamageValues"]],
  "BenevolentNatureConfigurationValues": [[0,0,"Damage"]],
  "BigKegConeAttackConfigurationValues": [[0,0,"Damage"]],
  "BlackWerewolfChargeConfigurationValues": [[0,0,"Damage"]],
  "BlackWerewolfSecondarySwipeAttackConfigurationValues": [[0,0,"Damage"]],
  "BlackWerewolfSwipeAttackConfigurationValues": [[0,0,"Damage"]],
  "BlastWandAbilityConfigurationValues": [[0,0,"Damage"],[288,0,"ConeDamage"]],
  "BlastWandPassiveConfigurationValues": [[16,0,"ConeDamage"]],
  "BloomBoomConfigurationValues": [[16,0,"Damage"]],
  "BlueBlazerFlameAttackConfigurationValues": [[8,0,"Damage"]],
  "BoulderThrowConfigurationValues": [[0,0,"Damage"]],
  "BrambleWallConfigurationValues": [[0,0,"Damage"],[272,0,"EmpoweredBonusDamage"]],
  "BrawlerBasicAttackConfigurationValues": [[0,0,"Damage"]],
  "BrawlerChargeAttackConfigurationValues": [[0,0,"Damage"]],
  "BrawlerConeAttackConfigurationValues": [[0,0,"Damage"]],
  "BurstDisruptConfigurationValues": [[4,0,"Damage"]],
  "ByAThousandCutsConfigurationValues": [[60,0,"MarkDamagePerDragonFly"]],
  "ChainChargeConfigurationValues": [[32,0,"Damage"]],
  "ChainLightningConfigurationValues": [[16,0,"Damage"]],
  "ChallengeChargeConfigurationValues": [[52,0,"ChargeDamage"],[332,0,"MinionBossDamage"]],
  "ChargedFlightConfigurationValues": [[0,0,"MaxAddedDamage"]],
  "ChilledConcussionConfigurationValues": [[4,0,"BaseDamage"]],
  "CircuitryStackConfigurationValues": [[4,0,"Damage"]],
  "ClusterbudConfigurationValues": [[8,0,"Damage"]],
  "ColdChargeConfigurationValues": [[68,0,"ChargeDamage"],[340,0,"StrikeDamage"],[620,0,"AreaDamage"]],
  "ColdSlamConfigurationValues": [[0,0,"BaseDamage"],[272,1,"AddedDamagePerSec"]],
  "CommandingFloraConfigurationValues": [[4,0,"Damage"]],
  "ConstructDecorationConfigurationValues": [[12,0,"Damage"]],
  "ConsumableBlinkStoneConfigurationValues": [[24,0,"ConsumableBlinkStoneDamage"]],
  "ConsumableLightningFlaskConfigurationValues": [[36,0,"LightningDamage"]],
  "CorruptedDragonkinCorruptionBombConfigurationValues": [[24,0,"Damage"]],
  "CorruptedDragonkinGuardCaptainBombardConfigurationValues": [[8,0,"ExplosionDamage"],[312,0,"BurnDamage"]],
  "CorruptedDragonkinGuardCaptainFireLinesBigConfigurationValues": [[88,0,"Damage"]],
  "CorruptedDragonkinSpearBombardConfigurationValues": [[8,0,"ExplosionDamage"],[312,0,"BurnDamage"]],
  "CorruptedDragonkinSpearFireLinesConfigurationValues": [[88,0,"Damage"]],
  "CorruptedDragonkinSpearFireLinesBigConfigurationValues": [[88,0,"Damage"]],
  "CorruptedDragonkinSpearFireWallConfigurationValues": [[0,1,"TickDamage"]],
  "CorruptedDragonkinSpearSpinConfigurationValues": [[8,0,"Damage"]],
  "CorruptedDragonkinSpearStabConfigurationValues": [[16,0,"Damage"]],
  "CrawlingMineExplosionConfigurationValues": [[4,0,"Damage"]],
  "CrispSlamConfigurationValues": [[4,0,"BonusDamage"]],
  "CruelCompanyConfigurationValues": [[8,1,"DamagePerInterval"]],
  "CutAndFlyConfigurationValues": [[16,0,"Damage"]],
  "DemonLordBasicAttackConfigurationValues": [[0,0,"Damage"]],
  "DemonLordConeAttackConfigurationValues": [[0,0,"Damage"]],
  "DemonLordExplosionAttackConfigurationValues": [[8,0,"BigExplosionDamage"],[296,0,"SmallExplosionDamage"]],
  "DemonSpiderConeAttackConfigurationValues": [[0,0,"Damage"]],
  "DesertBeastChargeAttackConfigurationValues": [[0,0,"Damage"]],
  "DesertBeastSweepAttackConfigurationValues": [[0,0,"Damage"]],
  "DesertSpiderlingConeAttackConfigurationValues": [[0,0,"Damage"]],
  "DisruptingShotConfigurationValues": [[24,0,"Damage"]],
  "DoubleDashConfigurationValues": [[0,0,"AddedDamage"]],
  "DruidBasicAttackConfigurationValues": [[0,0,"Damage"]],
  "DruidInnateConfigurationValues": [[20,0,"FlowerAttackDamage"]],
  "DruidSkillshotBasicAttackConfigurationValues": [[0,0,"HostileHitDamage"]],
  "ElectricBasiliskConfigurationValues": [[0,0,"AddedDamagePerOrb"]],
  "ElectricFormConfigurationValues": [[32,0,"OrbDamage"]],
  "ElectricTouchConfigurationValues": [[0,0,"Damage"]],
  "ElectricVortexConfigurationValues": [[8,0,"Damage"]],
  "EliteBanditCrossbowShotAttackConfigurationValues": [[0,0,"DamageValues"]],
  "EliteBanditCrossbowVolleyAttackConfigurationValues": [[8,0,"ExplosionDamage"]],
  "EliteBazookaScratFollowingAttackConfigurationValues": [[0,0,"Damage"]],
  "EliteDesertBeastChargeAttackConfigurationValues": [[0,0,"Damage"]],
  "EliteDesertBeastSweepAttackConfigurationValues": [[0,0,"Damage"]],
  "EliteDesertSpiderlingBasicAttackConfigurationValues": [[0,0,"DamageValues"]],
  "EliteDesertSpiderlingConeAttackConfigurationValues": [[0,0,"Damage"]],
  "EliteEnragedForestGolemSlamDownConfigurationValues": [[8,0,"Damage"]],
  "EliteImpBolterRocketBombardConfigurationValues": [[8,0,"ExplosionDamage"]],
  "EliteImpBolterSkillShotConfigurationValues": [[0,0,"DamageValues"]],
  "EliteNetterScratFollowingAttackConfigurationValues": [[4,0,"Damage"]],
  "EliteNetterScratSkillShotConfigurationValues": [[0,0,"DamageValues"]],
  "ElitePoisonSpiderlingBasicAttackConfigurationValues": [[0,0,"DamageValues"]],
  "ElitePoisonSpiderlingConeAttackConfigurationValues": [[0,0,"Damage"]],
  "EliteWerewolfElderChargeConfigurationValues": [[0,0,"Damage"]],
  "EliteWerewolfElderSwipeAttackConfigurationValues": [[0,0,"Damage"]],
  "EliteWolfBiteAttackConfigurationValues": [[0,0,"Damage"]],
  "EmeraldBarrageConfigurationValues": [[28,0,"Damage"],[300,0,"BonusRangeDamage"]],
  "EmpoweredEarthquakeConfigurationValues": [[8,0,"BonusDamage"]],
  "EmpoweredVortexConfigurationValues": [[8,0,"AdditionalDamage"]],
  "EngineerScratBasicAttackConfigurationValues": [[0,0,"Damage"]],
  "EngineerScratFlameAttackConfigurationValues": [[8,0,"Damage"]],
  "EntangleConfigurationValues": [[12,0,"DamagePerMark"]],
  "ExplodingDragonsConfigurationValues": [[8,0,"Damage"]],
  "ExplosiveBasicAttacksPassiveConfigurationValues": [[16,0,"Damage"]],
  "ExplosiveEmeraldBarrageConfigurationValues": [[0,0,"Damage"]],
  "FieldOfEnergyConfigurationValues": [[8,0,"Damage"]],
  "FinalChewChargeAttackConfigurationValues": [[0,0,"Damage"]],
  "FloralFinesseConfigurationValues": [[0,0,"ExplosionDamage"]],
  "ForestGolemSlamDownConfigurationValues": [[8,0,"Damage"]],
  "ForestGolemThrowRockConfigurationValues": [[0,0,"DamageValues"]],
  "ForgottenChampionKingThrowDaggersConfigurationValues": [[80,0,"Damage"]],
  "FrostBarbarianSkillShotBasicAttackConfigurationValues": [[32,0,"ConeBaseDamage"],[304,0,"ConeBonusDamageFromCharge"],[576,0,"ConeStunBonusDamage"]],
  "FrostNovaConfigurationValues": [[4,0,"Damage"]],
  "FrostSpinConfigurationValues": [[24,0,"Damage"]],
  "FrostbiteConfigurationValues": [[4,1,"DoTDamage"]],
  "FrozenSlamConfigurationValues": [[16,0,"Damage"]],
  "GardenRowConfigurationValues": [[24,0,"Damage"]],
  "GardenersCrookAbilityConfigurationValues": [[0,0,"Damage"]],
  "GhostBanditCrossbowShotAttackConfigurationValues": [[0,0,"DamageValues"]],
  "GhostBanditCrossbowVolleyAttackConfigurationValues": [[8,0,"ExplosionDamage"]],
  "GhostBanditDaggerConeAttackConfigurationValues": [[0,0,"Damage"]],
  "GhostBanditDaggerThrowDaggersConfigurationValues": [[80,0,"Damage"]],
  "GhostEliteBanditCrossbowVolleyAttackConfigurationValues": [[8,0,"ExplosionDamage"]],
  "GhostEliteWolfBiteAttackConfigurationValues": [[0,0,"Damage"]],
  "GhostWerewolfChargeConfigurationValues": [[0,0,"Damage"]],
  "GhostWerewolfSwipeAttackConfigurationValues": [[0,0,"Damage"]],
  "GiantRuptureConfigurationValues": [[0,0,"AddedRuptureDamage"]],
  "GreatBowAbilityConfigurationValues": [[0,0,"Damage"],[272,0,"EmpoweredDamage"]],
  "GreatBowPassiveConfigurationValues": [[0,0,"EmpoweredDamage"]],
  "GroveGrowthConfigurationValues": [[20,1,"DamagePerInterval"]],
  "HeartOfWinterConfigurationValues": [[0,0,"Damage"]],
  "HeavensWrathConfigurationValues": [[4,0,"Damage"],[276,0,"AddedDamagePerZap"]],
  "HuntingBowAbilityConfigurationValues": [[0,0,"Damage"]],
  "HydraShotConfigurationValues": [[36,0,"BaseDamage"]],
  "IceBlockConfigurationValues": [[16,0,"MinDamage"],[288,0,"BonusDamage"],[576,0,"MaxReturnDamage"]],
  "ImpBolterBasicAttackConfigurationValues": [[0,0,"Damage"]],
  "ImpBolterRocketBombardConfigurationValues": [[8,0,"ExplosionDamage"]],
  "ImpBolterSkillShotConfigurationValues": [[0,0,"DamageValues"]],
  "ImpPinnerNetherTearConfigurationValues": [[0,0,"Damage"]],
  "ImpPinnerPinConfigurationValues": [[40,0,"MinDamage"],[312,0,"MaxDamage"]],
  "JunkChopperBasicAttackConfigurationValues": [[0,0,"Damage"]],
  "JunkChopperChargeConfigurationValues": [[0,0,"Damage"]],
  "JunkChopperClusterBombConfigurationValues": [[0,0,"Damage"],[296,0,"MiniBombDamage"]],
  "KickbackConfigurationValues": [[0,0,"Damage"]],
  "LaserTurretLogicConfigurationValues": [[16,0,"Damage"]],
  "LeapingCurrentConfigurationValues": [[8,0,"DamageOnZap"]],
  "LightningBoltConfigurationValues": [[8,0,"BaseDamage"],[280,0,"AddedDamagePerZap"]],
  "LightningDragonConfigurationValues": [[4,0,"AddedDragonFlightDamage"]],
  "LightningMageSkillshotBasicAttackConfigurationValues": [[0,0,"HostileHitDamage"]],
  "LightningMonkBasicAttackConfigurationValues": [[0,0,"Damage"]],
  "LightningRodAbilityConfigurationValues": [[0,0,"Damage"]],
  "LongBowAbilityConfigurationValues": [[0,0,"Damage"],[272,0,"EmpoweredDamage"]],
  "LongBowPassiveConfigurationValues": [[0,0,"EmpoweredDamage"]],
  "LongerSparkFlightConfigurationValues": [[8,0,"AddedDamage"]],
  "MechSuitMajorFlamerChargeAttackConfigurationValues": [[0,0,"Damage"]],
  "MechSuitMajorFlamerFlameAttackConfigurationValues": [[8,0,"Damage"]],
  "MechSuitSawBasicAttackConfigurationValues": [[0,0,"Damage"]],
  "MechSuitSawBoosterChargeAttackConfigurationValues": [[0,0,"Damage"]],
  "MechSuitSawHookConfigurationValues": [[24,0,"Damage"]],
  "MechSuitSawSawShotConfigurationValues": [[0,0,"Damage"]],
  "MonkZipZapConfigurationValues": [[0,0,"AddedDamage"]],
  "MothAssaultConfigurationValues": [[40,0,"Damage"]],
  "NetterScratBasicAttackConfigurationValues": [[0,0,"Damage"]],
  "NetterScratFollowingAttackConfigurationValues": [[4,0,"Damage"]],
  "NetterScratSkillShotConfigurationValues": [[0,0,"DamageValues"]],
  "OldBearChargeConfigurationValues": [[0,0,"Damage"],[344,0,"StompDamage"]],
  "OldBearSwipeAttackConfigurationValues": [[0,0,"Damage"]],
  "PebbleGolemThrowRockConfigurationValues": [[0,0,"DamageValues"]],
  "PermafrostConfigurationValues": [[8,0,"DamageOnThreeStacks"]],
  "PiercingOvergrowthConfigurationValues": [[0,0,"Damage"],[272,0,"EmpoweredBonusDamage"]],
  "PinpointShotConfigurationValues": [[20,0,"BaseDamage"]],
  "PirateEngineerScratBasicAttackConfigurationValues": [[0,0,"Damage"]],
  "PoisonSpiderlingConeAttackConfigurationValues": [[0,0,"Damage"]],
  "PolaritySwitchConfigurationValues": [[4,0,"Damage"]],
  "PowerChopConfigurationValues": [[0,0,"Damage"],[272,0,"AddedFreezeDamage"]],
  "PowerDischargeConfigurationValues": [[24,0,"ProjectileDamage"]],
  "PowerStompConfigurationValues": [[0,0,"Damage"]],
  "PowerTransferConfigurationValues": [[0,0,"AddedDamageValues"]],
  "PowerVortexConfigurationValues": [[4,0,"ExplodeDamage"]],
  "RagerBasicAttackConfigurationValues": [[0,0,"Damage"]],
  "RagerWhirlConfigurationValues": [[8,0,"ConeMinDamage"],[280,0,"ConeMaxDamage"]],
  "RangerInnateConfigurationValues": [[28,0,"UniqueMarkDamage"]],
  "RangerSkillshotBasicAttackConfigurationValues": [[0,0,"HostileHitDamage"],[272,0,"MothMarkDamageBase"],[544,0,"MothMarkDamageBonus"]],
  "RapidBowAbilityConfigurationValues": [[4,0,"Damage"]],
  "RedbearChargeConfigurationValues": [[0,0,"Damage"],[336,0,"StompDamage"]],
  "RedbearSecondarySwipeAttackConfigurationValues": [[0,0,"Damage"]],
  "RedbearSwipeAttackConfigurationValues": [[0,0,"Damage"]],
  "RipperConfigurationValues": [[0,0,"AddedDamageToMinionOrAbove"]],
  "RootCageConfigurationValues": [[28,0,"Damage"],[300,0,"BonusDamage"],[584,0,"RecastDamage"]],
  "RuptureEchoConfigurationValues": [[0,0,"AddedEchoRuptureDamage"]],
  "ScrapScratBasicAttackConfigurationValues": [[0,0,"Damage"]],
  "ScrapScratConeAttackConfigurationValues": [[0,0,"Damage"]],
  "ScratMechSuitChargeAttackConfigurationValues": [[0,0,"Damage"]],
  "ScratMechSuitMiniBossFlameAttackConfigurationValues": [[8,0,"Damage"]],
  "ScratMechSuitMiniBossGrablinHookConfigurationValues": [[24,0,"Damage"]],
  "ScratMechSuitRocketBombardConfigurationValues": [[8,0,"ExplosionDamage"]],
  "ScratMechSuitRocketRainPassiveConfigurationValues": [[64,0,"ExplosionDamage"]],
  "SeismicChargesConfigurationValues": [[8,0,"Damage"]],
  "SelfRepairWagonRepairExplosionConfigurationValues": [[0,0,"Damage"]],
  "SharkBiteAttackConfigurationValues": [[0,0,"Damage"]],
  "SharkChargeAttackConfigurationValues": [[0,0,"Damage"]],
  "SharpLeavesConfigurationValues": [[0,0,"Damage"]],
  "SharsRakkCultistMasterNetherTearConfigurationValues": [[0,0,"Damage"]],
  "ShatterChargeConfigurationValues": [[52,0,"Damage"],[324,0,"ExtraDamageOnFreeze"]],
  "ShatterRuptureConfigurationValues": [[0,0,"Damage"]],
  "ShihouZapperInnateConfigurationValues": [[20,0,"OrbDamage"]],
  "ShootyFlowerConfigurationValues": [[60,0,"DefaultDamage"]],
  "ShrikePincherBasicAttackConfigurationValues": [[0,0,"Damage"]],
  "ShrikePincherDestroyConfigurationValues": [[0,0,"Damage"]],
  "ShrikePincherFlayConfigurationValues": [[8,0,"Damage"]],
  "ShrikePincherImpaleConfigurationValues": [[0,0,"Damage"]],
  "SlicerAbilityConfigurationValues": [[0,0,"Damage"],[272,0,"AddedVulnerableDamage"]],
  "SoaringStrikeConfigurationValues": [[88,0,"Damage"]],
  "SparkBallConfigurationValues": [[4,0,"Damage"],[276,0,"AddedDamageIfZapped"]],
  "SparkFlightConfigurationValues": [[32,0,"SparkFlightDamage"]],
  "SpiderlingBasicAttackConfigurationValues": [[0,0,"Damage"]],
  "SpiderlingConeAttackConfigurationValues": [[0,0,"Damage"]],
  "StaffSuccubusBansheeScreamConfigurationValues": [[0,0,"Damage"]],
  "StaffSuccubusBasicAttackConfigurationValues": [[16,0,"Damage"]],
  "StaffSuccubusDeathstepConfigurationValues": [[20,0,"AoEDamage"]],
  "StaticOrbsConfigurationValues": [[4,0,"Damage"]],
  "StonebearChargeConfigurationValues": [[0,0,"Damage"],[344,0,"StompDamage"]],
  "StonebearSecondarySwipeAttackConfigurationValues": [[0,0,"Damage"]],
  "StonebearSwipeAttackConfigurationValues": [[0,0,"Damage"]],
  "StormcallerConfigurationValues": [[0,0,"Damage"],[288,0,"DamageWithAHThreshold"]],
  "StoutheartInnateConfigurationValues": [[8,0,"BasicAttackMinDamage"],[280,0,"BasicAttackMaxDamage"]],
  "SwarmerBasicAttackConfigurationValues": [[0,0,"Damage"]],
  "SwarmerChargeAttackConfigurationValues": [[0,0,"Damage"]],
  "SweepConfigurationValues": [[8,0,"Damage"]],
  "TeleporterBasicAttackConfigurationValues": [[0,0,"Damage"]],
  "TeleporterBeamConfigurationValues": [[4,0,"BaseDamage"],[276,1,"AddedDamagePerSecond"]],
  "TeleporterTeleportAttackConfigurationValues": [[8,0,"Damage"]],
  "TheBiggerTheyAreConfigurationValues": [[16,0,"MaxDamage"]],
  "ThrowapultConfigurationValues": [[40,0,"Damage"]],
  "ThunderStormConfigurationValues": [[4,0,"Damage"]],
  "ToTheKneeConfigurationValues": [[8,1,"DamagePerTick"]],
  "TooBeautifulConfigurationValues": [[8,0,"Damage"]],
  "TravelingMothConfigurationValues": [[24,0,"Damage"]],
  "VaultConfigurationValues": [[0,0,"Damage"]],
  "VeiledAmbushConfigurationValues": [[8,0,"Damage"]],
  "VerdantShotConfigurationValues": [[360,0,"HostileHitMinDamage"],[632,0,"HostileHitBonusDamage"],[904,0,"MarkBonusDamage"]],
  "VindictiveAimConfigurationValues": [[24,0,"Damage"]],
  "VineZombieAttackConfigurationValues": [[0,0,"Damage"]],
  "VineZombieDeathContaminationPassiveConfigurationValues": [[0,0,"BurnDamage"]],
  "VoidClericBasicAttackConfigurationValues": [[0,0,"Damage"]],
  "VoidClericDarkArcConfigurationValues": [[4,0,"FirstAreaDamage"],[308,0,"SecondAreaDamage"]],
  "VoidClericHeartpiercerChannelConfigurationValues": [[4,0,"Damage"],[276,0,"EndDamage"]],
  "VoidClericHeartpiercerProjectileConfigurationValues": [[0,0,"Damage"]],
  "VoltaicTerminationConfigurationValues": [[12,0,"ExplosionDamage"]],
  "WerewolfChargeConfigurationValues": [[0,0,"Damage"]],
  "WerewolfMageHowlyRootCageConfigurationValues": [[8,0,"ExplosionDamage"]],
  "WerewolfMageHowlyVineAttackConfigurationValues": [[8,0,"ExplosionDamage"]],
  "WerewolfMageRootCageConfigurationValues": [[8,0,"ExplosionDamage"]],
  "WerewolfMageTentacleSummonConfigurationValues": [[28,0,"TentacleDamage"]],
  "WerewolfMageVineAttackConfigurationValues": [[8,0,"ExplosionDamage"]],
  "WerewolfOneEyeSwipeConfigurationValues": [[68,0,"Damage"]],
  "WerewolfOneEyeTentacleSlapConfigurationValues": [[16,0,"Damage"]],
  "WerewolfSecondarySwipeAttackConfigurationValues": [[0,0,"Damage"]],
  "WerewolfSwipeAttackConfigurationValues": [[0,0,"Damage"]],
  "WidowBasicAttackConfigurationValues": [[0,0,"Damage"]],
  "WidowCocoonChargeConfigurationValues": [[0,0,"Damage"]],
  "WidowDropInConfigurationValues": [[4,0,"Damage"]],
  "WidowPincerChargeConfigurationValues": [[0,0,"Damage"]],
  "WidowSpiderWaveConfigurationValues": [[12,1,"TickDamage"],[284,0,"BurstDamage"]],
  "WildSwingConfigurationValues": [[24,0,"ChargeSwingMinDamage"],[296,0,"ChargeSwingBonusDamage"]],
  "WolfBiteAttackConfigurationValues": [[0,0,"Damage"]],
  "WolfSharptoothBiteAttackConfigurationValues": [[0,0,"Damage"]],
  "WoodCutterAbilityConfigurationValues": [[0,0,"Damage"]],
  "WorldRootAbilityConfigurationValues": [[0,0,"Damage"]],
  "WreckTitanCoilAttackConfigurationValues": [[0,0,"Damage"]],
  "WreckTitanStompConfigurationValues": [[4,0,"Damage"]],
  "WreckingBallConfigurationValues": [[4,0,"AddedDamage"]],
  "ZapBangConfigurationValues": [[24,0,"Damage"],[296,0,"AddedDamageIfZapped"]],
  "GiantSnowballConfigurationValues": [[72,0,"BaseSnowBallDamage"],[344,0,"BonusSnowballDamage"],[624,0,"EndExplosionDamage"]],
  "JunkChopperSlamAttackConfigurationValues": [[0,0,"Damage"]],
  "NecronusDebrisConfigurationValues": [[16,0,"ImpactDamage"]],
  "NecronusGraveWaveConfigurationValues": [[4,0,"DamageValues"]],
  "NecronusNecroticSpearAttackConfigurationValues": [[0,0,"DamageValues"]],
  "NecronusTeleportNovaConfigurationValues": [[32,0,"ProjectileDamageValues"]],
  "NecronusTombstonePassiveConfigurationValues": [[12,0,"ProjectileDamageValues"]],
  "PirateSniperBasicAttackConfigurationValues": [[0,0,"DamageValues"]],
  "RagerRetaliateConfigurationValues": [[0,0,"Damage"]],
  "SelfRepairWagonLaserShotConfigurationValues": [[0,0,"Damage"]],
  "SharkJumpAttackConfigurationValues": [[24,0,"LandingDamage"]],
  "SniperCommandoBasicAttackConfigurationValues": [[0,0,"DamageValues"]],
  "SniperCommandoSnipeAttackConfigurationValues": [[0,0,"DamageValues"]],
  "SurgeDischargeConfigurationValues": [[28,0,"ExplosionDamage"],[300,0,"ChargeDamage"],[572,0,"OrbDamage"]],
  "WolfBiteAttackHomingConfigurationValues": [[0,0,"Damage"]],
  "WreckTitanManyBurningRocketsConfigurationValues": [[32,0,"BurnDamage"]],
  "CurseOfTheImpsBuffConfigurationValues": [[24,0,"Damage"]],
  "ElectrocuteConfigurationValues": [[0,0,"Damage"]],
  "EmpoweredDragonFlyConfigurationValues": [[0,0,"AddedDamage"]],
  "MageZapConfigurationValues": [[0,0,"ReapplyZapDamage"]],
  "RagerFreezeConfigurationValues": [[8,0,"TriggerDamage"]],
  "ActivatableNecroticConfigurationValues": [[0,0,"DamageValues"]],
  "BlueBlazerDemolisticDemiseConfigurationValues": [[16,0,"ExplosionDamage"]],
  "BowConfigurationValues": [[0,0,"Damage"],[276,0,"EmpoweredDamage"]],
  "CorruptedDragonConeAttackConfigurationValues": [[0,0,"Damage"]],
  "CorruptedDragonCorruptionBombConfigurationValues": [[56,0,"Damage"]],
  "CorruptedDragonkinGuardCaptainFieryBlockConfigurationValues": [[20,0,"RetaliateDamage"]],
  "CorruptedDragonkinGuardCaptainFlameSwipeConfigurationValues": [[0,0,"Damage"]],
  "CorruptedDragonkinGuardCaptainSlamConfigurationValues": [[0,0,"Damage"]],
  "EarthquakeConfigurationValues": [[308,0,"SlamDamage"]],
  "EliteBazookaScratBasicAttackConfigurationValues": [[0,0,"DamageValues"]],
  "EliteBazookaScratSecondaryBasicAttackConfigurationValues": [[0,0,"DamageValues"]],
  "EliteEnragedForestGolemEarthquakeConfigurationValues": [[16,0,"OuterDonutDamage"],[288,0,"InnerDonutDamage"]],
  "EngineerScratDemolisticDemiseConfigurationValues": [[16,0,"ExplosionDamage"]],
  "ForestGolemEarthquakeConfigurationValues": [[16,0,"OuterDonutDamage"],[288,0,"InnerDonutDamage"]],
  "FrostFeatherFlyByConfigurationValues": [[40,0,"FrostFeatherDamage"]],
  "FuelSpraySystemConfigurationValues": [[8,0,"PlayerDamage"],[280,0,"EnemyDamage"]],
  "LeapOfLegendConfigurationValues": [[24,0,"LandingDamage"]],
  "MegaPebbleGolemThrowRockConfigurationValues": [[0,0,"DamageValues"],[364,0,"ExplosionDamageValues"]],
  "PirateBazookaScratBasicAttackConfigurationValues": [[0,0,"DamageValues"]],
  "PirateBazookaScratFollowingAttackConfigurationValues": [[0,0,"Damage"]],
  "PirateBazookaScratSecondaryBasicAttackConfigurationValues": [[0,0,"DamageValues"]],
  "PirateEngineerScratDemolisticDemiseConfigurationValues": [[16,0,"ExplosionDamage"]],
  "PirateEngineerScratFlameAttackConfigurationValues": [[8,0,"Damage"]],
  "RagerSkillshotBasicAttackConfigurationValues": [[16,0,"Damage"]],
  "RangerSkillshotBasicAttackChargedConfigurationValues": [[0,0,"ProjectileDamageBase"],[272,0,"MothMarkDamageBase"],[544,0,"MothMarkDamageBonus"],[816,0,"ChargedBonusDamage"]],
  "RockSpikeConfigurationValues": [[16,0,"Damage"]],
  "SelfRepairWagonBasicAttackConfigurationValues": [[0,0,"Damage"]],
  "SelfRepairWagonFieldOfCurrentConfigurationValues": [[12,1,"DoTDamage"]],
  "SelfRepairWagonPowerZapConfigurationValues": [[0,0,"Damage"]],
  "SniperScratBasicAttackConfigurationValues": [[0,0,"DamageValues"]],
  "SniperScratSnipeAttackConfigurationValues": [[0,0,"DamageValues"]],
  "StormZoneSetupConfigurationValues": [[40,0,"LightningDamage"]],
  "TauntingBlowConfigurationValues": [[8,0,"Damage"]],
  "TrainConfigurationValues": [[24,0,"CollisionDamage"]],
  "UnstableElementalCrystalConfigurationValues": [[32,0,"Damage"]],
  "WandConfigurationValues": [[0,0,"Damage"],[296,0,"ConeDamage"]],
  "WreckTitanArmAttackConfigurationValues": [[0,0,"Damage"]],
  "WreckTitanBurningRocketsConfigurationValues": [[8,0,"BurnDamage"]],
  "WreckTitanFinalFireConfigurationValues": [[0,0,"Damage"]],
  "WreckTitanLaserShotConfigurationValues": [[0,0,"Damage"]],
};

function readHits(blob, base, tick) {
  if (!blob || blob.length < base + 16) return [];
  const count = blob.readInt32LE(base + 4);
  if (count <= 0 || count > 4) return [];
  const hits = [];
  for (let i = 0; i < count; i++) {
    const offset = base + 8 + i * 32;
    if (offset + 16 > blob.length) break;
    const type = blob.readInt32LE(offset);
    const amount = round(fp(blob, offset + 8));
    const kind = type === 0 ? "物理" : type === 1 ? "魔法" : type === 2 ? "真实" : "";
    if (!kind || !(amount > 0)) continue;
    const hit = { kind, amount };
    if (tick) hit.tick = true;
    hits.push(hit);
  }
  return hits;
}

function hitsOf(blob) {
  if (!blob || blob.length < 8) return [];
  const count = blob.readInt32LE(0);
  if (count <= 0 || count > 4) return [];
  const hits = [];
  for (let i = 0; i < count; i++) {
    const offset = 4 + i * 32;
    if (offset + 16 > blob.length) break;
    const type = blob.readInt32LE(offset);
    const amount = round(fp(blob, offset + 8));
    const kind = type === 0 ? "物理" : type === 1 ? "魔法" : type === 2 ? "真实" : "";
    if (!kind || !(amount > 0)) continue;
    hits.push({ kind, amount });
  }
  return hits;
}

function damageHits(record) {
  const raw = [];
  for (const value of record.values) {
    const specs = DAMAGE_FIELDS[value.type];
    if (!specs) continue;
    for (const [offset, tick, field] of specs) {
      for (const hit of readHits(value.blob, offset, tick)) raw.push(Object.assign({ field }, hit));
    }
  }
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const hit = raw[i];
    if (/Max/.test(hit.field) && raw.some((other) => other.field === hit.field.replace("Max", "Min"))) continue;
    const item = { kind: hit.kind, amount: hit.amount };
    if (hit.tick) item.tick = true;
    if (/Min/.test(hit.field)) {
      const partner = raw.find((other) => other.field === hit.field.replace("Min", "Max") && other.kind === hit.kind);
      if (partner) {
        item.amount = Math.min(hit.amount, partner.amount);
        item.max = Math.max(hit.amount, partner.amount);
        if (item.max === item.amount) delete item.max;
      }
    }
    out.push(item);
  }
  if (out.length) return out;
  const damage = record.values.find((value) => value.type === "AbilityDealDamageParameters");
  return hitsOf(damage && damage.blob);
}

function timingOf(blob) {
  if (!blob || blob.length < 0x48) return {};
  const seconds = (ticks) => (ticks > 0 ? round(ticks / 30) : null);
  const random = blob[0x10] !== 0;
  const steady = seconds(blob.readInt32LE(0x0c));
  const min = seconds(blob.readInt32LE(0x14));
  const max = seconds(blob.readInt32LE(0x18));
  let cooldown = random ? max || min : steady;
  if (random && min && max && min !== max) cooldown = [min, max];
  const range = round(fp(blob, 0x40));
  return { cooldown, range: range > 0 ? range : null };
}

function gameplayBytes() {
  const file = bundleForAddress("Artifacts.artifactpack.bytes");
  const bundle = parseUnityFS(fs.readFileSync(path.join(BUNDLE_DIR, file)));
  const node = bundle.nodes.slice().sort((a, b) => b.size - a.size)[0];
  const data = extractNode(bundle, node);
  let at = 0;
  while ((at = data.indexOf("HVPK", at)) >= 0) {
    const pack = data.subarray(at);
    if (pack.readUInt16LE(4) !== 1) {
      at += 4;
      continue;
    }
    const count = pack.readUInt32LE(8);
    let o = 16;
    let found = null;
    for (let i = 0; i < count; i++) {
      const nameLen = pack.readUInt16LE(o);
      o += 2;
      const name = pack.toString("utf8", o, o + nameLen);
      o += nameLen;
      const offset = pack.readUInt32LE(o);
      o += 4;
      const size = pack.readUInt32LE(o);
      o += 4;
      if (name === "SimulationGameplayConfiguration.bytes") found = pack.subarray(offset, offset + size);
    }
    if (found && found.slice(0, 4).toString("ascii") === "HVAF") return found.subarray(found.readUInt16LE(6) + 6);
    at += 4;
  }
  throw new Error("missing gameplay configuration");
}

function readRecords(body) {
  const reader = new Reader(body);
  const records = [];
  while (reader.p < body.length) {
    const name = reader.str7();
    const id = reader.i32();
    reader.bytes(8);
    const count = reader.i32();
    const values = [];
    for (let i = 0; i < count; i++) {
      const typeLen = reader.byte();
      reader.byte();
      const typeName = reader.b.toString("utf8", reader.p, reader.p + typeLen).split(",")[0].split(".").pop();
      reader.p += typeLen;
      values.push({ type: typeName, blob: reader.bytes(reader.i32()) });
    }
    records.push({ name, id, values });
  }
  return records;
}

function chineseByKey() {
  const sharedName = bundleForAddress("Assets/Core/Localization/Data/Tables/DefaultStrings Shared Data.asset");
  const shared = loadBundle(sharedName);
  const sharedSf = parseSerialized(extractNode(shared, shared.nodes.find((n) => !n.path.includes("."))));
  const keyToId = new Map();
  for (const obj of sharedSf.objects) {
    const typ = sharedSf.types[obj.typeId];
    if (!typ || !typ.node || !typ.node.children || !typ.node.children.some((child) => child.name === "m_TableCollectionName")) continue;
    let parsed;
    try {
      parsed = readSharedKeys(sharedSf, obj);
    } catch {
      continue;
    }
    if (parsed.collection !== "DefaultStrings") continue;
    for (const [key, id] of parsed.keyToId) keyToId.set(key, id);
  }
  const zhName = bundleForAddress("DefaultStrings_zh");
  const zh = loadBundle(zhName);
  const zhSf = parseSerialized(extractNode(zh, zh.nodes.find((n) => !n.path.includes("."))));
  const raw = new Map();
  for (const obj of zhSf.objects) {
    let value;
    try {
      value = readObject(zhSf, obj).value;
    } catch {
      continue;
    }
    if (utf8(value["#427"]) !== "DefaultStrings_zh") continue;
    for (const row of value.m_TableData || []) {
      const text = utf8(row.m_Localized);
      if (text) raw.set(String(row.m_Id), text);
    }
  }
  const byKey = new Map();
  for (const [key, id] of keyToId) {
    const text = displayText(raw.get(String(id)) || "");
    if (text) byKey.set(key, text);
  }
  return byKey;
}

function loadBundle(name) {
  return parseUnityFS(fs.readFileSync(path.join(BUNDLE_DIR, name)));
}

function readSharedKeys(sf, obj) {
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

function abilityTitle(stem, byKey) {
  const keys = [stem, stem + "_topTooltip", stem.replace(/Attack$/, ""), stem.replace(/BasicAttack$/, "")];
  for (const key of keys) {
    const text = byKey.get(key);
    if (!text || !/[\u4e00-\u9fff]/.test(text) || text.length > 12 || /[。，]/.test(text)) continue;
    return text;
  }
  return "";
}

function describeAttack(record, byKey) {
  const stem = record.name.replace(/ConfigurationAsset$/, "");
  const active = record.values.find((value) => value.type === "ActiveAbilityConfiguration");
  const hits = damageHits(record);
  const title = abilityTitle(stem, byKey);
  if (!hits.length && !title) return null;
  const timing = timingOf(active && active.blob);
  const attack = { title, hits };
  if (timing.cooldown != null) attack.cooldown = timing.cooldown;
  if (timing.range != null) attack.range = timing.range;
  return attack;
}

function attachCombat(sources) {
  const records = readRecords(gameplayBytes());
  const byName = new Map(records.map((record) => [record.name, record]));
  const byId = new Map(records.map((record) => [record.id, record]));
  const byKey = chineseByKey();
  let linked = 0;
  let titled = 0;
  let magic = 0;
  for (const source of sources) {
    if (source.category !== "怪物") continue;
    delete source.combat;
    const unit = byName.get(source.asset);
    const values = unit && unit.values.find((value) => value.type === "UnitConfigurationValues");
    if (!values) continue;
    const attacks = [];
    for (const id of slots(values.blob, 0xd0)) {
      const ability = byId.get(id);
      if (!ability) continue;
      const attack = describeAttack(ability, byKey);
      if (!attack) continue;
      if (attack.title) titled++;
      if (attack.hits.some((hit) => hit.kind === "魔法")) magic++;
      attacks.push(attack);
    }
    source.combat = {
      health: round(fp(values.blob, 0x18)),
      armor: 0,
      resist: 0,
      attacks,
    };
    linked++;
  }
  console.log("combat", linked, "named attacks", titled, "magic attacks", magic);
}

module.exports = { attachCombat, readRecords, gameplayBytes, chineseByKey };
