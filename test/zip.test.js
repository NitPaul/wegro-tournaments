/**
 * The ZIP writer behind the full backup.
 *
 * A backup nobody can open is worse than no backup, so these read the bytes
 * back the way an unzip tool does — central directory first, then each local
 * header and its checksum — rather than trusting that it looked right.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { crc32, zip } from "../server/zip.js";

/** Read an archive the way a tool would: from the end, through the directory. */
function read(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(end, -1, "no end-of-central-directory record");

  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const files = [];

  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50, "central directory entry");
    const nameLen = buf.readUInt16LE(at + 28);
    const sum = buf.readUInt32LE(at + 16);
    const size = buf.readUInt32LE(at + 24);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    const offset = buf.readUInt32LE(at + 42);

    assert.equal(buf.readUInt32LE(offset), 0x04034b50, `local header for ${name}`);
    assert.equal(buf.readUInt16LE(offset + 8), 0, "stored, not deflated");
    const localNameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const start = offset + 30 + localNameLen + extraLen;
    const data = buf.subarray(start, start + size);

    assert.equal(crc32(data), sum, `checksum for ${name}`);
    files.push({ name, data });
    at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return files;
}

describe("crc32", () => {
  it("matches the values every other implementation produces", () => {
    assert.equal(crc32(Buffer.from("")), 0);
    assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
    assert.equal(crc32(Buffer.from("The quick brown fox jumps over the lazy dog")), 0x414fa339);
  });
});

describe("a backup archive", () => {
  it("carries every file back out again, byte for byte", () => {
    const photo = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 1, 2, 3, 255, 254]);
    const files = read(
      zip([
        { name: "wegro.sqlite", data: Buffer.from("SQLite format 3\u0000") },
        { name: "wegro.json", data: Buffer.from('{"tables":{}}', "utf8") },
        { name: "photos/pp_1.webp", data: photo },
      ]),
    );

    assert.deepEqual(
      files.map((f) => f.name),
      ["wegro.sqlite", "wegro.json", "photos/pp_1.webp"],
    );
    assert.equal(files[1].data.toString("utf8"), '{"tables":{}}');
    assert.deepEqual([...files[2].data], [...photo], "a photo survives unchanged");
  });

  it("keeps a name that is not ASCII", () => {
    const [file] = read(zip([{ name: "photos/মুন্না.webp", data: Buffer.from("x") }]));
    assert.equal(file.name, "photos/মুন্না.webp");
  });

  it("is a valid empty archive when there is nothing to back up", () => {
    assert.deepEqual(read(zip([])), []);
  });

  it("handles a file large enough to cross the usual buffer sizes", () => {
    const big = Buffer.alloc(300_000, 7);
    const [file] = read(zip([{ name: "big.bin", data: big }]));
    assert.equal(file.data.length, big.length);
    assert.ok(file.data.equals(big));
  });
});
