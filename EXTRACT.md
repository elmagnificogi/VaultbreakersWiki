# Vaultbreakers Demo 掉落 wiki 提取说明

给下次更新本地掉落 wiki 用。以 `loot-wiki` 里的代码为准，不要凭记忆改行为。地图旋转和区域轮廓可能还在改，第 9 节标了「若代码已经写入则以代码为准」的地方，动手前再读一遍 `maps.js` 和 `extract.js` 里的 `writeHtml`。

不要改这份说明以外的事来「顺便修」。尤其不要改正在被别人改的地图文件，除非那次任务就是你的。

## 环境

- 游戏目录：`D:\Steam\steamapps\common\Vaultbreakers Demo`
- wiki 目录：同目录下的 `loot-wiki`
- 引擎：Unity `6000.3.18f1`（exe 的 ProductVersion 也是这个，这是引擎版本）
- IL2CPP metadata：`Vaultbreakers_Data/il2cpp_data/Metadata/global-metadata.dat`，magic `0xFAB11BAF`，version **39**
- Addressables：**2.9.1**，写在 `Vaultbreakers_Data/StreamingAssets/aa/settings.json` 的 `m_AddressablesVersion`
- 已有 IL2CPP dump：`loot-wiki/il2cpp/dump.cs`。不要重新 dump
- 工具：Node v22，依赖只有 `lz4js`、`pngjs`（见 `package.json`）。没有 Python，没有 .NET SDK
- PowerShell 不能用 `&&` 把命令串起来。用 `>` 重定向文本会写成 UTF-16。要写 UTF-8 文件就用 Node 的 `fs`，不要用 PowerShell 重定向

公司名和产品名在 `Vaultbreakers_Data/app.info`：`BetaDwarf ApS` / `Vaultbreakers`。

## 1. 怎么重新生成

在 `loot-wiki` 目录执行：

```
node extract.js
```

`extract.js` 末尾直接调用 `main()`。页面只能由 `extract.js` 的 `writeHtml` 生成。不要手改 `index.html`。

一次运行会写出：

- `index.html`：整页，数据嵌在 `<script id="db" type="application/json">`
- `data/db.json`：同一份数据

另外会按需写出 `icons/*.png` 和 `maps/<id>.png`。这两个目录里**已经存在的文件会被跳过**，见第 5、9、10 节。不要为了「刷新页面」去转已经落地的图。

`GAME` 是 `loot-wiki` 的上一级。配置、图标、中文、共享字符串都从：

`Vaultbreakers_Data/StreamingAssets/aa/StandaloneWindows64/`

按文件名读取。当前写死的四个包：

| 常量 | 文件 |
| --- | --- |
| `CONFIG_BUNDLE` | `0563f413959c8f3465f5b3d19fece440.bundle` |
| `ICON_BUNDLE` | `d690eafe8fe5a7e08f9f6fa44534a52e.bundle` |
| `ZH_BUNDLE` | `4ce0a894b5e7192d33184335bd5bec42.bundle` |
| `SHARED_STRINGS_BUNDLE` | `0be045fb94ecb50bb5159a32ba66c0a4.bundle` |

场景包和小地图贴图包不在这张表里，在 `maps.js` 的 `MAP_DEFS`。

## 2. 包怎么解

格式是 UnityFS，本游戏是 version 8。`unityfs.js` 的 `parseUnityFS` 读大端文件头：签名、version、unityVersion、revision、总大小、blocks info 压缩大小、解压大小、flags。version ≥ 7 时头要对齐到 16。

flags `0x243` 的拆法（和 `unityfs.js` 的掩码一致）：

- `flags & 0x3f` = `3`：blocks info 是 lz4（压缩类型 2 或 3 都走 `lz4.decompressBlock`；0 是不压缩）
- `0x40`：blocks 和 directory info 合在一起
- `0x200`：数据起点要再对齐到 16（`padAtStart`）
- `0x80` 才表示 blocks info 在文件末尾

`0x243` 不含 `0x80`，所以 info 在文件头后面，不是在末尾。解压后 info 从偏移 16 开始（前面 16 字节是 hash），然后是 block 表和 node 表。节点路径形如 `CAB-<guid>`，贴图流数据常在同包的 `*.resS`。

