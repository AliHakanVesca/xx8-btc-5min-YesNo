import {
  Chain as V2Chain,
  ClobClient as V2ClobClient,
  OrderType as V2OrderType,
  Side as V2Side,
  SignatureTypeV2,
  type ApiKeyCreds as V2ApiKeyCreds,
} from "@polymarket/clob-client-v2";
import { createHash } from "node:crypto";
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
import { deriveOrderResultSuccess } from "./orderResult.js";

const BYTES32_ZERO = `0x${"0".repeat(64)}`;
const BYTES32_HEX = /^0x[0-9a-fA-F]{64}$/;

function toV2Chain(chainId: number): V2Chain {
  return chainId === 80002 ? V2Chain.AMOY : V2Chain.POLYGON;
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

function createCreds(env: AppEnv): V2ApiKeyCreds | undefined {
  if (!env.POLY_API_KEY || !env.POLY_API_SECRET || !env.POLY_API_PASSPHRASE) {
    return undefined;
  }
  return {
    key: env.POLY_API_KEY,
    secret: env.POLY_API_SECRET,
    passphrase: env.POLY_API_PASSPHRASE,
  };
}

export function normalizeV2MetadataBytes32(metadata: string | undefined): string | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  const value = metadata.trim();
  if (value.length === 0) {
    return BYTES32_ZERO;
  }
  if (BYTES32_HEX.test(value)) {
    return value;
  }
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

export function normalizeV2BuilderCodeBytes32(builderCode: string | undefined): string | undefined {
  if (builderCode === undefined) {
    return undefined;
  }
  const value = builderCode.trim();
  if (value.length === 0) {
    return BYTES32_ZERO;
  }
  if (!BYTES32_HEX.test(value)) {
    throw new Error("CLOB V2 builderCode bytes32 hex olmali.");
  }
  return value;
}

function mapOrderBook(summary: {
  market: string;
  asset_id: string;
  timestamp: string;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
  min_order_size: string;
  tick_size: string;
  neg_risk: boolean;
  hash?: string;
}): OrderBook {
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

export class V2Adapter implements ClobAdapter {
  readonly version = "v2" as const;
  private readonly client: V2ClobClient;

  constructor(private readonly env: AppEnv) {
    const signer = createSigner(env);
    const creds = createCreds(env);
    this.client = new V2ClobClient({
      host: env.POLY_CLOB_BASE_URL,
      chain: toV2Chain(env.POLY_CHAIN_ID),
      ...(signer ? { signer } : {}),
      ...(creds ? { creds } : {}),
      signatureType: env.POLY_SIGNATURE_TYPE as SignatureTypeV2,
      ...(env.POLY_FUNDER ? { funderAddress: env.POLY_FUNDER } : {}),
      retryOnError: true,
    });
  }

  async getMarket(conditionId: string): Promise<unknown> {
    return this.client.getMarket(conditionId);
  }

  async getClobMarketInfo(conditionId: string): Promise<ClobMarketInfo | null> {
    const info = await this.client.getClobMarketInfo(conditionId);
    const infoAny = info as any;
    return {
      tickSize: Number(info.mts),
      minOrderSize: Number(infoAny.mos ?? infoAny.minimum_order_size ?? 0),
      feeRate: Number(info.fd?.r ?? 0),
      feeExponent: Number(info.fd?.e ?? 0),
      takerOnlyFees: Boolean(info.fd?.to),
      negRisk: info.nr,
      tokens: (info.t ?? [])
        .filter((token): token is NonNullable<(typeof info.t)[number]> => token !== null)
        .map((token) => ({
          tokenId: token.t,
          outcome: token.o,
        })),
    };
  }

  async getOrderBook(tokenId: string): Promise<OrderBook> {
    const summary = await this.client.getOrderBook(tokenId);
    return mapOrderBook(summary);
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
    const metadata = normalizeV2MetadataBytes32(args.metadata);
    const builderCode = normalizeV2BuilderCodeBytes32(args.builderCode);
    const orderPayload = {
      tokenID: args.tokenId,
      price: args.price,
      size: args.size,
      side: args.side === "SELL" ? V2Side.SELL : V2Side.BUY,
      ...(args.expiration !== undefined ? { expiration: args.expiration } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
      ...(builderCode !== undefined ? { builderCode } : {}),
    };
    const signedOrder = await this.client.createOrder(
      orderPayload,
      {
        tickSize,
        negRisk,
      },
    );
    const response = await this.client.postOrder(signedOrder, args.orderType as V2OrderType, args.postOnly ?? true);
    return this.mapOrderResult(response, "submitted");
  }

  async postMarketOrder(args: MarketOrderArgs): Promise<OrderResult> {
    if (this.env.DRY_RUN || !this.env.BOT_PRIVATE_KEY || !this.env.POLY_API_KEY) {
      return this.simulatedResult(`dry-market-${args.tokenId}`, "dry_market");
    }

    const tickSize = await this.client.getTickSize(args.tokenId);
    const negRisk = await this.client.getNegRisk(args.tokenId);
    const metadata = normalizeV2MetadataBytes32(args.metadata);
    const builderCode = normalizeV2BuilderCodeBytes32(args.builderCode);
    const orderPayload = {
      tokenID: args.tokenId,
      amount: args.amount,
      side: args.side === "SELL" ? V2Side.SELL : V2Side.BUY,
      orderType: args.orderType as V2OrderType.FAK | V2OrderType.FOK,
      ...(args.price !== undefined ? { price: args.price } : {}),
      ...(args.userUsdcBalance !== undefined ? { userUSDCBalance: args.userUsdcBalance } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
      ...(builderCode !== undefined ? { builderCode } : {}),
    };
    const signedOrder = await this.client.createMarketOrder(
      orderPayload,
      {
        tickSize,
        negRisk,
      },
    );
    const response = await this.client.postOrder(signedOrder, args.orderType as V2OrderType);
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
    const result = await this.client.postHeartbeat(heartbeatId);
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
      success: deriveOrderResultSuccess(raw, raw?.status ?? fallbackStatus),
      simulated: false,
      orderId: raw?.orderID ?? raw?.orderId ?? "unknown-order-id",
      status: raw?.status ?? fallbackStatus,
      raw,
      requestedAt: Date.now(),
    };
  }
}
