import {
  Chain as V1Chain,
  ClobClient as V1ClobClient,
  OrderType as V1OrderType,
  Side as V1Side,
  SignatureType as V1SignatureType,
  type ApiKeyCreds as V1ApiKeyCreds,
} from "@polymarket/clob-client";
import { createWalletClient, http, type Hex, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon, polygonAmoy } from "viem/chains";
import type { AppEnv } from "../../config/schema.js";
import type {
  CancelMarketArgs,
  ClobAdapter,
  ClobMarketInfo,
  LimitOrderArgs,
  MarketOrderArgs,
  OpenOrderView,
  OrderBook,
  OrderResult,
} from "./types.js";

function toV1Chain(chainId: number): V1Chain {
  return chainId === 80002 ? V1Chain.AMOY : V1Chain.POLYGON;
}

function createSigner(env: AppEnv): WalletClient | undefined {
  if (!env.BOT_PRIVATE_KEY) {
    return undefined;
  }

  const account = privateKeyToAccount(env.BOT_PRIVATE_KEY as Hex);
  return createWalletClient({
    account,
    chain: env.POLY_CHAIN_ID === 80002 ? polygonAmoy : polygon,
    transport: http(env.POLY_RPC_URL),
  }) as WalletClient;
}

function createCreds(env: AppEnv): V1ApiKeyCreds | undefined {
  if (!env.POLY_API_KEY || !env.POLY_API_SECRET || !env.POLY_API_PASSPHRASE) {
    return undefined;
  }
  return {
    key: env.POLY_API_KEY,
    secret: env.POLY_API_SECRET,
    passphrase: env.POLY_API_PASSPHRASE,
  };
}

function mapOpenOrder(order: {
  id: string;
  market: string;
  asset_id: string;
  side: string;
  outcome: string;
  price: string;
  original_size: string;
  size_matched: string;
  status: string;
  expiration: string;
}): OpenOrderView {
  return {
    id: order.id,
    market: order.market,
    assetId: order.asset_id,
    side: order.side === "SELL" ? "SELL" : "BUY",
    outcome: order.outcome,
    price: Number(order.price),
    originalSize: Number(order.original_size),
    matchedSize: Number(order.size_matched),
    status: order.status,
    expiration: Number(order.expiration || 0) || undefined,
  };
}

export class V1Adapter implements ClobAdapter {
  readonly version = "v1" as const;
  private readonly client: V1ClobClient;

  constructor(private readonly env: AppEnv) {
    this.client = new V1ClobClient(
      env.POLY_CLOB_BASE_URL,
      toV1Chain(env.POLY_CHAIN_ID),
      createSigner(env),
      createCreds(env),
      env.POLY_SIGNATURE_TYPE as V1SignatureType,
      env.POLY_FUNDER,
      undefined,
      true,
      undefined,
      undefined,
      true,
    );
  }

  async getMarket(conditionId: string): Promise<unknown> {
    return this.client.getMarket(conditionId);
  }

  async getClobMarketInfo(conditionId: string): Promise<ClobMarketInfo | null> {
    const market = await this.client.getMarket(conditionId);
    const tokens = Array.isArray(market?.tokens)
      ? market.tokens
          .map((token: any) => ({
            tokenId: String(token.token_id ?? token.tokenId ?? token.id ?? ""),
            outcome: String(token.outcome ?? token.label ?? ""),
          }))
          .filter((token: { tokenId: string; outcome: string }) => token.tokenId.length > 0)
      : [];

    return {
      tickSize: Number(tokens[0]?.tokenId ? await this.client.getTickSize(tokens[0].tokenId) : 0.01),
      minOrderSize: Number(market?.minimum_order_size ?? 0),
      feeRate: Number(tokens[0]?.tokenId ? await this.client.getFeeRateBps(tokens[0].tokenId) : 0),
      feeExponent: 0,
      takerOnlyFees: false,
      negRisk: Boolean(tokens[0]?.tokenId ? await this.client.getNegRisk(tokens[0].tokenId) : false),
      tokens,
    };
  }