`maps.js` 的 `bundleInfo` 只解 info，不把整包数据拼起来。场景 bundle 很大（狼林场景包大约 561MB），只用 `extractRange(buf, info, start, size)` 按块解压需要的那一段。不要对场景包调用 `parseUnityFS`。

`extract.js` 的配置包、图标包、中文包、共享字符串包用 `parseUnityFS` + `extractNode`，因为它们小得多。各包要打开的节点：

- 配置包：路径以 `.sharedAssets` 结尾的节点
- 图标包、中文包：路径里没有 `.` 的那个节点；图标像素在 `.resS`
- 共享字符串包：节点路径必须是 `CAB-51fbaa50979881bfde5cd85c584e1d3c`

`extract.js` 现在不读 catalog，包名是写死的。以后如果要按 Addressables 地址找包，catalog 在：

`Vaultbreakers_Data/StreamingAssets/aa/catalog.bin`

已核对的文件头（小端）：

- 偏移 0：magic `0x0DE38942`
- 偏移 4：version `2`
- 偏移 8 的值是 `36`，keys 从文件偏移 36 开始

找资产 bundle 的规则：一个地址的**第一个依赖**才是资产 bundle。prefab 的 InternalId 经常只是 GUID。真正的文件名是依赖列表里**第一个以 `.bundle` 结尾**的那条。磁盘上的路径形态是 `{UnityEngine.AddressableAssets.Addressables.RuntimePath}\StandaloneWindows64\<hash>.bundle`。

贴图像素用 `dxt.js` 的 `decodeTexture`：

- format `10`：DXT1
- format `12`：DXT5
- format `4`：裸 RGBA32
- 其他格式返回 `null`，调用处会跳过

Unity 贴图原点在左下，写 PNG 时要先做一次 180° 翻转才是正的。这一步已经在写新文件时做过。见第 9、10 节，不要对已有文件再翻。

## 3. 序列化数据

`serialized.js`。`parseSerialized` 读 Unity serialized 文件头；version ≥ 22 时 metadataSize / fileSize / dataOffset 用后面的 32 位和 64 位字段。本游戏数据是小端。类型树在 version ≥ 23 时包在 `mhtt` blob 里。

公共串表 `COMMON` 用的是字符串在公共 blob 里的**字节偏移**，不是从 0 数的序号。表里偏移 **159** 的名字是 `float`。本游戏类型树里的 float 公共串是 **#161**。`COMMON` 没有 161 这一项，`strOf` 会得到字面量 `"#161"`。

`readPrimitive` 只在类型名恰好是 `float` 或 `double` 时按浮点读。`#161` 的 `byteSize === 4` 会走 `i32()`。所以地图坐标在 `maps.js` 里用 `asFloat`：`writeInt32LE` 再 `readFloatLE`，把已经读成整数的位型重解释成 float。已经是有限小数的数会原样返回。**不要为了地图去改 `readPrimitive`。** 配置包里大量真正的 int 字段也是 4 字节，全局改成 float 会把掉落表读坏。

其他约定：

- `byteSize === 8` 的标量读成 int64，再 `.toString()`。共享字符串 id、`PPtr.pathId`、中文表 `m_Id` 都是这种字符串，比较时不要改回 number
- `string` 是 int32 长度 + UTF-8，然后对齐到 4
- `PPtr` 是 `m_FileID`（int32）+ `m_PathID`（int64 字符串）
- 对齐标志 `meta & 0x4000` 时字段后对齐到 4
- GameObject 的名字字段解析出来是 **`#427`**（不是 `m_Name`）。图标名、场景物体名都读这个字段
- Transform 的 `classId` 是 **4**，GameObject 的 `classId` 是 **1**
- 场景里 Transform 指向 GameObject 的字段是 **`#374`**（公共串里的 `m_GameObject` 登记在偏移 372，场景类型树用的是 `#374`）
- `m_Father.pathId` 为 `"0"` 表示根，不要再往上走

贴图的 `m_StreamData` 里，流长度字段名是 `#795`，偏移字段名是 `offset`。`#795` 为 0 或越界就跳过该贴图。

## 4. 中文怎么对上

两步，都在 `loadChinese()`：

