import { expect, test } from "bun:test";
import { tryTern } from "./entry.ts";

test("TSP negotiation missing: keep original terminal path", async () => {
  let probes = 0;
  const handled = await tryTern("http://127.0.0.1:8788", {}, "1.0.138", async (options) => {
    expect(options?.app).toBe("unii");
    expect(options?.version).toBe("1.0.138");
    probes++;
    return null;
  });
  expect(probes).toBe(1);
  expect(handled).toBe(false);
});
