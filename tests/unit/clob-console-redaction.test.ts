import { describe, expect, it } from "vitest";
import { redactClobSecretText } from "../../src/infra/clob/consoleRedaction.js";

describe("CLOB console redaction", () => {
  it("redacts dependency request-error auth headers and signed payload fields", () => {
    const message = JSON.stringify({
      config: {
        headers: {
          POLY_API_KEY: "api-key-secret",
          POLY_PASSPHRASE: "passphrase-secret",
          POLY_SIGNATURE: "signature-secret",
        },
        data: JSON.stringify({
          owner: "api-key-secret",
          order: {
            signature: "0xabc123",
            tokenId: "safe-token-id",
          },
        }),
      },
    });

    const redacted = redactClobSecretText(message);

    expect(redacted).not.toContain("api-key-secret");
    expect(redacted).not.toContain("passphrase-secret");
    expect(redacted).not.toContain("signature-secret");
    expect(redacted).not.toContain("0xabc123");
    expect(redacted).toContain("safe-token-id");
    expect(redacted).toContain("[redacted]");
  });
});
