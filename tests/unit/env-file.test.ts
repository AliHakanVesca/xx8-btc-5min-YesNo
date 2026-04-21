import { describe, expect, it } from "vitest";
import { updateEnvContents } from "../../src/config/envFile.js";

describe("env file updates", () => {
  it("replaces existing keys without touching unrelated lines", () => {
    const updated = updateEnvContents(
      ["DRY_RUN=true", "POLY_API_KEY=", "# keep this", "POLY_API_SECRET=old-secret", ""].join("\n"),
      {
        POLY_API_KEY: "new-key",
        POLY_API_SECRET: "new-secret",
      },
    );

    expect(updated).toContain("DRY_RUN=true");
    expect(updated).toContain("POLY_API_KEY=new-key");
    expect(updated).toContain("POLY_API_SECRET=new-secret");
    expect(updated).toContain("# keep this");
  });

  it("appends missing keys at the end", () => {
    const updated = updateEnvContents("DRY_RUN=true\n", {
      POLY_API_KEY: "new-key",
      POLY_API_PASSPHRASE: "new-passphrase",
    });

    expect(updated).toContain("DRY_RUN=true");
    expect(updated).toContain("POLY_API_KEY=new-key");
    expect(updated).toContain("POLY_API_PASSPHRASE=new-passphrase");
    expect(updated.endsWith("\n")).toBe(true);
  });
});