1. 共享字符串包里，类型根是 `#263` 且子字段有 `m_TableCollectionName` 的对象，用 `readSharedStringKeys` 读。只收 collection 为 `DefaultStrings` 或 `QuestStrings` 的表。每条是 **key → int64 id**。
2. 中文包里，`#427` 以 `_zh` 结尾的对象（`DefaultStrings_zh`、`QuestStrings_zh`）的 `m_TableData[]`。每条是 **`m_Id` → `m_Localized`**。空文本不收。

然后 id 对上，得到 key → 中文。`{@Table.key}` 用 `resolve` 展开，最多 6 层，表名忽略，只按 key 再查 `byKey`。展开后 `displayText` 去掉 HTML 标签、还没解开的 `{@...}`、以及多余空白。展开结果变空的条目会从 `byId` 删掉。

对不上中文就留英文（`SearchName`，或 `pretty()` 把枚举名拆开的英文）。不要编造译名。

页面上的约定（`writeHtml` 里的脚本）：

- 搜索框 `filtered()` 仍然匹配英文名、枚举名、资产名、物品英文名、地点。中英都能搜到
- 列表标题和详情标题只用 `row.title`。不要把枚举名、资产名、`#id` 画进列表或详情标题
- 跳转（`data-jump` / `data-item` / `data-loot`，以及 `show()`）不要给 `qEl.value` 赋值。当前代码没有这种赋值，筛选词保持用户正在输入的内容

物品中文优先走 `NameLocalized.m_TableEntryReference.m_KeyId`，再到中文表。掉落表标题的回退顺序是：资产上的本地化名、`gameName()` 拼出来的 `UnitName_` / `Name_` / `MapName_` 等 key、`describeTable`、箱子的 `describeLoot`、最后才是英文。`gameName` 只接受含汉字、长度 ≤ 40、没有换行的结果。

## 5. 掉落表、搜刮点、物品怎么关联

枚举从 `il2cpp/dump.cs` 读，不要重新 dump：

- `DropTableType`：掉落表 id ↔ 枚举名
- `ItemType`：物品 id ↔ 枚举名（`value__` 是 ushort）
- `MapType`：地图 id ↔ 枚举名。枚举里还有 Bloodswamp、CrystalMountains 等，本 demo 的 wiki 只生成三张可玩小地图，见第 6 节
- `TextStringId`：来源上的 `ShownUnitNameId`
- `[SearchPath]` / `[SearchName]`：分类路径和英文显示名

配置包的 `.sharedAssets` 里，带 `DropTableConfigurationValues.Elements` 的对象是掉落表。元素是 stride `0x50` 的定长记录，`decodeElements` 读取：

- `+0x00` / `+0x04`：min / max 数量
- `+0x08`：dropMode（0 权重，1 概率）
- `+0x0a`：weight（int16）
- `+0x10`：percent，int64，**除以 65536**。除完已经是百分点：`25` 就是 25%，`100` 就是 100%
- `+0x18`：outcome（0 物品，1 子掉落表，2 配方）
- `+0x1a`：item id（uint16）
- `+0x1c`：nested 表 id
- `+0x20` 起：稀有度档个数和 int16 权重
- `+0x44`：overrideChild
- `+0x48`：flags
- `+0x4c`：recipe id

页面把概率条目的 `percent / 100` 当成比例，显示时再乘回 100。**不要在解码后再乘 100。** 权重模式用 `weight / totalWeight`（没有总权重时，用同表里非概率条目的 weight 之和），显示时才换成百分比。weight 本身也不要乘 100。

稀有度标签是 `RARITY`：普通、优秀、稀有、至高、传说、任务、诅咒。条目上的稀有度数组是各档相对权重，显示时按它们自己的和换算，和上面的掉落百分点是两套数。

flags：`2` 仅本职业可用，`4` 占位，`8` 忽略稀有度，`16` 配方书。

没有嵌入元素、但有某个 `*DropTable` 整数字段（排除 `TotalWeight`）的对象，记成来源（怪物、容器、商人）。来源分类看标题、英文名和资产名：工坊与商人、搜刮点、其余算怪物。箱子类掉落表还会再推一条「搜刮点」来源，图标优先用 `describeLoot` 配的箱子图。

