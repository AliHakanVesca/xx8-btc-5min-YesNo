import { describe, expect, it } from "vitest";
import { normalizeV2BuilderCodeBytes32, normalizeV2MetadataBytes32 } from "../../src/infra/clob/v2Adapter.js";

describe("CLOB V2 adapter bytes32 fields", () => {
  it("hashes human-readable metadata to bytes32", () => {
    const up = normalizeV2MetadataBytes32("pair-0x6cd487c2-1777453804086:UP");
    const down = normalizeV2MetadataBytes32("pair-0x6cd487c2-1777453804765:DOWN");

    expect(up).toMatch(/^0x[0-9a-f]{64}$/);
    expect(down).toMatch(/^0x[0-9a-f]{64}$/);
    expect(up).not.toBe(down);
  });

  it("preserves already valid bytes32 metadata", () => {
    const bytes32 = `0x${"a".repeat(64)}`;
    expect(normalizeV2MetadataBytes32(bytes32)).toBe(bytes32);
  });

  it("rejects invalid builder codes instead of signing malformed V2 orders", () => {
    expect(() => normalizeV2BuilderCodeBytes32("not-bytes32")).toThrow(/bytes32/);
    expect(normalizeV2BuilderCodeBytes32(`0x${"0".repeat(64)}`)).toBe(`0x${"0".repeat(64)}`);
  });
});
