// Mesh file readers on tiny hand-made meshes (TEST FIXTURES only).
import { describe, expect, it } from "vitest";
import { meshPly } from "../recon/page/exportZip";
import { parseMeshFile, parsePly, parseStl, supportLabelsFromComments, weldTriangleSoup, writeStlBinary } from "./meshIO";

const tetra = { vertices: Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]), indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]) };
const enc = new TextEncoder();

describe("PLY", () => {
  it("reads the page's ASCII PLY with confidence, support and the label names", () => {
    const ply = meshPly(tetra, Float32Array.from([0, 0.5, 1, 1]), Uint8Array.from([2, 2, 0, 1]), ["observed", "implied", "support_plane", "volume_cut", "truncated"]);
    const p = parsePly(enc.encode(ply));
    expect(p.format).toBe("ply-ascii");
    expect(Array.from(p.mesh.vertices)).toEqual(Array.from(tetra.vertices));
    expect(Array.from(p.mesh.indices)).toEqual(Array.from(tetra.indices));
    expect(Array.from(p.vertexProps.support)).toEqual([2, 2, 0, 1]);
    expect(Array.from(p.vertexProps.confidence)).toEqual([0, 0.5, 1, 1]);
    expect(supportLabelsFromComments(p.comments)).toEqual(["observed", "implied", "support_plane", "volume_cut", "truncated"]);
  });

  it("reads a binary little-endian PLY with a quad face (fan-triangulated)", () => {
    const head = enc.encode("ply\nformat binary_little_endian 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n");
    const body = new DataView(new ArrayBuffer(4 * 12 + 1 + 16));
    [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0].forEach((v, i) => body.setFloat32(i * 4, v, true));
    body.setUint8(48, 4);
    [0, 1, 2, 3].forEach((v, i) => body.setInt32(49 + i * 4, v, true));
    const bytes = new Uint8Array(head.length + body.byteLength);
    bytes.set(head);
    bytes.set(new Uint8Array(body.buffer), head.length);
    const p = parseMeshFile(bytes, "q.ply");
    expect(p.format).toBe("ply-binary-le");
    expect(Array.from(p.mesh.indices)).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it("refuses broken files instead of guessing", () => {
    expect(() => parsePly(enc.encode("ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nend_header\n1\n"))).toThrow(/no y/);
    expect(() => parsePly(enc.encode("ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nend_header\n1 2 3\n"))).toThrow(/ends early/);
  });
});

describe("STL", () => {
  it("writes and reads back a binary STL, welding the repeated corners", () => {
    const p = parseStl(writeStlBinary(tetra));
    expect(p.format).toBe("stl-binary");
    expect(p.mesh.vertices.length / 3).toBe(4);
    expect(p.mesh.indices.length / 3).toBe(4);
  });

  it("reads an ASCII STL", () => {
    const s = "solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nfacet normal 0 0 1\nouter loop\nvertex 1 0 0\nvertex 1 1 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n";
    const p = parseMeshFile(enc.encode(s), "t.stl");
    expect(p.format).toBe("stl-ascii");
    expect(p.mesh.vertices.length / 3).toBe(4);
    expect(Array.from(p.mesh.indices)).toEqual([0, 1, 2, 1, 3, 2]);
  });

  it("welds identical vertices only", () => {
    const m = weldTriangleSoup(Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1]));
    expect(m.vertices.length / 3).toBe(4);
    expect(Array.from(m.indices)).toEqual([0, 1, 2, 0, 2, 3]);
  });
});
