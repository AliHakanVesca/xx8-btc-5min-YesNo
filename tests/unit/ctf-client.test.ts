import { describe, expect, it } from "vitest";
import { resolveCtfCollateralCandidate } from "../../src/infra/ctf/ctfClient.js";

describe("ctf collateral resolver", () => {
  it("selects the collateral whose computed position ids match market token ids", async () => {
    const resolved = await resolveCtfCollateralCandidate({
      candidates: [
        { token: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB", source: "active" },
        { token: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", source: "POLY_USDC_TOKEN" },
      ],
      expected: {
        upTokenId: "27995266331686577911277966556884749439142470368977252235842514730793816598045",
        downTokenId: "92665569458694693351400254718077136090355675324669365164962782318531768579480",
      },
      resolvePositionIds: async (collateralToken) =>
        collateralToken === "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
          ? {
              upPositionId: "27995266331686577911277966556884749439142470368977252235842514730793816598045",
              downPositionId: "92665569458694693351400254718077136090355675324669365164962782318531768579480",
            }
          : {
              upPositionId: "3999559221934569397143358284758001068948498729881030573420108509654499832216",
              downPositionId: "100826240842286210461787272300899516327918984885785202361186627838813932029943",
            },
    });

    expect(resolved).toMatchObject({
      token: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
      source: "POLY_USDC_TOKEN",
    });
  });

  it("fails before submitting a transaction when no collateral maps to token ids", async () => {
    await expect(
      resolveCtfCollateralCandidate({
        candidates: [{ token: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB", source: "active" }],
        expected: {
          upTokenId: "111",
          downTokenId: "222",
        },
        resolvePositionIds: async () => ({
          upPositionId: "333",
          downPositionId: "444",
        }),
      }),
    ).rejects.toThrow(/ctf_collateral_mismatch/);
  });
});
