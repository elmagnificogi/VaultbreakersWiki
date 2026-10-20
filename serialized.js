class R {
  constructor(buf, endian = "le") {
    this.b = buf;
    this.o = 0;
    this.endian = endian;
  }
  u8() { return this.b[this.o++]; }
  bool() { return this.u8() !== 0; }
  i16() {
    const v = this.endian === "le" ? this.b.readInt16LE(this.o) : this.b.readInt16BE(this.o);
    this.o += 2; return v;
  }
  i32() {
    const v = this.endian === "le" ? this.b.readInt32LE(this.o) : this.b.readInt32BE(this.o);
    this.o += 4; return v;
  }
  u32() {
    const v = this.endian === "le" ? this.b.readUInt32LE(this.o) : this.b.readUInt32BE(this.o);
    this.o += 4; return v;
  }
  i64() {
    const v = this.endian === "le" ? this.b.readBigInt64LE(this.o) : this.b.readBigInt64BE(this.o);
    this.o += 8; return v;
  }
  f32() {
    const v = this.endian === "le" ? this.b.readFloatLE(this.o) : this.b.readFloatBE(this.o);
    this.o += 4; return v;
  }
  f64() {
    const v = this.endian === "le" ? this.b.readDoubleLE(this.o) : this.b.readDoubleBE(this.o);
    this.o += 8; return v;
  }
  bytes(n) { const s = this.b.subarray(this.o, this.o + n); this.o += n; return s; }
  cstr() {
    const s = this.o;
    while (this.o < this.b.length && this.b[this.o] !== 0) this.o++;
    const v = this.b.toString("utf8", s, this.o);
    this.o++;
    return v;
  }
  align(n) {
    const m = this.o % n;
    if (m) this.o += n - m;
  }
}

function readStr(strBuf, off) {
  if (off & 0x80000000) return null; // common string, filled later if needed
  let e = off;
  while (e < strBuf.length && strBuf[e] !== 0) e++;
  return strBuf.toString("utf8", off, e);
}

const COMMON = {
  0: "AABB", 5: "AnimationClip", 19: "AnimationCurve", 34: "AnimationState", 49: "Array", 55: "Base",
  60: "BitField", 69: "bitset", 76: "bool", 81: "char", 86: "ColorRGBA", 95: "Component", 105: "data",
  110: "deque", 116: "double", 123: "dynamic_array", 137: "FastPropertyName", 153: "first", 159: "float",
  165: "Font", 170: "GameObject", 181: "Generic Mono", 194: "GradientNEW", 206: "GUID", 211: "GUIStyle",
  220: "int", 224: "list", 229: "long long", 239: "map", 243: "Matrix4x4f", 254: "MdFour", 261: "MonoBehaviour",
  275: "MonoScript", 286: "m_ByteSize", 297: "m_Curve", 305: "m_EditorClassIdentifier", 329: "m_EditorHideFlags",
  347: "m_Enabled", 357: "m_ExtensionPtr", 372: "m_GameObject", 385: "m_Index", 393: "m_IsArray", 403: "m_IsStatic",
  414: "m_MetaFlag", 425: "m_Name", 432: "m_ObjectHideFlags", 449: "m_PrefabInternal", 466: "m_PrefabParentObject",
  487: "m_Script", 496: "m_StaticEditorFlags", 516: "m_Type", 523: "m_Version", 533: "Object", 540: "pair",
  545: "PPtr<Component>", 560: "PPtr<GameObject>", 576: "PPtr<Material>", 590: "PPtr<MonoBehaviour>",
  609: "PPtr<MonoScript>", 625: "PPtr<Object>", 637: "PPtr<Prefab>", 649: "PPtr<Sprite>", 661: "PPtr<TextAsset>",
  676: "PPtr<Texture>", 689: "PPtr<Texture2D>", 704: "PPtr<Transform>", 719: "Quaternionf", 731: "Rectf",
  737: "RectInt", 745: "RectOffset", 756: "second", 763: "set", 767: "short", 773: "size", 778: "SInt16",
  785: "SInt32", 792: "SInt64", 799: "SInt8", 805: "staticvector", 818: "string", 825: "TextAsset", 835: "TextMesh",
  844: "Texture", 852: "Texture2D", 862: "Transform", 872: "TypelessData", 885: "UInt16", 892: "UInt32",
  899: "UInt64", 906: "UInt8", 912: "unsigned int", 925: "unsigned long long", 944: "unsigned short",
  959: "vector", 966: "Vector2f", 975: "Vector3f", 984: "Vector4f", 993: "m_ScriptingClassIdentifier",
  1020: "Gradient", 1041: "Type*", 1047: "int2_storage", 1060: "int3_storage", 1073: "BoundsInt",
  1083: "m_CorrespondingSourceObject", 1110: "m_PrefabInstance", 1127: "m_PrefabAsset", 1141: "FileSize",
  1150: "Hash128",
};

