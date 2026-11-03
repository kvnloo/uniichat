import { expect, test } from "bun:test";
import { prompt_read } from "./Acp.ts";

test("an ACP prompt reads as one message: text, links, embedded files, images", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
  const { said, images } = prompt_read([
    { type: "text", text: "look at this" },
    { type: "resource_link", uri: "file:///repo/a.ts", name: "a.ts" },
    { type: "resource", resource: { uri: "file:///repo/b.ts", text: "export {}" } },
    { type: "image", data: png, mimeType: "image/png" },
    { type: "audio", data: "", mimeType: "audio/wav" },
  ]);
  expect(said).toBe("look at this\n\nfile:///repo/a.ts\n\n<file uri=\"file:///repo/b.ts\">\nexport {}\n</file>");
  expect(images.length).toBe(1);
  expect(images[0].type).toBe("image/png");
  expect([...new Uint8Array(await images[0].arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47]);
});
