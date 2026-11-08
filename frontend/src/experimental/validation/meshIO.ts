// Mesh files for the EXPERIMENTAL validation tooling: the page's mesh.ply (ASCII, per-vertex confidence and support
// label) and a reference mesh (STL binary or ASCII, PLY ASCII or binary). Plain parsers, no dependency. Units are taken
// as millimetres (the page writes millimetres; an STL carries no unit, so the caller states it).
import type { Mesh } from "../common";

export interface ParsedMesh {
  mesh: Mesh;
  /** Extra per-vertex properties by name (PLY only), e.g. confidence, support. */
  vertexProps: Record<string, Float64Array>;
  comments: string[];
  format: "ply-ascii" | "ply-binary-le" | "ply-binary-be" | "stl-ascii" | "stl-binary";
}

export class MeshParseError extends Error {}

const dec = new TextDecoder();

// ---------------------------------------------------------------------------------------------------------------
// PLY

const PLY_TYPES: Record<string, { size: number; get: (dv: DataView, o: number, le: boolean) => number }> = {
  char: { size: 1, get: (dv, o) => dv.getInt8(o) },
  int8: { size: 1, get: (dv, o) => dv.getInt8(o) },
  uchar: { size: 1, get: (dv, o) => dv.getUint8(o) },
  uint8: { size: 1, get: (dv, o) => dv.getUint8(o) },
  short: { size: 2, get: (dv, o, le) => dv.getInt16(o, le) },
  int16: { size: 2, get: (dv, o, le) => dv.getInt16(o, le) },
  ushort: { size: 2, get: (dv, o, le) => dv.getUint16(o, le) },
  uint16: { size: 2, get: (dv, o, le) => dv.getUint16(o, le) },
  int: { size: 4, get: (dv, o, le) => dv.getInt32(o, le) },
  int32: { size: 4, get: (dv, o, le) => dv.getInt32(o, le) },
  uint: { size: 4, get: (dv, o, le) => dv.getUint32(o, le) },
  uint32: { size: 4, get: (dv, o, le) => dv.getUint32(o, le) },
  float: { size: 4, get: (dv, o, le) => dv.getFloat32(o, le) },
  float32: { size: 4, get: (dv, o, le) => dv.getFloat32(o, le) },
  double: { size: 8, get: (dv, o, le) => dv.getFloat64(o, le) },
  float64: { size: 8, get: (dv, o, le) => dv.getFloat64(o, le) },
};

interface PlyProp {
  name: string;
  type: string;
  list?: { countType: string };
}
interface PlyElement {
  name: string;
  count: number;
  props: PlyProp[];
}