function strOf(strBuf, off) {
  if (off & 0x80000000) return COMMON[off & 0x7fffffff] || `#${off & 0x7fffffff}`;
  return readStr(strBuf, off) ?? "";
}

function parseBlob(r, version) {
  const nodeCount = r.i32();
  const strSize = r.i32();
  if (nodeCount < 1 || nodeCount > 200000 || strSize < 0 || strSize > 20_000_000) {
    throw new Error(`bad blob nodes=${nodeCount} str=${strSize} @${r.o}`);
  }
  const nodeSize = version >= 19 ? 32 : 24;
  const raw = r.bytes(nodeSize * nodeCount);
  const strBuf = r.bytes(strSize);
  const nodes = [];
  for (let i = 0; i < nodeCount; i++) {
    const p = i * nodeSize;
    const view = raw;
    const mVersion = view.readInt16LE(p);
    const level = view[p + 2];
    const typeFlags = view[p + 3];
    const typeOff = view.readUInt32LE(p + 4);
    const nameOff = view.readUInt32LE(p + 8);
    const byteSize = view.readInt32LE(p + 12);
    const index = view.readInt32LE(p + 16);
    const meta = view.readInt32LE(p + 20);
    nodes.push({
      level, typeFlags, byteSize, index, meta, version: mVersion,
      type: strOf(strBuf, typeOff),
      name: strOf(strBuf, nameOff),
      children: [],
    });
  }
  const root = { level: -1, children: [], type: "", name: "" };
  const stack = [root];
  let parent = root;
  let prev = root;
  for (const node of nodes) {
    if (node.level > prev.level) {
      stack.push(parent);
      parent = prev;
    } else if (node.level < prev.level) {
      while (node.level <= parent.level) parent = stack.pop();
    }
    parent.children.push(node);
    prev = node;
  }
  return root.children[0];
}

function parseType(r, version, enableTree, isRef) {
  const classId = r.i32();
  let stripped = false;
  let scriptIndex = -1;
  if (version >= 16) stripped = r.bool();
  if (version >= 17) scriptIndex = r.i16();
  if (version >= 13) {
    const wantsScript = (isRef && scriptIndex >= 0) || (version < 16 && classId < 0) || (version >= 16 && classId === 114);
    if (wantsScript) r.bytes(16);
    r.bytes(16);
  }
  let node = null;
  if (enableTree) {
    if (version >= 23) {
      r.bytes(16);
      const serializedSize = r.u32();
      if (serializedSize >= 8) {
        const magic = r.bytes(4).toString("ascii");
        if (magic !== "mhtt") throw new Error("bad tt magic " + magic);
        const ttVer = r.i32();
        node = parseBlob(r, ttVer);
        const refCount = r.u32();
        r.bytes(16 * refCount);
      }
    } else {
      node = parseBlob(r, version);
    }
  }
  let className = "", ns = "", asm = "";
  if (version >= 21 && isRef) {
    className = r.cstr();
    ns = r.cstr();
    asm = r.cstr();
  } else if (version >= 21) {
    const n = r.i32();
    if (n < 0 || n > 100000) throw new Error("deps " + n);
    r.bytes(n * 4);
  }
  return { classId, scriptIndex, stripped, node, className, ns, asm };
}

function parseSerialized(buf) {
  const hr = new R(buf, "be");
  const metadataSize0 = hr.u32();
  const fileSize0 = hr.u32();
  const version = hr.u32();
  const dataOffset0 = hr.u32();
  if (version < 9 || version > 40) throw new Error("bad version " + version);
  const endianBig = hr.u8() !== 0;
  hr.bytes(3);
  let metadataSize = metadataSize0;
  let fileSize = fileSize0;
  let dataOffset = dataOffset0;
  if (version >= 22) {
    metadataSize = hr.u32();
    fileSize = Number(hr.i64());
    dataOffset = Number(hr.i64());
    hr.i64();
  }
  const endian = endianBig ? "be" : "le";
  const r = new R(buf, endian);
  r.o = hr.o;
  const unityVersion = r.cstr();
  const platform = r.i32();
  const enableTree = version >= 13 ? r.bool() : true;
  const typeCount = r.i32();
  const types = [];
  for (let i = 0; i < typeCount; i++) types.push(parseType(r, version, enableTree, false));
  if (version >= 7 && version < 14) r.i32();
  const objectCount = r.i32();
  const objects = [];
  for (let i = 0; i < objectCount; i++) {
    r.align(4);
    const pathId = version >= 14 ? r.i64() : BigInt(r.i32());
    const byteStart = version >= 22 ? r.i64() : BigInt(r.u32());
    const byteSize = r.u32();
    const typeId = r.i32();
    objects.push({ pathId, byteStart: Number(byteStart), byteSize, typeId });
  }
  let scriptTypes = [];
  if (version >= 11) {
    const n = r.i32();
    for (let i = 0; i < n; i++) {
      const localSerializedFileIndex = r.i32();
      r.align(4);
      const localIdentifierInFile = r.i64();
      scriptTypes.push({ localSerializedFileIndex, localIdentifierInFile });
    }
  }
  const externals = [];
  const extCount = r.i32();
  for (let i = 0; i < extCount; i++) {
    let temp = "";
    if (version >= 6) temp = r.cstr();
    let guid = null, type = 0;
    if (version >= 5) { guid = r.bytes(16); type = r.i32(); }
    const path = r.cstr();
    externals.push({ temp, type, path });
  }
  let refTypes = [];
  if (version >= 20) {
    const n = r.i32();
    for (let i = 0; i < n; i++) refTypes.push(parseType(r, version, enableTree, true));
  }
  return {
    version, endian, unityVersion, platform, enableTree, metadataSize, fileSize, dataOffset,
    types, objects, scriptTypes, externals, refTypes, buf,
  };
}