怪物材料表：标题以「材料」结尾，且去掉这两个字后**恰好等于**某个怪物来源的标题，就去掉这个后缀。贵重表、箱子和藏匿点的数据标题仍保留「材料」「贵重」。页面显示时，怪物藏掉结尾的「贵重」；搜刮点藏掉「·材料」「·贵重」，以及「嘶科鼠帐篷材料」这种直接接在名字后的后缀。去掉后对不上怪物或搜刮点来源标题的不藏。跳转仍用枚举名。掉落表和来源的显示名会加上「 · 怪物」「 · 搜刮」或「 · 商人」；两边都会掉的表写成「 · 怪物/搜刮」。数据标题不加这几个字。

怪物头像只用 `PortraitSpriteName`。值是 `TempIcon` 或空则不用。显示时去掉末尾 `.png`，再按这个名字找 `icons/`。写 PNG 的主循环（图标包）已经 `rotate180`。**文件已存在就 `continue`，不要再转。** 另有一个补充扫描：小于 1MB 且内容含 `_Portrait` 的 bundle 会再导出头像，这条路径目前每次都会重写并再次 `rotate180`。不要把主循环已经转正的图标再转一次，也不要给图标加 90°。

灰爪箱的中文来自本地化 key，不是物品名。`SmallAshenclawChest` = 小型灰爪箱，`AshenclawChest` = 灰爪箱，`GreaterAshenclawChest` = 大型灰爪箱。`ChestVeryLargeName` = 奥术保险箱，那是仓库升级物品，不要拿来当场景箱子的名字。

场景里摆出来的对象名把 prefab 和大小对上了：`Small DV Chest = LootChest_High`，`Large DV Chest` / `Big DV Chest = LootChest_ExtraHigh`。`LootChest` 在场景里叫 Crafting Material Chest，是木箱，不是小型灰爪箱。普通 `MediumChest` 没有灰爪箱这句中文。`ExtraHigh2` 是同一档的银色箱子，页面写成「大型灰爪箱 2」，避免被父表火箭坠毁盖掉名字。没有单独的中文 key。

| 枚举名模式 | 场景对象 | 本地化 key |
| --- | --- | --- |
| `High` | Small DV Chest | `SmallAshenclawChest` |
| `ExtraHigh` | Large / Big DV Chest | `GreaterAshenclawChest` |

`ExtraHigh` 在 `High` 之前判断。这只金箱子的图标就是游戏里灰爪箱的外观，`look` 记成「灰爪箱」。Ghost / Scrat 的 Medium 走各自的宝箱名。

地图上的搜刮点点击走 `data-loot`，打开对应搜刮点来源（`openLoot`）。同一个 `GreaterVoidPortalChestCraftingMatTable` 点会同时带上贵重表；标题若共享同一个「·」前缀，图钉只用前缀。

不要发明 `CraftingCollectionTier4`。材料集合只显示 dump 里真实存在的 `CraftingCollectionTierN`。商店表里的 `VulkarynShopkeeperTier4Table` 是商店等级，不是材料 Tier 4。

## 6. 地图怎么关联

只有三张可玩小地图，写在 `maps.js` 的 `MAP_DEFS`：

| id | 场景 bundle | 小地图贴图 bundle | 中文 key |
| --- | --- | --- | --- |
| `pinewood` | `22e8bc68e9df03c0af8b54ec8aaec7c0.bundle` | `6dfc96724fd67e223427f4e284491daf.bundle` | `MapName_Pinewood` |
| `refinery` | `b411e94175656f65f931de14528d785b.bundle` | `3b5fd3da52126ef35d7646afe469b8a3.bundle` | `MapName_Refinery` |
| `dragonvault` | `bdaed0fc428a60db80ef56ea6258ee39.bundle` | `5b340e8f45322580fb9e7a6adbe84e02.bundle` | `MapName_Dragonvault` |

世界范围来自场景里带 `_worldSize` 的 `CellBasedCullingBehaviour`（`dump.cs` 里字段是 `_worldSize`、`_worldOffset`，都是 Vector2）。代码用 `asFloat` 读 `_worldSize.x/y` 和 `_worldOffset.x/y`。**y 是世界 Z**，不是世界 Y。读不到或 size 为 0 就不出点。

狼林曾测得 size `600×600`，offset `x = -250`，`y = -203`（这个 y 是世界 Z）。这是测量记录，`maps.js` 没有把这三个数写死。以后以组件里读到的值为准。

归一化（再套第 9 节的 90° 之前）：

```
u = (worldX - offsetX) / sizeX
v = (worldZ - offsetY) / sizeY
left = (1 - u) * 100
top  = (1 - v) * 100
```

