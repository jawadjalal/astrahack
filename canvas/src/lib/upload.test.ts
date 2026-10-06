// Run: npx tsx --test src/lib/upload.test.ts   (pure logic only: the real Blob path needs the deployed site)
import test from "node:test";
import assert from "node:assert/strict";
import {
  MULTIPART_MAX_BYTES,
  chooseStrategy,
  classifyMedia,
  fitSize,
  isTokenRouteFailure,
  layoutRow,
  mediaKindOfUrl,
  validateMediaFile,
} from "./upload";

const MB = 1024 * 1024;

test("chooseStrategy: small files are always multipart", () => {
  for (const mode of ["unknown", "blob", "local"] as const) {
    assert.equal(chooseStrategy(1 * MB, mode), "multipart");
    assert.equal(chooseStrategy(MULTIPART_MAX_BYTES, mode), "multipart");
  }
});

test("chooseStrategy: >4MB goes direct unless the server is known not to have Blob", () => {
  assert.equal(chooseStrategy(MULTIPART_MAX_BYTES + 1, "unknown"), "direct");
  assert.equal(chooseStrategy(40 * MB, "blob"), "direct");
  assert.equal(chooseStrategy(40 * MB, "local"), "multipart");
});

test("isTokenRouteFailure matches the Blob client token errors only", () => {
  assert.ok(isTokenRouteFailure(new Error("Vercel Blob: Failed to  retrieve the client token")));
  assert.ok(isTokenRouteFailure(new Error("Failed to retrieve the presigned URL")));
  assert.ok(!isTokenRouteFailure(new Error("Network request failed")));
  assert.ok(!isTokenRouteFailure(new Error("Upload cancelled.")));
});

test("classifyMedia / validateMediaFile", () => {
  assert.deepEqual(classifyMedia("a.PNG", ""), { kind: "image", contentType: "image/png" });
  assert.deepEqual(classifyMedia("clip.mov", ""), { kind: "video", contentType: "video/quicktime" });
  assert.deepEqual(classifyMedia("x", "video/webm"), { kind: "video", contentType: "video/webm" });
  assert.equal(classifyMedia("doc.pdf", "application/pdf"), null);
  assert.equal(classifyMedia("pic.bmp", "image/bmp"), null);
  assert.throws(() => validateMediaFile({ name: "a.pdf", type: "application/pdf", size: 10 }), /Unsupported/);
  assert.throws(() => validateMediaFile({ name: "a.mp4", type: "video/mp4", size: 0 }), /empty/);
  assert.throws(() => validateMediaFile({ name: "a.mp4", type: "video/mp4", size: 600 * MB }), /500MB/);
  assert.equal(validateMediaFile({ name: "a.mp4", type: "", size: 5 * MB }).kind, "video");
});

test("mediaKindOfUrl ignores query/hash and non-http", () => {
  assert.equal(mediaKindOfUrl("https://x.com/a/b.mp4?token=1#t=3"), "video");
  assert.equal(mediaKindOfUrl("https://x.com/pic.jpeg"), "image");
  assert.equal(mediaKindOfUrl("https://x.com/page"), null);
  assert.equal(mediaKindOfUrl("data:image/png;base64,AAAA"), null);
  assert.equal(mediaKindOfUrl("not a url"), null);
});

test("fitSize: videos max 720 wide, images never upscale", () => {
  assert.deepEqual(fitSize("video", 1920, 1080), { w: 720, h: 405 });
  assert.deepEqual(fitSize("video", 1080, 1920).h <= 800, true);
  assert.deepEqual(fitSize("image", 400, 300), { w: 400, h: 300 });
  assert.deepEqual(fitSize("image", 1800, 900), { w: 900, h: 450 });
  assert.deepEqual(fitSize("video", 640, 360), { w: 640, h: 360 });
  assert.equal(fitSize("video", 120, 90).w, 240); // tiny clips scale up to stay usable
  assert.equal(fitSize("video", undefined, undefined).w, 720);
});

test("layoutRow lays out left to right and wraps", () => {
  const pts = layoutRow([{ w: 500, h: 200 }, { w: 500, h: 300 }, { w: 2000, h: 100 }], { x: 10, y: 20 }, 50, 1200);
  assert.deepEqual(pts[0], { x: 10, y: 20 });
  assert.deepEqual(pts[1], { x: 560, y: 20 });
  assert.deepEqual(pts[2], { x: 10, y: 20 + 300 + 50 });
});