const ALIGN = 0x4000;

function align4(r) { r.align(4); }

function isArrayNode(node) {
  if (!node) return false;
  if (node.type === "Array") return true;
  if (node.children.length === 1 && node.children[0].type === "Array") return true;
  // TypelessData / image data: int size + byte data, no Array wrapper
  if (node.children.length === 2) {
    const [a, b] = node.children;
    const sizeName = a.name === "size" || a.name === "#795";
    if (sizeName && a.byteSize === 4 && a.children.length === 0 && b.byteSize === 1 && b.children.length === 0) return true;
  }
  return false;
}

function arrayShape(node) {
  const arr = node.type === "Array" ? node : (node.children[0] && node.children[0].type === "Array" ? node.children[0] : node);
  if (!arr || arr.children.length < 2) return null;
  return { sizeNode: arr.children[0], dataNode: arr.children[1] };
}

function readPrimitive(r, node) {
  const t = node.type;
  const sz = node.byteSize;
  if (t === "float" || t === "double") {
    const v = t === "float" ? r.f32() : r.f64();
    if (node.meta & ALIGN) align4(r);
    return v;
  }
  if (sz === 1) {
    const v = r.u8();
    if (node.meta & ALIGN) align4(r);
    return v;
  }
  if (sz === 2) {
    const v = r.i16();
    if (node.meta & ALIGN) align4(r);
    return v;
  }
  if (sz === 4) {
    const v = r.i32();
    if (node.meta & ALIGN) align4(r);
    return v;
  }
  if (sz === 8) {
    const v = r.i64().toString();
    if (node.meta & ALIGN) align4(r);
    return v;
  }
  if (sz > 0) {
    const raw = Buffer.from(r.bytes(sz));
    if (node.meta & ALIGN) align4(r);
    return raw;
  }
  return undefined;
}

function readValue(r, node) {
  const t = node.type;
  if (t === "string") {
    const n = r.i32();
    if (n < 0 || n > 1_000_000) throw new Error("bad string " + n + " at " + r.o);
    const s = r.bytes(n).toString("utf8");
    align4(r);
    return s;
  }
  if (t.startsWith("PPtr<") || (node.children.length === 2 && node.children[0].name === "m_FileID" && node.children[1].name === "m_PathID")) {
    const fileId = r.i32();
    align4(r);
    const pathId = r.i64();
    if (node.meta & ALIGN) align4(r);
    return { fileId, pathId: pathId.toString() };
  }
  if (isArrayNode(node)) {
    const shape = arrayShape(node);
    if (!shape) throw new Error("bad array " + node.type + " " + node.name);
    const count = r.i32();
    if (count < 0 || count > 2_000_000) throw new Error("bad array count " + count + " " + node.name);
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = readValue(r, shape.dataNode);
    if ((node.meta & ALIGN) || (shape.dataNode.meta & ALIGN) || shape.dataNode.byteSize === 1) align4(r);
    return node.type === "Array" ? out : out;
  }
  if (node.children.length === 0) {
    const v = readPrimitive(r, node);
    if (v !== undefined) return v;
  }
  const obj = {};
  for (const child of node.children) {
    obj[child.name || child.type] = readValue(r, child);
  }
  if (node.meta & ALIGN) align4(r);
  return obj;
}

function readObject(sf, obj) {
  const typ = sf.types[obj.typeId];
  if (!typ || !typ.node) return null;
  const r = new R(sf.buf, sf.endian);
  r.o = sf.dataOffset + obj.byteStart;
  const end = r.o + obj.byteSize;
  const value = readValue(r, typ.node);
  return { value, consumed: r.o - (sf.dataOffset + obj.byteStart), size: obj.byteSize, endOver: r.o - end };
}

module.exports = { parseSerialized, readObject, readValue, R };