允许大约 ±0.02 的出界。坐标四舍五入到 0.1。

搜刮点：在场景序列化数据里按长度前缀搜这些子串：`Chest`、`Loot`、`Den`、`Mound`、`Lock`、`Vault`、`Scrap`、`Purifier`、`Rocket`、`Hidden`。名字前面的 int32 必须等于字符串长度。再用 `chestTable()` 映射到已有 `DropTableType` 枚举名。对不上表的名字（Decal、Vfx、Lid、Wheel 等）丢掉。同一个物体只留一次；同一张表、取整后的 x/z 相同也只留一个。点击图钉打开搜刮点来源。

龙窟场景没有写死的箱子坐标。扫描可以跑，没有匹配到就让这张图的图钉为空，页面会写「没有写死的搜刮点坐标」。不要编坐标，也不要从别的图搬箱子过来。

空艇不是第四张地图。它是狼林场景里的区域名 `Area3 - ScratAirship`，中文 key `MapName_Airship`，文案是「空艇」。没有单独的传送门坐标，也不要加进 `MAP_DEFS`。

## 7. 入口

`collectEntrances` 在三张场景里按长度前缀搜：`PortalWolfswood`、`PortalRefinery`、`DVPortal`、`OneWayPortal`、`ExtractionSpawn`。

传送门和 `ENTRANCE_SPECS` 对上才收。中文 key：

| 场景物体 | 标题 key |
| --- | --- |
| `PortalWolfswood1/2/3` | `Name_AdvancedNpc_PortalWolfswood1/2/3` |
| `PortalRefinery1/2/3` | `Name_PortalRefinery1/2/3` |
| `DVPortal - West` | `Name_PortalDV1` |
| `DVPortal - North` | `Name_PortalDV2` |
| `DVPortal - East` | `Name_PortalDV3` |
| `OneWayPortal1/2/3`（全名匹配） | `Name_AdvancedNpc_OneWayPortal1/2/3` |

详情 key 在 `ENTRANCE_SPECS` 的 `detailKey`。标题没有汉字的入口整条丢掉，不要编中文。

物体世界坐标接近原点（`|x|` 和 `|z|` 都不大于 1）时，改用子物体 `Portal visible Unlocked` 或 `Portal On VFx` 的坐标。

撤离点：父物体名是 `ExtractionSpawn`，取子物体 `Rune`。中文 key 是 `ExtractionPoint`，详情 key 是 `ChannelToSoloExtract`。Rune 也在原点附近就丢掉。页面上菱形是传送门，方块是撤离点。

## 8. 区域

区域来自场景里名字含 `HiddenAreaCover` 的物体上的 **Sprite 贴图轮廓**（SpriteRenderer 的 `classId` 是 212，读 `m_Sprite`）。

不是 Building Resources 的 Tier 文件夹，也不是音频用的 `PolygonAreaBehaviour`。贴图多半是通用云雾，不是贴着建筑外墙的边。

当前 `maps.js` 的做法（轮廓代码还在改，阈值以文件为准）：

1. `loadCoverMesh` 读 sprite 的 `m_RD` 顶点（每顶点 12 字节，取 xy 两个 float）和 uint16 索引，用只出现一次的边串成环。
2. 若 sprite 带贴图，用 `traceAlpha`：alpha > 96 的像素，取最大连通块（少于 30 像素则不用），绕质心分 72 个角度箱，每箱留最远的像素，得到云雾外轮廓。再按 `m_Rect`、`m_Pivot`、`m_PixelsToUnits` 变到 sprite 本地坐标，`simplifyClosed` 的 epsilon 是 `0.015`，至少 8 个点才替换网格。
3. 外部 mesh 的 bundle 在 `COVER_BUNDLES`（三个 `CAB-` 对三个 `.bundle`）。`fileId == 0` 的 sprite 在场景包自己的节点里。`.sharedAssets` 外部引用用场景包里的 `CAB-....sharedAssets`。
4. 轮廓点乘物体的缩放和旋转，再加世界坐标，然后用和搜刮点相同的百分比（含第 9 节的 90°）。
5. `keepLand` 用已经写出的 `maps/<id>.png` 丢掉纯色空地。空地参考色是 RGB `(24, 16, 12)`，颜色差的平方和大于 140 才算落在地上。断开的缝（当前是间距大于 8 且中点不在地上）会把一条环拆开。太短的段丢掉。

