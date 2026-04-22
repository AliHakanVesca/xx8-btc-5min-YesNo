export type OutcomeSide = "UP" | "DOWN";
export type TradeSide = "BUY" | "SELL";
export type MakerOrderType = "GTC" | "GTD";
export type TakerOrderType = "FAK" | "FOK";

export interface MarketToken {
  tokenId: string;
  outcome: OutcomeSide;
  label: string;
}

export interface MarketInfo {
  slug: string;
  conditionId: string;
  startTs: number;
  endTs: number;
  tickSize: number;
  minOrderSize: number;
  feeRate: number;
  feesEnabled: boolean;
  negRisk: boolean;
  priceToBeat?: number | undefined;
  priceToBeatSource?: "metadata" | "estimated" | undefined;
  tokens: Record<OutcomeSide, MarketToken>;
  source: "gamma" | "clob" | "fallback";
}

export interface OrderLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  market: string;
  assetId: string;
  timestamp: number;
  bids: OrderLevel[];
  asks: OrderLevel[];
  tickSize: number;
  minOrderSize: number;
  negRisk: boolean;
  hash?: string | undefined;
}

export interface LimitOrderArgs {
  tokenId: string;
  price: number;
  size: number;
  side: TradeSide;
  orderType: MakerOrderType;
  expiration?: number | undefined;
  postOnly?: boolean | undefined;
  metadata?: string | undefined;
  builderCode?: string | undefined;
}

export interface MarketOrderArgs {
  tokenId: string;
  price?: number | undefined;
  amount: number;
  shareTarget?: number | undefined;
  side: TradeSide;
  orderType: TakerOrderType;
  userUsdcBalance?: number | undefined;
  metadata?: string | undefined;
  builderCode?: string | undefined;
}

export interface OrderResult {
  success: boolean;
  simulated: boolean;
  orderId: string;
  status: string;
  raw?: unknown;
  requestedAt: number;
}

export interface OpenOrderView {
  id: string;
  market: string;
  assetId: string;
  side: TradeSide;
  outcome?: string | undefined;
  price: number;
  originalSize: number;
  matchedSize: number;
  status: string;
  expiration?: number | undefined;
}

export interface ClobMarketInfo {
  tickSize: number;
  minOrderSize: number;
  feeRate: number;
  feeExponent: number;
  takerOnlyFees: boolean;
  negRisk: boolean;
  tokens: Array<{ tokenId: string; outcome: string }>;
}

export interface CancelMarketArgs {
  market?: string | undefined;
  assetId?: string | undefined;
}

export interface ClobAdapter {
  readonly version: "v1" | "v2";
  getMarket(conditionId: string): Promise<unknown>;
  getClobMarketInfo(conditionId: string): Promise<ClobMarketInfo | null>;
  getOrderBook(tokenId: string): Promise<OrderBook>;
  getTickSize(tokenId: string): Promise<number>;
  getOpenOrders(params?: CancelMarketArgs): Promise<OpenOrderView[]>;
  postLimitOrder(args: LimitOrderArgs): Promise<OrderResult>;
  postMarketOrder(args: MarketOrderArgs): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<void>;
  cancelMarket(args: CancelMarketArgs): Promise<void>;
  cancelAll(): Promise<void>;
  postHeartbeat?(heartbeatId?: string): Promise<{ heartbeatId: string }>;
}