  async getOrderBook(tokenId: string): Promise<OrderBook> {
    const summary = await this.client.getOrderBook(tokenId);
    return {
      market: summary.market,
      assetId: summary.asset_id,
      timestamp: Number(summary.timestamp),
      bids: summary.bids.map((level) => ({ price: Number(level.price), size: Number(level.size) })),
      asks: summary.asks.map((level) => ({ price: Number(level.price), size: Number(level.size) })),
      minOrderSize: Number(summary.min_order_size),
      tickSize: Number(summary.tick_size),
      negRisk: summary.neg_risk,
      hash: summary.hash,
    };
  }

  async getTickSize(tokenId: string): Promise<number> {
    return Number(await this.client.getTickSize(tokenId));
  }

  async getOpenOrders(params?: CancelMarketArgs): Promise<OpenOrderView[]> {
    const orders = await this.client.getOpenOrders({
      ...(params?.market !== undefined ? { market: params.market } : {}),
      ...(params?.assetId !== undefined ? { asset_id: params.assetId } : {}),
    });
    return orders.map(mapOpenOrder);
  }

  async postLimitOrder(args: LimitOrderArgs): Promise<OrderResult> {
    if (this.env.DRY_RUN || !this.env.BOT_PRIVATE_KEY || !this.env.POLY_API_KEY) {
      return this.simulatedResult(`dry-limit-${args.tokenId}`, "dry_limit");
    }

    const tickSize = await this.client.getTickSize(args.tokenId);
    const negRisk = await this.client.getNegRisk(args.tokenId);
    const orderPayload = {
      tokenID: args.tokenId,
      price: args.price,
      size: args.size,
      side: args.side === "SELL" ? V1Side.SELL : V1Side.BUY,
      ...(args.expiration !== undefined ? { expiration: args.expiration } : {}),
    };
    const signedOrder = await this.client.createOrder(
      orderPayload,
      {
        tickSize,
        negRisk,
      },
    );
    const response = await this.client.postOrder(
      signedOrder,
      args.orderType as V1OrderType,
      false,
      args.postOnly ?? true,
    );
    return this.mapOrderResult(response, "submitted");
  }

  async postMarketOrder(args: MarketOrderArgs): Promise<OrderResult> {
    if (this.env.DRY_RUN || !this.env.BOT_PRIVATE_KEY || !this.env.POLY_API_KEY) {
      return this.simulatedResult(`dry-market-${args.tokenId}`, "dry_market");
    }

    const tickSize = await this.client.getTickSize(args.tokenId);
    const negRisk = await this.client.getNegRisk(args.tokenId);
    const orderPayload = {
      tokenID: args.tokenId,
      amount: args.amount,
      side: args.side === "SELL" ? V1Side.SELL : V1Side.BUY,
      ...(args.price !== undefined ? { price: args.price } : {}),
    };
    const signedOrder = await this.client.createMarketOrder(
      orderPayload,
      {
        tickSize,
        negRisk,
      },
    );
    const response = await this.client.postOrder(signedOrder, args.orderType as V1OrderType);
    return this.mapOrderResult(response, "submitted");
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.client.cancelOrder({ orderID: orderId });
  }

  async cancelMarket(args: CancelMarketArgs): Promise<void> {
    await this.client.cancelMarketOrders({
      ...(args.market !== undefined ? { market: args.market } : {}),
      ...(args.assetId !== undefined ? { asset_id: args.assetId } : {}),
    });
  }

  async cancelAll(): Promise<void> {
    await this.client.cancelAll();
  }

  async postHeartbeat(heartbeatId?: string): Promise<{ heartbeatId: string }> {
    const result = await this.client.postHeartbeat(heartbeatId ?? null);
    return { heartbeatId: result.heartbeat_id };
  }

  private simulatedResult(orderId: string, status: string): OrderResult {
    return {
      success: true,
      simulated: true,
      orderId,
      status,
      requestedAt: Date.now(),
    };
  }

  private mapOrderResult(raw: any, fallbackStatus: string): OrderResult {
    return {
      success: raw?.success ?? true,
      simulated: false,
      orderId: raw?.orderID ?? raw?.orderId ?? "unknown-order-id",
      status: raw?.status ?? fallbackStatus,
      raw,
      requestedAt: Date.now(),
    };
  }
}