父链上第一个 `Area <数字>` 或 `Area<数字>` 名字当作区域英文名。中文来自 `extract.js` 的 `regionNameKeys`：

| 场景名 | key |
| --- | --- |
| `Area 1 Fume Pits` | `MapName_FumePits` |
| `Area 5 Shanty Town` | `MapName_ShantyTown` |
| `Area8 - PinecrestKeep` | `MapName_PinecrestKeep` |
| `Area8 - Pinecrest`、`Area8 - Pinecrest_1` | `MapName_PinecrestVillage` |
| `Area14 - DarkmoonThicket` 及 `(boss)` | `MapName_DarkmoonThicket` |
| `Area12 - ElvenRuins`、`Area12 - ElvenRuins_1` | `MapName_ElvenRuins` |
| `Area20 - GaleCrest` | `MapName_GalecrestPlateau` |
| `Area9 - Crypt` | `MapName_Crypt` |
| `Area6 - GY_Circle` | `MapName_GraveYard` |
| `Area3 - ScratAirship` | `MapName_Airship` |

`Area <数字>` 的标题是 `数字 · 中文`。没有中文就用场景名里剩下的英文，不要编地名。

## 9. 正在进行的变更

这一节写的是读代码时的状态。**若代码已经写入，以代码为准。**

小地图再逆时针转 90°，标记一起转。图标不要再转。

左上角为原点、y 向下的百分比里，在原来的 `left = (1-u)*100`、`top = (1-v)*100` 之后：

```
left' = 原来的 top
top'  = 100 - 原来的 left
```

读代码时这已经在 `maps.js` 的 `toMapPercent` 里，搜刮点、入口、区域轮廓都走它。

小地图 PNG：`exportMinimap` 在文件已存在时直接返回。新文件是先 `rotate180`（把 Unity 贴图转正），再 `rotateCCW90`。现有三张图是 2048×2048，转 90° 宽高不变。磁盘上的 `maps/*.png` 若是转 90° 之前生成的，跳过逻辑不会改它们；要换朝向就删掉这三张再跑 `node extract.js`，让写入路径各转一次。不要在已经转过的像素上再转一遍。

图标仍只在 `extract.js` 里 `rotate180`，主循环看到已有文件就跳过。不要给图标加这个 90°。

页眉：`extract.js` 的 `writeHtml` 里已经有作者 **elmagnifico**、wiki 版本 **v0.1**，以及游戏版本那一格。读代码时那一格写的是「1.0（Steam build 25803617）」。这不是游戏版本：

- `Vaultbreakers_Data/globalgamemanagers` 的 PlayerSettings 里，连续三个版本字符串是 `visionOSBundleVersion = 1.0`、`tvOSBundleVersion = 1.0`、`bundleVersion = 2.0.2137.110314`
- `bundleVersion` 才是运行时 `Application.version`。页面上的游戏版本用 **`2.0.2137.110314`**
- `1.0` 是旁边两个平台字段。Steam `appmanifest_4488770.acf` 的 `buildid` `25803617` 是安装构建号。exe 的 ProductVersion `6000.3.18f1` 是引擎版本
- 若你读代码时这一格已经是 `2.0.2137.110314`，以代码为准。若仍是 `1.0` 或 Steam build，就是还没改到 bundleVersion

作者和 v0.1 只放在 `writeHtml` 模板里，靠 `node extract.js` 进页面。不要手改 `index.html`。

## 10. 更新时不要做的事

- 不要把已有图标或小地图再转一次。主循环和 `exportMinimap` 在文件存在时会跳过；补充头像扫描会重写 `_Portrait` 小包，不要借那条路径去转主图标
- 不要编造中文。key 没有汉字就留英文
- 不要编造坐标。龙窟没有写死的箱子坐标就留空
- 不要编造材料 Tier 4，也不要把商店 Tier 4 写成材料等级
- 不要把 bundle、贴图或场景资产拷进 wiki 目录。wiki 只留脚本生成的 html、json 和 png
- 不要重新 dump IL2CPP
- 不要为了地图浮点去改 `serialized.js` 的 `readPrimitive`
- 不要手改 `index.html`
- 不要提交 git，除非用户另说