export function parsePly(bytes: Uint8Array): ParsedMesh {
  // header: ASCII up to "end_header\n"
  const headEnd = findHeaderEnd(bytes);
  if (!headEnd) throw new MeshParseError("PLY: no end_header line");
  const head = dec.decode(bytes.subarray(0, headEnd.end)).split(/\r?\n/);
  if (head[0].trim() !== "ply") throw new MeshParseError("PLY: the file does not start with 'ply'");
  let format: ParsedMesh["format"] | null = null;
  const comments: string[] = [];
  const elements: PlyElement[] = [];
  for (const raw of head.slice(1)) {
    const line = raw.trim();
    if (!line || line === "end_header") continue;
    const w = line.split(/\s+/);
    if (w[0] === "format") {
      format = w[1] === "ascii" ? "ply-ascii" : w[1] === "binary_little_endian" ? "ply-binary-le" : w[1] === "binary_big_endian" ? "ply-binary-be" : null;
      if (!format) throw new MeshParseError(`PLY: unknown format ${w[1]}`);
    } else if (w[0] === "comment" || w[0] === "obj_info") comments.push(line.slice(w[0].length).trim());
    else if (w[0] === "element") elements.push({ name: w[1], count: Number(w[2]), props: [] });
    else if (w[0] === "property") {
      const el = elements[elements.length - 1];
      if (!el) throw new MeshParseError("PLY: property before element");
      if (w[1] === "list") el.props.push({ name: w[4], type: w[3], list: { countType: w[2] } });
      else el.props.push({ name: w[2], type: w[1] });
    }
  }
  if (!format) throw new MeshParseError("PLY: no format line");
  for (const el of elements) {
    if (!Number.isInteger(el.count) || el.count < 0) throw new MeshParseError(`PLY: bad count for element ${el.name}`);
    for (const p of el.props) if (!PLY_TYPES[p.type] || (p.list && !PLY_TYPES[p.list.countType])) throw new MeshParseError(`PLY: unknown property type in ${el.name}.${p.name}`);
  }
  const vEl = elements.find((e) => e.name === "vertex");
  if (!vEl) throw new MeshParseError("PLY: no vertex element");
  for (const k of ["x", "y", "z"]) if (!vEl.props.some((p) => p.name === k && !p.list)) throw new MeshParseError(`PLY: vertex has no ${k}`);
  const vertexProps: Record<string, Float64Array> = {};
  for (const p of vEl.props) if (!p.list) vertexProps[p.name] = new Float64Array(vEl.count);
  const faces: number[] = [];
  const pushFace = (idx: number[]) => {
    for (let k = 1; k + 1 < idx.length; k++) faces.push(idx[0], idx[k], idx[k + 1]); // fan-triangulate polygons
  };
  const bodyStart = headEnd.end + headEnd.skip;
  if (format === "ply-ascii") {
    const tokens = dec.decode(bytes.subarray(bodyStart)).split(/\s+/).filter((t) => t.length > 0);
    let q = 0;
    const next = () => {
      if (q >= tokens.length) throw new MeshParseError("PLY: the file ends early");
      const v = Number(tokens[q++]);
      if (!Number.isFinite(v)) throw new MeshParseError(`PLY: not a number: ${tokens[q - 1]}`);
      return v;
    };
    for (const el of elements)
      for (let i = 0; i < el.count; i++)
        for (const p of el.props) {
          if (p.list) {
            const n = next();
            const idx: number[] = [];
            for (let k = 0; k < n; k++) idx.push(next());
            if (el.name === "face" && (p.name === "vertex_indices" || p.name === "vertex_index")) pushFace(idx);
          } else {
            const v = next();
            if (el === vEl) vertexProps[p.name][i] = v;
          }
        }
  } else {
    const le = format === "ply-binary-le";
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let o = bodyStart;
    const read = (type: string) => {
      const t = PLY_TYPES[type];
      if (o + t.size > bytes.length) throw new MeshParseError("PLY: the file ends early");
      const v = t.get(dv, o, le);
      o += t.size;
      return v;
    };
    for (const el of elements)
      for (let i = 0; i < el.count; i++)
        for (const p of el.props) {
          if (p.list) {
            const n = read(p.list.countType);
            const idx: number[] = [];
            for (let k = 0; k < n; k++) idx.push(read(p.type));
            if (el.name === "face" && (p.name === "vertex_indices" || p.name === "vertex_index")) pushFace(idx);
          } else {
            const v = read(p.type);
            if (el === vEl) vertexProps[p.name][i] = v;
          }
        }
  }
  const vertices = new Float32Array(vEl.count * 3);
  for (let i = 0; i < vEl.count; i++) {
    vertices[i * 3] = vertexProps.x[i];
    vertices[i * 3 + 1] = vertexProps.y[i];
    vertices[i * 3 + 2] = vertexProps.z[i];
  }
  for (const f of faces) if (f < 0 || f >= vEl.count) throw new MeshParseError(`PLY: face index ${f} out of range`);
  delete vertexProps.x;
  delete vertexProps.y;
  delete vertexProps.z;
  return { mesh: { vertices, indices: Uint32Array.from(faces) }, vertexProps, comments, format };
}

function findHeaderEnd(bytes: Uint8Array): { end: number; skip: number } | null {
  const limit = Math.min(bytes.length, 65536);
  const head = dec.decode(bytes.subarray(0, limit));
  const m = /end_header\r?\n/.exec(head);
  if (!m) return null;
  // header is ASCII, so character offsets equal byte offsets
  const end = m.index + "end_header".length;
  return { end, skip: m[0].length - "end_header".length };
}

