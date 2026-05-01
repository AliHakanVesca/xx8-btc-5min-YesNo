import { describe, expect, it } from "vitest";
import type { MarketOrderArgs } from "../../src/infra/clob/types.js";
import {
  assignAffordableSequentialUsdcBalances,
  debitBuyOrderFromUsdcBalance,
  extractInsufficientBalanceUsdc,
  fitBuyOrderToUsdcBalance,
  isNonExecutableResidualBuySizingReason,
} from "../../src/live/orderSizing.js";

function buyOrder(overrides: Partial<MarketOrderArgs> = {}): MarketOrderArgs {
  return {
    tokenId: "token-up",
    side: "BUY",
    price: 0.58,
    amount: 23.2,
    shareTarget: 40,
    orderType: "FAK",
    ...overrides,
  };
}

describe("live order sizing", () => {
  it("downshifts a 40 share buy to the largest affordable ladder clip", () => {
    const result = fitBuyOrderToUsdcBalance(buyOrder(), {
      usdcBalance: 20.46254,
      minOrderSize: 5,
      sizeLadder: [40, 30, 25, 20, 10, 5],
    });

    expect(result.reason).toBe("downshifted_to_affordable_ladder");
    expect(result.adjusted).toBe(true);
    expect(result.order?.shareTarget).toBe(30);
    expect(result.order?.amount).toBe(17.4);
    expect(result.order?.userUsdcBalance).toBe(20.46254);
  });

  it("skips the buy when even the minimum order cannot fit the available balance", () => {
    const result = fitBuyOrderToUsdcBalance(buyOrder({ price: 0.8, amount: 32 }), {
      usdcBalance: 3,
      minOrderSize: 5,
      sizeLadder: [40, 30, 25, 20, 10, 5],
    });

    expect(result.skipped).toBe(true);
    expect(result.order).toBeUndefined();
    expect(result.reason).toBe("insufficient_balance");
  });

  it("skips marketable BUY orders below the CLOB one-dollar notional floor", () => {
    const result = fitBuyOrderToUsdcBalance(
      buyOrder({
        price: 0.15,
        amount: 0.085394,
        shareTarget: 0.569292,
      }),
      {
        usdcBalance: 10,
        minOrderSize: 0.01,
        sizeLadder: [15, 12, 8, 5],
      },
    );

    expect(result.skipped).toBe(true);
    expect(result.order).toBeUndefined();
    expect(result.reason).toBe("below_min_market_buy_amount");
  });

  it("keeps very cheap exact-share FAK buys on the capped limit path", () => {
    const result = fitBuyOrderToUsdcBalance(
      buyOrder({
        price: 0.004,
        amount: 0.02,
        shareTarget: 5,
      }),
      {
        usdcBalance: 10,
        minOrderSize: 5,
        sizeLadder: [5],
      },
    );

    expect(result.skipped).toBe(false);
    expect(result.reason).toBe("fits_balance");
    expect(result.order?.amount).toBe(0.02);
    expect(result.order?.shareTarget).toBe(5);
  });

  it("bridges share-targeted completion buys to the CLOB one-dollar notional floor when overshoot is bounded", () => {
    const result = fitBuyOrderToUsdcBalance(
      buyOrder({
        price: 0.06,
        amount: 0.9,
        shareTarget: 15,
      }),
      {
        usdcBalance: 10,
        minOrderSize: 5,
        sizeLadder: [15],
        allowMinMarketBuyAmountBridge: true,
        enforceMinMarketBuyAmountForExactShareTarget: true,
        maxMinMarketBuyAmountBridgeOvershootShares: 3.75,
      },
    );

    expect(result.skipped).toBe(false);
    expect(result.adjusted).toBe(true);
    expect(result.reason).toBe("bridged_to_min_market_buy_amount");
    expect(result.requestedShares).toBe(15);
    expect(result.order?.amount).toBe(1.02);
    expect(result.order?.shareTarget).toBe(17);
  });

  it("does not submit very cheap exact-size completion buys when min-notional bridge would overshoot too much", () => {
    const result = fitBuyOrderToUsdcBalance(
      buyOrder({
        price: 0.01,
        amount: 0.15,
        shareTarget: 15,
      }),
      {
        usdcBalance: 10,
        minOrderSize: 5,
        sizeLadder: [15],
        allowMinMarketBuyAmountBridge: true,
        enforceMinMarketBuyAmountForExactShareTarget: true,
        maxMinMarketBuyAmountBridgeOvershootShares: 3.75,
      },
    );

    expect(result.skipped).toBe(true);
    expect(result.adjusted).toBe(false);
    expect(result.reason).toBe("below_min_market_buy_amount");
    expect(result.order).toBeUndefined();
  });

  it("blocks the live 11.5 share at 4 cent completion instead of sending a sub-dollar CLOB order", () => {
    const result = fitBuyOrderToUsdcBalance(
      buyOrder({
        price: 0.04,
        amount: 0.46,
        shareTarget: 11.5,
      }),
      {
        usdcBalance: 10,
        minOrderSize: 5,
        sizeLadder: [15],
        allowMinMarketBuyAmountBridge: true,
        enforceMinMarketBuyAmountForExactShareTarget: true,
        maxMinMarketBuyAmountBridgeOvershootShares: 3.75,
      },
    );

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("below_min_market_buy_amount");
    expect(result.order).toBeUndefined();
  });

  it("allows a cheap completion bridge when the one-dollar floor only adds a small clip", () => {
    const result = fitBuyOrderToUsdcBalance(
      buyOrder({
        price: 0.08,
        amount: 0.92,
        shareTarget: 11.5,
      }),
      {
        usdcBalance: 10,
        minOrderSize: 5,
        sizeLadder: [15],
        allowMinMarketBuyAmountBridge: true,
        enforceMinMarketBuyAmountForExactShareTarget: true,
        maxMinMarketBuyAmountBridgeOvershootShares: 3.75,
      },
    );

    expect(result.skipped).toBe(false);
    expect(result.reason).toBe("bridged_to_min_market_buy_amount");
    expect(result.order?.amount).toBe(1);
    expect(result.order?.shareTarget).toBe(12.5);
  });

  it("skips residual BUY orders below the market minimum share size before submit", () => {
    const result = fitBuyOrderToUsdcBalance(
      buyOrder({
        price: 0.75,
        amount: 0.722902,
        shareTarget: 0.963869,
      }),
      {
        usdcBalance: 10,
        minOrderSize: 5,
        sizeLadder: [15, 12, 8, 5],
      },
    );

    expect(result.skipped).toBe(true);
    expect(result.order).toBeUndefined();
    expect(result.reason).toBe("below_min_order_size");
    expect(isNonExecutableResidualBuySizingReason(result.reason)).toBe(true);
  });

  it("normalizes executable BUY orders to CLOB market-buy precision before submit", () => {
    const result = fitBuyOrderToUsdcBalance(
      buyOrder({
        price: 0.31,
        amount: 4.6506,
        shareTarget: 15.001934,
      }),
      {
        usdcBalance: 10,
        minOrderSize: 5,
        sizeLadder: [15, 12, 8, 5],
      },
    );

    expect(result.skipped).toBe(false);
    expect(result.order?.amount).toBe(4.65);
    expect(result.order?.shareTarget).toBe(15);
    expect(result.finalShares).toBe(15);
  });

  it("debits accepted buys with the same fee cushion used for affordability", () => {
    expect(debitBuyOrderFromUsdcBalance(20.46254, buyOrder({ amount: 17.4, shareTarget: 30 }))).toBe(2.36654);
  });

  it("stops sequential child orders once the shared balance is exhausted", () => {
    const orders = assignAffordableSequentialUsdcBalances(
      [
        buyOrder({ price: 0.5, amount: 10, shareTarget: 20 }),
        buyOrder({ price: 0.5, amount: 10, shareTarget: 20 }),
      ],
      {
        usdcBalance: 12,
        minOrderSize: 5,
        sizeLadder: [20, 10, 5],
      },
    );

    expect(orders).toHaveLength(1);
    expect(orders[0]?.shareTarget).toBe(20);
  });

  it("does not keep planning pair children after an exact-share child violates the CLOB notional floor", () => {
    const orders = assignAffordableSequentialUsdcBalances(
      [
        buyOrder({ price: 0.04, amount: 0.46, shareTarget: 11.5 }),
        buyOrder({ price: 0.95, amount: 14.25, shareTarget: 15 }),
      ],
      {
        usdcBalance: 100,
        minOrderSize: 5,
        sizeLadder: [15],
        enforceMinMarketBuyAmountForExactShareTarget: true,
      },
    );

    expect(orders).toHaveLength(0);
  });

  it("extracts CLOB insufficient-balance micro-USDC from nested error payloads", () => {
    const balance = extractInsufficientBalanceUsdc({
      raw: {
        status: 400,
        data: {
          error: "not enough balance / allowance: the balance is not enough -> balance: 20462540, order amount: 23901560",
        },
      },
    });

    expect(balance).toBe(20.46254);
  });
});