/** The support label names written by the page in the PLY header ("comment support labels: 0=observed, 1=implied, ..."). */
export function supportLabelsFromComments(comments: readonly string[]): string[] | null {
  for (const c of comments) {
    const m = /^support labels:\s*(.*)$/.exec(c);
    if (!m) continue;
    const out: string[] = [];
    for (const part of m[1].split(",")) {
      const kv = /^\s*(\d+)=(\S+)\s*$/.exec(part);
      if (kv) out[Number(kv[1])] = kv[2];
    }
    return out.length ? out : null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// STL

export function parseStl(bytes: Uint8Array): ParsedMesh {
  const isBinary = (() => {
    if (bytes.length < 84) return false;
    const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
    if (84 + n * 50 === bytes.length) return true;
    return !/^\s*solid[\s\S]*facet/.test(dec.decode(bytes.subarray(0, Math.min(bytes.length, 1024))));
  })();
  const verts: number[] = [];
  if (isBinary) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = dv.getUint32(80, true);
    if (84 + n * 50 > bytes.length) throw new MeshParseError(`STL: binary header says ${n} triangles but the file is too short`);
    for (let t = 0; t < n; t++) {
      const o = 84 + t * 50 + 12;
      for (let k = 0; k < 9; k++) verts.push(dv.getFloat32(o + k * 4, true));
    }
  } else {
    const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
    const s = dec.decode(bytes);
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const v = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (!v.every(Number.isFinite)) throw new MeshParseError(`STL: not a number in ${m[0]}`);
      verts.push(...v);
    }
    if (verts.length % 9 !== 0) throw new MeshParseError("STL: a facet does not have three vertices");
  }
  const mesh = weldTriangleSoup(Float32Array.from(verts));
  return { mesh, vertexProps: {}, comments: [], format: isBinary ? "stl-binary" : "stl-ascii" };
}

/** Merge identical vertices of a triangle soup (STL repeats every corner). */
export function weldTriangleSoup(soup: Float32Array): Mesh {
  const map = new Map<string, number>();
  const verts: number[] = [];
  const idx = new Uint32Array(soup.length / 3);
  for (let i = 0; i < soup.length; i += 3) {
    const key = `${soup[i]},${soup[i + 1]},${soup[i + 2]}`;
    let id = map.get(key);
    if (id === undefined) {
      id = verts.length / 3;
      map.set(key, id);
      verts.push(soup[i], soup[i + 1], soup[i + 2]);
    }
    idx[i / 3] = id;
  }
  return { vertices: Float32Array.from(verts), indices: idx };
}

/** Binary STL of a mesh (normals from the triangle winding). */
export function writeStlBinary(mesh: Mesh, header = "glovesize experimental"): Uint8Array {
  const nt = mesh.indices.length / 3;
  const out = new Uint8Array(84 + nt * 50);
  const dv = new DataView(out.buffer);
  out.set(new TextEncoder().encode(header.slice(0, 80)), 0);
  dv.setUint32(80, nt, true);
  const V = mesh.vertices, I = mesh.indices;
  for (let t = 0; t < nt; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2];
    const vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l; // fmt: skip
    const o = 84 + t * 50;
    [nx, ny, nz, V[a], V[a + 1], V[a + 2], V[b], V[b + 1], V[b + 2], V[c], V[c + 1], V[c + 2]].forEach((x, k) => dv.setFloat32(o + k * 4, x, true));
  }
  return out;
}

/** PLY or STL by content (and name as a hint). */
export function parseMeshFile(bytes: Uint8Array, name = ""): ParsedMesh {
  const start = dec.decode(bytes.subarray(0, Math.min(4, bytes.length)));
  if (start.startsWith("ply")) return parsePly(bytes);
  if (/\.ply$/i.test(name)) throw new MeshParseError(`${name}: does not start with 'ply'`);
  return parseStl(bytes);
}
