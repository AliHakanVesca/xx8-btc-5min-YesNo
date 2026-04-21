# xuanxuan008 Davranış Klonu — Polymarket BTC 5m Bot TODO ve Mimari Spec

**Versiyon:** 2026-04-21  
**Hedef:** `xuanxuan008 / Little-Fraction` hesabının public verilerden görünen davranışına çok yakın çalışan bir Polymarket BTC 5 dakikalık Up/Down botu oluşturmak.  
**Hedef wallet:** `0xcfb103c37c0234f524c632d964ed31f117b5f694`  
**Referans veri:** `xuanxuan008_data_20260415_145447.json`

> Önemli kabul: Başka bir kullanıcının open-order, cancel/replace, user WebSocket ve private execution akışı public değildir. Bu yüzden bu dokümanın hedefi “tam kaynak kod klonu” değil, public footprint ile uyumlu **behavioral clone / execution twin** üretmektir. Başarı ölçütü, kendi botumuzun trade dağılımı, fill zamanlaması, lot ladder’ı, Up/Down dengesi, pair-cost profili, merge davranışı ve risk kontrollerinin xuanxuan008 export’una yaklaşmasıdır.

---

## 0. Strateji Tezi

Bu botun çekirdeği directional BTC tahmini değildir. Hedef strateji:

**BTC 5m Up/Down marketlerinde YES/NO, yani Up/Down, çiftini düşük toplam maliyetle toplamak; mümkün olduğunca maker kalmak; tek bacak dolunca karşı bacağı kontrollü tamamlamak; eşleşen çiftleri CTF merge ile collateral’a çevirmek; kalan one-sided envanteri sıkı limitlerle yönetmek.**

Kısa etiket:

```text
BTC 5m Hybrid Complete-Set Market Maker
= maker-heavy YES/NO pair accumulation
+ Gabagool-style sumAvg hedge guard
+ xuan-like lot ladder/timing
+ CTF merge/redeem worker
+ maker rebate aware execution
```

---

## 1. xuanxuan008 Export’undan Çıkan Davranış Ölçütleri

Bu metrikler `xuanxuan008_data_20260415_145447.json` üzerinden çıkarılmıştır.

| Metrik | Değer | Bot için anlamı |
|---|---:|---|
| Toplam trade | 4000 | Çok yüksek tekrar/frekans |
| Ayrı market | 285 | Neredeyse kesintisiz 5m pencere tarama |
| Side dağılımı | 4000 BUY, 0 SELL | Çıkış ana yolu satış değil, hedge/merge/redeem |
| Outcome dağılımı | 1999 Up / 2001 Down | Directional değil, iki taraflı |
| Equal fill count market | 277/285 | Market başına Up/Down fill sayısı neredeyse simetrik |
| Medyan fill count / market | 14 | Yaklaşık 7 Up + 7 Down cycle |
| Medyan ilk fill | +10s | Market açılır açılmaz aktif |
| Medyan son fill | +254s | Kapanıştan ~46s önce hâlâ aktif |
| Medyan fill size | 60.96 share | Ana lot ~60 share |
| P75/P90/P95 fill size | 91.33 / 120.08 / 144.12 | Lot ladder: 30/60/90/120/145 |
| Medyan Up+Down VWAP toplamı | 0.9771 | Full-set maliyet hedefi ~0.97–0.98 bandı |
| Medyan share imbalance | 1.0831% | Envanter iki taraf arasında çok dengeli |
| Pair VWAP sum < 1.00 | 78.9% | Full-set arbitraj karakteri |
| Pair VWAP sum < 0.982 | 57.5% | Maker+taker completion hipotezine uyumlu |
| Pair VWAP sum < 0.964 | 37.9% | All-taker sonrası bile kârlı olabilecek alt küme |

### 1.1 Kabul edilecek davranışsal hedefler

Yeni bot 1–2 günlük paper/live-small çalışma sonunda şu aralıklara yaklaşmalı:

```text
Market family:                  btc-updown-5m only
BUY/SELL ratio:                 BUY ağırlıklı, SELL yalnızca cut-loss/flatten için
Up/Down fill count symmetry:     >90% markette fark <= 1–2 fill
Median fills per market:         10–18
Median first fill from open:     <= 15s
Median last fill from open:      220–270s
Median fill size:                50–70 shares
Primary lot ladder:              30 / 60 / 90 / 120 / 145 shares
Median inventory imbalance:      < 2%
Median pair VWAP sum:            0.965–0.985
New entry cutoff:                close’dan 30–60s önce
Hard kill cutoff:                close’dan 10–20s önce sadece completion/flatten
```

---

## 2. Kullanılacak Repo / Kaynak Rolleri

Bu projede repolar doğrudan kör kopyalanmayacak. Her repodan belirli fikir ve modül davranışı alınacak.

### 2.1 `direkturcrypto/polymarket-terminal`

Kullanılacak fikirler:

- `maker-mm-bot` mantığı.
- New market detect.
- YES ve NO tarafına aynı anda maker limit BUY.
- `MAKER_MM_MAX_COMBINED` ile toplam bid cap.
- İki taraf dolunca merge.
- Re-entry cycle.
- On-chain balance’ı fill source-of-truth olarak kullanma.
- Ghost fill recovery.
- Stuck one-sided cycle sonrası re-entry durdurma.

Uygulanacak uyarlama:

```text
15m yerine 5m BTC.
5 share yerine xuan-like ladder: 30/60/90/120/145.
No repricing yaklaşımı tamamen kopyalanmayacak; güvenli ve sınırlı reprice yapılacak.
Combined cap ana parametre olacak.
```

### 2.2 `TradeSEB/Polymarket-Trading-Bot-Gabagool`

Kullanılacak fikirler:

- Hedged arbitrage.
- Strict alternation: bir taraf dolunca karşı tarafı tamamlamaya çalışma.
- `sumAvg = avgUp + avgDown` profitability guard.
- Dynamic threshold.
- State persistence.
- Drawdown/position limit.
- Resolved market redeem worker.

Uygulanacak uyarlama:

```text
COPYTRADE_MAX_SUM_AVG ≈ 0.98 default.
xuan-like parametre: MAX_BUYS_PER_SIDE daha yüksek, lot ladder market likiditesine göre değişken.
BTC 5m’de polling değil, WebSocket-first tasarım.
```

### 2.3 `Poly-Tutor` / `PolyScripts` 5m BTC bot ailesi

Kullanılacak fikirler:

- 5m BTC window timing.
- Market discovery / PTB / live BTC oracle alignment.
- Low-latency execution loop.
- Late-window guardrails.
- Dashboards/logging patterns.

Uygulanacak uyarlama:

```text
Directional VWAP/PTB sinyali ana strateji olmayacak.
PTB/live BTC yalnızca risk-skew, late window ve price-to-beat risk filtresi için kullanılacak.
Ana sinyal pair-cost + maker fill + completion edge olacak.
```

### 2.4 `warproxxx/poly-maker`

Kullanılacak fikirler:

- WebSocket orderbook monitoring.
- Position management.
- Automated merge.
- Stats tracking.
- Configurable MM parameters.

Uygulanacak uyarlama:

```text
Google Sheets şart değil.
Config .env + YAML/JSON.
Merge worker ve position/stat modules referans alınacak.
```

### 2.5 Resmi Polymarket SDK/docs

Mutlaka kullanılacak resmi parçalar:

- CLOB client: TypeScript veya Python/Rust resmi client.
- Market channel WebSocket: orderbook snapshot, price changes, trade executions.
- User channel: yalnızca kendi bot hesabımız için private fills/open orders.
- CTF split/merge/redeem.
- Fee model: taker fee formülü ve maker fee = 0.
- Maker rebate tracking.
- CLOB V2 migration: 2026-04-28 cutover dikkate alınacak.

---

## 3. Teknik Stack Kararı

Ana öneri: **TypeScript monorepo**.

Neden:

- `TradeSEB/Gabagool` TypeScript.
- Polymarket official CLOB client TypeScript tarafında güçlü.
- Ethers.js ile CTF split/merge/redeem kolay.
- Codex’in hızlı üretmesi ve debug etmesi daha kolay.

Opsiyonel ileri aşama:

- Hot path WebSocket/orderbook recorder Rust’a taşınabilir.
- İlk sürümde Rust zorunlu değil; davranış klonunun asıl farkı strateji ve state engine.

### 3.1 CLOB V2 uyumluluğu

2026-04-21 itibarıyla Polymarket CLOB V2 migration dokümanı 2026-04-28 go-live planlıyor. Bu yüzden uygulama doğrudan adapter pattern ile yazılmalı:

```ts
interface ClobAdapter {
  getMarket(conditionIdOrToken: string): Promise<MarketInfo>;
  getOrderBook(tokenId: string): Promise<OrderBook>;
  postLimitOrder(args: LimitOrderArgs): Promise<OrderResult>;
  postMarketOrder(args: MarketOrderArgs): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<void>;
  cancelMarket(conditionId: string): Promise<void>;
  getOpenOrders(): Promise<Order[]>;
  getTickSize(tokenId: string): Promise<string>;
}
```

İlk commit’te:

```text
src/infra/clob/v1Adapter.ts
src/infra/clob/v2Adapter.ts
src/infra/clob/index.ts
```

`USE_CLOB_V2=true` default olmalı; gerekirse `.env` ile v1’e düşülmeli.

---

## 4. Hedef Klasör Yapısı

```text
xuanclone/
  package.json
  tsconfig.json
  .env.example
  README.md
  TODO.md
  docs/
    xuan_strategy_notes.md
    api_notes.md
    security_checklist.md
  data/
    xuanxuan008_data_20260415_145447.json
    backtests/
    recorder/
  src/
    main.ts

    config/
      env.ts
      schema.ts
      strategyPresets.ts

    infra/
      clob/
        types.ts
        v1Adapter.ts
        v2Adapter.ts
        index.ts
      gamma/
        gammaClient.ts
        marketDiscovery.ts
      dataApi/
        dataApiClient.ts
        xuanAnalyzer.ts
      ws/
        marketWsClient.ts
        userWsClient.ts
        reconnect.ts
      polygon/
        erc1155Balances.ts
        erc20Balances.ts
        txWatcher.ts
      ctf/
        ctfClient.ts
        split.ts
        merge.ts
        redeem.ts
      time/
        clock.ts
        windowScheduler.ts

    strategy/
      xuan5m/
        Xuan5mBot.ts
        marketState.ts
        orderBookState.ts
        inventoryState.ts
        quoteEngine.ts
        sumAvgEngine.ts
        completionEngine.ts
        lotLadder.ts
        riskEngine.ts
        fillDetector.ts
        mergeCoordinator.ts
        scheduler.ts
        metrics.ts

    execution/
      orderManager.ts
      postOnlyManager.ts
      takerCompletionManager.ts
      cancelManager.ts
      heartbeat.ts
      rateLimiter.ts

    analytics/
      backtestXuan.ts
      replaySimulator.ts
      acceptanceMetrics.ts
      pnlLedger.ts

    observability/
      logger.ts
      metricsServer.ts
      dashboard.ts
      alerts.ts

  tests/
    unit/
    integration/
    fixtures/
```

---

## 5. Ana Modül Spec’i

### 5.1 `marketDiscovery.ts`

Görev:

- Aktif ve bir sonraki BTC 5m marketlerini bul.
- Slug pattern:

```text
btc-updown-5m-${window_start_unix}
```

- Her market için:
  - `conditionId`
  - `slug`
  - `startTs`
  - `endTs`
  - Up token ID
  - Down token ID
  - tick size
  - min size
  - fee enabled / fee rate
  - price-to-beat, varsa
  - closed/resolved status

TODO:

- [ ] Current window start hesapla: `Math.floor(now / 300) * 300`.
- [ ] Current + next + previous window için market metadata çek.
- [ ] Gamma API ve CLOB market endpointlerini birlikte kullan.
- [ ] Token ordering’i kesinleştir: outcome `Up`/`Down` by label, index’e kör güvenme.
- [ ] Market status closed/resolved ise trade etme.
- [ ] Market metadata cache TTL: 10s.
- [ ] Her market transition’da eski market emirlerini cancel et.

---

### 5.2 `marketWsClient.ts`

Görev:

- Public market channel’a Up/Down token ID’leri ile subscribe ol.
- Snapshot + incremental updates ile local L2 book tut.
- Event türleri:
  - book snapshot
  - price change
  - last trade
  - best bid/ask
  - market resolved/closed, varsa

TODO:

- [ ] Auto reconnect.
- [ ] Heartbeat/ping-pong.
- [ ] Sequence gap detection.
- [ ] Gap varsa REST snapshot ile resync.
- [ ] `bestBid`, `bestAsk`, `spread`, `mid`, `depthAt(price)` fonksiyonları.
- [ ] Her update’i `data/recorder/YYYY-MM-DD/*.jsonl` olarak kaydet.
- [ ] Latency ölç: receive timestamp - event timestamp.
- [ ] `asset_id -> outcome` mapping logla.

---

### 5.3 `userWsClient.ts`

Görev:

- Sadece kendi bot wallet’ımızın authenticated user stream’ini takip et.
- Order fill, open order, cancel event ve fee bilgilerini al.
- xuanxuan008’in private stream’i çekilemez; bu modül bizim bot için gereklidir.

TODO:

- [ ] Auth headers/env güvenli kurulmalı.
- [ ] Fills geldiğinde `fillDetector` state’ini güncelle.
- [ ] Her fill için maker/taker, fee, order_id, asset, price, size sakla.
- [ ] WebSocket düşerse REST `getOpenOrders` + balances ile state reconcile et.
- [ ] User stream ile on-chain balance uyuşmazsa on-chain’i source-of-truth kabul et.

---

### 5.4 `erc1155Balances.ts`

Görev:

- Her markette Up/Down ERC1155 token bakiyelerini Polygon RPC ile oku.
- Fill source-of-truth olarak kullan.
- Ghost fill / API fill / actual token balance farkını yakala.

TODO:

- [ ] `balanceOf(wallet, tokenId)` helper.
- [ ] Batch balance read.
- [ ] Poll interval: active markette 1–2s; idle’da 10–30s.
- [ ] Fill event sonrası hemen balance verify.
- [ ] Balance delta’dan fill infer et.
- [ ] State snapshot DB’ye yaz.

---

### 5.5 `ctfClient.ts`, `merge.ts`, `redeem.ts`

Görev:

- Split, merge, redeem işlemlerini yürüt.
- xuan-like botta ana çıkış yolu sell değil merge/redeem olduğundan bu modül kritik.

TODO:

- [ ] Env’den CTF contract, collateral token, relayer config oku.
- [ ] `merge(conditionId, amount)` uygula.
- [ ] `redeem(conditionId)` uygula.
- [ ] `mergeable = min(upBalance, downBalance)` hesapla.
- [ ] `mergeable >= MERGE_MIN_SHARES` ise merge kuyruğuna al.
- [ ] Merge sonrası pUSD/USDC balance verify.
- [ ] Resolved marketleri tarayıp winner redeem et.
- [ ] Tx hash, amount, pre/post balances ledger’a yaz.
- [ ] Merge/redeem fail olursa retry + alert.

---

## 6. Strateji Modülü: `Xuan5mBot`

### 6.1 State Model

Her aktif market için:

```ts
type XuanMarketState = {
  slug: string;
  conditionId: string;
  startTs: number;
  endTs: number;

  upTokenId: string;
  downTokenId: string;
  tickSize: string;

  upShares: number;
  downShares: number;
  upCost: number;
  downCost: number;

  upAvg: number | null;
  downAvg: number | null;
  sumAvg: number | null;

  openOrders: Map<string, OpenOrder>;
  fillHistory: Fill[];
  mergeHistory: MergeEvent[];

  lastFilledSide?: "UP" | "DOWN";
  stuckSide?: "UP" | "DOWN";
  reentryDisabled: boolean;

  cycleNo: number;
  firstFillSec?: number;
  lastFillSec?: number;
};
```

Derived fields:

```ts
mergeableShares = Math.min(upShares, downShares)
imbalance = Math.abs(upShares - downShares) / Math.max(upShares + downShares, 1)
sumAvg = upAvg + downAvg
pairVwapSum = upCost/upShares + downCost/downShares
secsFromOpen = now - startTs
secsToClose = endTs - now
```

---

### 6.2 Parametre Preset’i: `xuan_like_default`

```ts
export const XUAN_LIKE_DEFAULT = {
  MARKET_ASSET: "btc",
  MARKET_DURATION_SEC: 300,

  // Combined/full-set economics
  COMBINED_CAP_BASE: 0.977,
  COMBINED_CAP_SAFE: 0.970,
  COMBINED_CAP_AGGRESSIVE: 0.982,
  HARD_PAIR_TAKER_CAP: 0.964,
  COMPLETION_CAP_WITH_ONE_MAKER_LEG: 0.982,
  MIN_EDGE_PER_SHARE: 0.004,

  // Fees
  CRYPTO_TAKER_FEE_RATE: 0.072,
  MAKER_FEE_RATE: 0,

  // Timing
  ENTER_FROM_OPEN_SEC_MIN: 3,
  ENTER_FROM_OPEN_SEC_MAX: 230,
  NORMAL_ENTRY_CUTOFF_SEC_TO_CLOSE: 60,
  COMPLETION_ONLY_CUTOFF_SEC_TO_CLOSE: 20,
  HARD_CANCEL_SEC_TO_CLOSE: 10,

  // Repricing
  REQUOTE_INTERVAL_MS: 500,
  MIN_REQUOTE_PRICE_DIFF: 0.01,
  MAX_REQUOTE_PER_MARKET: 40,
  POST_ONLY: true,

  // Inventory
  MAX_MARKET_SHARES_PER_SIDE: 500,
  MAX_ONE_SIDED_EXPOSURE_SHARES: 160,
  MAX_IMBALANCE_FRAC: 0.02,
  FORCE_REBALANCE_IMBALANCE_FRAC: 0.05,

  // Lot ladder
  LOT_LADDER: [30, 60, 90, 120, 145],
  LOT_RARE_SCALE: [180, 220],
  DEFAULT_LOT: 60,
  MIN_ORDER_SHARES: 5,

  // Cycles
  MAX_CYCLES_PER_MARKET: 8,
  MAX_BUYS_PER_SIDE: 10,
  REENTRY_DELAY_MS: 1000,

  // Merge/redeem
  MERGE_MIN_SHARES: 5,
  MERGE_IMMEDIATELY: true,
  REDEEM_RESOLVED: true,

  // Kill switches
  DAILY_MAX_LOSS_USDC: 50,
  MARKET_MAX_LOSS_USDC: 10,
  MAX_CONSECUTIVE_STUCK_MARKETS: 3,
  MIN_USDC_BALANCE: 10,
  DRY_RUN: true,
};
```

Canlıya geçerken ilk değerler:

```text
COMBINED_CAP_BASE=0.975
COMBINED_CAP_AGGRESSIVE=0.980
COMPLETION_CAP_WITH_ONE_MAKER_LEG=0.980
LOT_LADDER=30,60
MAX_MARKET_SHARES_PER_SIDE=120
DRY_RUN=false only after paper validation
```

---

## 7. Karar Motorları

### 7.1 Taker fee fonksiyonu

```ts
function takerFeeUsd(size: number, price: number, feeRate = 0.072): number {
  return size * feeRate * price * (1 - price);
}

function takerFeePerShare(price: number, feeRate = 0.072): number {
  return feeRate * price * (1 - price);
}
```

### 7.2 Hard pair taker arb

Sadece çok net opportunity için:

```ts
pairCostPerShare =
  askUp
  + askDown
  + takerFeePerShare(askUp)
  + takerFeePerShare(askDown)

if pairCostPerShare <= HARD_PAIR_TAKER_CAP:
    qty = min(depthUp, depthDown, lot)
    FAK/FOK buy Up
    FAK/FOK buy Down
    verify balances
    merge matched
```

Varsayılan: çok nadir çalışmalı. Çünkü xuan footprint daha çok maker+taker / maker+maker gibi duruyor.

### 7.3 Maker pair quoting

Ana motor:

```ts
targetCombined = chooseCapByRegime()

referenceUpBid =
  clamp(bestBidUp + oneTick, minPrice, maxPrice)
  OR model-derived bid based on book/PTB

targetUpBid = roundToTick(referenceUpBid)
targetDownBid = roundToTick(targetCombined - targetUpBid)

if targetUpBid <= 0 or targetDownBid <= 0:
    skip

if targetUpBid + targetDownBid > targetCombined:
    reduce one side by one tick

postOnly GTC/GTD BUY Up at targetUpBid
postOnly GTC/GTD BUY Down at targetDownBid
```

Regime seçimleri:

```text
sec_from_open 3–45:     daha agresif, cap 0.978–0.982
sec_from_open 45–210:   normal, cap 0.972–0.978
sec_to_close 60–20:     sadece re-entry düşük riskliyse
sec_to_close <20:       no new pair; completion/merge/flatten only
```

### 7.4 Gabagool-style sumAvg completion

Bir bacak dolduğunda:

```ts
if upShares > downShares:
    missing = upShares - downShares
    completionPrice = bestAskDown
    completionCost = upAvg + completionPrice + takerFeePerShare(completionPrice)

    if completionCost <= COMPLETION_CAP_WITH_ONE_MAKER_LEG:
        takerBuyDown(min(missing, depthDown, lot))
        verify balance
        mergeable = min(upShares, downShares)
        merge(mergeable)
    else:
        quoteDownPostOnlyMoreAggressive()
```

Simetri:

```ts
if downShares > upShares:
    same logic with Up completion
```

### 7.5 Strict alternation

- Son fill Up ise bir sonraki aggressive action Down tarafında olmalı.
- Son fill Down ise bir sonraki aggressive action Up tarafında olmalı.
- Aynı tarafa üst üste fill gelirse:
  - quote skew opposite side lehine çevrilir,
  - same-side yeni order azaltılır/cancel edilir,
  - imbalance limit aşılırsa re-entry durdurulur.

### 7.6 Merge policy

```ts
mergeable = min(upShares, downShares)

if mergeable >= MERGE_MIN_SHARES:
    merge(mergeable)
    upShares -= mergeable
    downShares -= mergeable
    realizedLockedProfit += mergeable * (1 - pairCostAtMerge)
```

Merge sonrası:

- State ledger güncelle.
- Open order state temizle.
- Bir sonraki cycle için re-entry delay uygula.
- Eğer stuck market ise re-entry yok.

---

## 8. Lot Ladder

xuan export’una göre fill size bucket’ları:

```text
Small:       30–35 shares
Medium:      58–63 shares
Normal+:     86–92 shares
Large:       116–123 shares
Scale:       136–145 shares
Rare scale:  175–225 shares
```

İlk canlı sürüm:

```ts
function chooseLot(ctx: MarketContext): number {
  if (ctx.dryRunOrSmallLive) return 30;

  if (ctx.secsFromOpen < 45 && ctx.bookDepthGood && ctx.imbalance < 0.01) return 60;
  if (ctx.secsFromOpen < 120 && ctx.edgeStrong && ctx.recentBothSidesFilled) return 90;
  if (ctx.edgeVeryStrong && ctx.mergeSuccessThisMarket >= 2) return 120;
  if (ctx.edgeVeryStrong && ctx.marketVolumeHigh && ctx.pnlTodayPositive) return 145;

  return 60;
}
```

Hard limits:

```text
Do not use 180/220 lots until 7 days of live-small logs prove stability.
MAX_ONE_SIDED_EXPOSURE_SHARES < one large ladder step.
MAX_MARKET_EXPOSURE caps all lot choices.
```

---

## 9. Timing Engine

### 9.1 Market lifecycle

```text
T-10s before next market: discover and prefetch next market
T+0s to T+3s: wait until market live and book snapshot stable
T+3s to T+45s: first entry window, aggressive pair quote allowed
T+45s to T+230s: normal cycle/re-entry
T+230s to T+280s: conservative, completion-biased
T+280s to close: cancel new entries; completion/merge/redeem/flatten only
T+close: cancel all open orders, redeem/resolve watcher
```

xuan metrics target:

```text
median first fill ≈ +10s
median last fill ≈ +254s
```

### 9.2 Scheduler TODO

- [ ] Current and next BTC 5m window scheduler.
- [ ] Clock drift guard with NTP-ish check.
- [ ] On window transition:
  - [ ] cancel previous market open orders,
  - [ ] merge matched leftovers,
  - [ ] mark one-sided leftovers,
  - [ ] subscribe next Up/Down assets,
  - [ ] reset market state.
- [ ] Never open new pair after cutoff.
- [ ] Allow only completion if an existing one-sided position can be hedged profitably.

---

## 10. Risk Engine

### 10.1 Hard no-trade conditions

- [ ] Market metadata missing.
- [ ] Up/Down token mapping uncertain.
- [ ] WebSocket book stale > 2s.
- [ ] RPC balance stale > 5s after fill.
- [ ] `feesEnabled` unknown.
- [ ] Tick size unknown.
- [ ] Best ask/bid spread absurd or crossed.
- [ ] `secsToClose < HARD_CANCEL_SEC_TO_CLOSE`.
- [ ] One-sided exposure > limit.
- [ ] Daily loss > limit.
- [ ] Consecutive stuck markets >= 3.
- [ ] CLOB API 429/503 storm.
- [ ] Polygon RPC degraded.

### 10.2 Stuck leg handling

Stuck leg = only one outcome filled and opposite side is too expensive to complete.

Policy:

```text
1. Stop same-side re-entry.
2. Quote opposite side post-only more aggressively but still under completion cap.
3. If near close and completion not possible:
   a) if held side likely wins by PTB/live BTC, carry to resolution;
   b) otherwise try controlled SELL/cut-loss only if spread acceptable;
   c) if sell spread is terrible, hold and redeem if wins.
4. Log as stuck_market.
```

Do not average into same side if imbalance already > 2–5%.

### 10.3 Ghost fill recovery

Borrowed from direktur-style logic:

```text
If CLOB says order filled / order disappeared
BUT ERC1155 balance did not increase
AND txHash invalid/missing:
    mark ghost fill candidate
    do not assume inventory exists
    reconcile via balances
    cancel related order if still open
    avoid completion based on phantom shares
```

---

## 11. Execution Manager

### 11.1 Post-only maker order

Use post-only for maker guarantees:

```ts
postOrder(signedOrder, OrderType.GTC, true)
```

Rules:

- GTC/GTD only.
- If post-only rejected because it crosses spread, recompute price one tick lower.
- No marketable post-only.
- Use unique client order id/metadata when available.

### 11.2 Taker completion

Use FAK preferred, FOK only when exact full size is required:

```text
FAK: fill available, cancel rest — useful for partial completion.
FOK: all-or-nothing — useful when partial would create imbalance.
```

Taker order must include worst-price slippage protection.

### 11.3 Cancel policy

- Cancel all open orders on market transition.
- Cancel same-side orders when that side is overweight.
- Cancel all if book stale.
- Cancel all if `secsToClose < HARD_CANCEL_SEC_TO_CLOSE`.
- Cancel all on kill switch.

---

## 12. Historical Collector ve xuan Analyzer

Public data puller:

```text
GET /trades?user=<wallet>&takerOnly=true
GET /trades?user=<wallet>&takerOnly=false
GET /activity?user=<wallet>&type=TRADE,SPLIT,MERGE,REDEEM,MAKER_REBATE
GET /positions?user=<wallet>&sizeThreshold=0
GET /closed-positions?user=<wallet>
GET /v1/accounting/snapshot?user=<wallet>
```

TODO:

- [ ] `scripts/fetchXuanPublicFootprint.ts`.
- [ ] Pagination/offset support.
- [ ] `takerOnly=true` vs `false` diff ile maker candidate infer.
- [ ] Activity ledger’da `SPLIT/MERGE/MAKER_REBATE` eventlerini ayrı tabloya yaz.
- [ ] JSON/CSV export.
- [ ] xuan metrics recompute:
  - [ ] per-market fill count,
  - [ ] Up/Down fill symmetry,
  - [ ] lot ladder,
  - [ ] first/last fill timing,
  - [ ] pair VWAP sum,
  - [ ] activity merge/rebate count.

---

## 13. Backtest / Replay

### 13.1 xuan footprint replay

Amaç: Botun parametreleri xuan’ın görünen trade dağılımını yeniden üretebiliyor mu?

TODO:

- [ ] `analytics/backtestXuan.ts`.
- [ ] Referans JSON’dan marketleri sırala.
- [ ] Her market için:
  - [ ] xuan fill sequence extract,
  - [ ] pair/cycle grouping,
  - [ ] estimated maker/taker classification,
  - [ ] target lot ladder çıkar.
- [ ] Kendi strategy engine’i historical orderbook olmadan “behavioral simulator” ile çalıştır.
- [ ] Metrik farkı raporla:
  - [ ] fill count median farkı,
  - [ ] lot distribution KL divergence,
  - [ ] Up/Down imbalance,
  - [ ] pair VWAP sum distribution,
  - [ ] timing distribution.

### 13.2 Live paper mode

Paper mode gerçek market WebSocket’i ve CLOB book’u izler ama emir göndermez.

TODO:

- [ ] Her markette botun koyacağı quote’ları kaydet.
- [ ] Public last trade/orderbook ile “would fill” simülasyonu yap.
- [ ] Simüle edilmiş pair_cost ve imbalance çıkar.
- [ ] 24 saat paper logs.
- [ ] Parametre kalibrasyonu.

Acceptance:

```text
paper_pair_vwap_median <= 0.982
paper_imbalance_median <= 0.02
paper_fill_count_median between 8 and 18
paper_stuck_markets <= 15%
```

---

## 14. Observability

### 14.1 Logs

JSONL logs:

```text
logs/orders.jsonl
logs/fills.jsonl
logs/merges.jsonl
logs/risk.jsonl
logs/markets.jsonl
logs/pnl.jsonl
logs/errors.jsonl
```

Her event:

```json
{
  "ts": 1776253506,
  "market": "btc-updown-5m-1776253500",
  "conditionId": "...",
  "event": "FILL",
  "side": "UP",
  "price": 0.48,
  "size": 127.05,
  "makerTaker": "maker",
  "orderId": "...",
  "txHash": "...",
  "upShares": 127.05,
  "downShares": 0,
  "imbalance": 1.0
}
```

### 14.2 Dashboard

Minimal terminal dashboard:

```text
Current market
Seconds from open / to close
Up bid/ask, Down bid/ask
Our quotes
Our inventory
sumAvg
mergeable
open orders
realized merged profit
stuck status
today PnL
kill switches
```

### 14.3 Alerts

- Telegram/Discord optional.
- Alerts:
  - stuck market,
  - merge fail,
  - open order not canceled,
  - balance mismatch,
  - API degraded,
  - daily loss hit,
  - CLOB migration/config mismatch.

---

## 15. Security Checklist

Public GitHub botlarını ana cüzdan private key’iyle çalıştırma.

TODO:

- [ ] Yeni izole wallet oluştur.
- [ ] İlk test bakiyesi: 10–50 USDC/pUSD.
- [ ] `.env` asla commitlenmeyecek.
- [ ] `npm audit`, `npm ls`, `pnpm audit` veya `yarn audit`.
- [ ] Repo içinde şunlar taranacak:
  - [ ] bilinmeyen domain’e `fetch/axios/request`,
  - [ ] `child_process.exec/spawn`,
  - [ ] `eval`, `Function`, base64 decode + eval,
  - [ ] `.env` dosyasını okuyup dışarı gönderen kod,
  - [ ] postinstall/preinstall scriptleri,
  - [ ] obfuscated/minified dosyalar.
- [ ] Docker/container içinde çalıştır.
- [ ] Read-only filesystem, network allowlist mümkünse.
- [ ] Tek kullanımlık API key.
- [ ] İlk canlı testte max 1 lot ve DRY_RUN’dan yeni çıkmış durum.

---

## 16. Implementation TODO — Sıralı Plan

### Faz 0 — Repo hazırlık ve audit

- [ ] Yeni repo oluştur: `xuanclone`.
- [ ] `third_party/` içine referans repoları clone et:
  - [ ] `direkturcrypto/polymarket-terminal`
  - [ ] `TradeSEB/Polymarket-Trading-Bot-Gabagool`
  - [ ] `Poly-Tutor/polymarket-5min-15min-1hour-arbitrage-trading-bot-tools`
  - [ ] `warproxxx/poly-maker`
- [ ] Her repo için security audit checklist uygula.
- [ ] Kaynak kodu doğrudan import etmeden önce lisans ve risk notu çıkar.
- [ ] Asıl uygulamayı kendi `src/` altında yaz; third-party sadece referans.

### Faz 1 — Config ve temel SDK

- [ ] TypeScript strict project kur.
- [ ] `.env.example` oluştur.
- [ ] Zod/env schema yaz.
- [ ] `ClobAdapter` interface yaz.
- [ ] V1/V2 adapter skeleton yaz.
- [ ] Gamma/Data API client yaz.
- [ ] Polygon RPC client yaz.
- [ ] CTF client skeleton yaz.

### Faz 2 — Data analyzer

- [ ] Uploaded xuan JSON’u `data/` altına koy.
- [ ] `xuanAnalyzer.ts` yaz.
- [ ] Metrikleri çıkar:
  - [ ] market count,
  - [ ] fill count,
  - [ ] Up/Down symmetry,
  - [ ] size quantiles,
  - [ ] timing quantiles,
  - [ ] pair VWAP sum,
  - [ ] imbalance.
- [ ] `npm run analyze:xuan` komutu ekle.
- [ ] `reports/xuan_metrics.md` üret.

### Faz 3 — Market discovery

- [ ] Current BTC 5m slug hesaplama.
- [ ] Current/next market metadata fetch.
- [ ] Up/Down token mapping.
- [ ] tick size fetch.
- [ ] market transition scheduler.
- [ ] stale/closed market guard.

### Faz 4 — WebSocket book engine

- [ ] Market WebSocket client.
- [ ] Snapshot/delta local book.
- [ ] best bid/ask helpers.
- [ ] recorder JSONL.
- [ ] reconnect/resync.
- [ ] stale book detection.

### Faz 5 — Execution engine

- [ ] Post-only GTC/GTD buy order.
- [ ] FAK/FOK taker completion order.
- [ ] Batch order support.
- [ ] Cancel order / cancel market / cancel all.
- [ ] Order id tracking.
- [ ] Open order reconciliation.
- [ ] Rate limiter.
- [ ] Heartbeat.

### Faz 6 — Fill & balance reconciliation

- [ ] User WebSocket.
- [ ] ERC1155 balance poll.
- [ ] Fill event → balance verify.
- [ ] Ghost fill detector.
- [ ] Maker/taker classification.
- [ ] Ledger persistence.

### Faz 7 — Strategy core

- [ ] `lotLadder.ts`.
- [ ] `quoteEngine.ts`.
- [ ] `sumAvgEngine.ts`.
- [ ] `completionEngine.ts`.
- [ ] `riskEngine.ts`.
- [ ] `mergeCoordinator.ts`.
- [ ] `Xuan5mBot.ts`.
- [ ] Dry-run mode.
- [ ] Paper mode.

### Faz 8 — CTF merge/redeem

- [ ] Merge function.
- [ ] Redeem function.
- [ ] Merge queue.
- [ ] Tx watcher.
- [ ] Balance verify.
- [ ] Merge/redeem ledger.
- [ ] Resolved market sweeper.

### Faz 9 — Backtest/paper validation

- [ ] xuan behavioral simulator.
- [ ] Paper live recorder.
- [ ] Acceptance metrics.
- [ ] Daily report.
- [ ] Param tuning script.

### Faz 10 — Live-small rollout

- [ ] Dedicated wallet.
- [ ] Max lot 30.
- [ ] Max exposure 60/side.
- [ ] 3–6 saat canlı small.
- [ ] Compare metrics vs xuan profile.
- [ ] Gradually enable 60/90 lot only if:
  - [ ] no ghost fill,
  - [ ] no merge fail,
  - [ ] stuck rate acceptable,
  - [ ] pair cost median acceptable,
  - [ ] no daily loss breach.

---

## 17. Acceptance Criteria

Bot tamamlandı denebilmesi için:

### 17.1 Kod kalitesi

- [ ] `npm test` geçiyor.
- [ ] TypeScript strict errors yok.
- [ ] Config validation çalışıyor.
- [ ] Dry-run ve paper mode var.
- [ ] Unit tests:
  - [ ] fee formula,
  - [ ] sumAvg,
  - [ ] lot ladder,
  - [ ] inventory imbalance,
  - [ ] pair-cost guard,
  - [ ] tick rounding,
  - [ ] scheduler windows.
- [ ] Integration tests:
  - [ ] market discovery,
  - [ ] orderbook snapshot parse,
  - [ ] fake fill reconciliation,
  - [ ] merge function mock.

### 17.2 Davranış metrikleri

24 saat paper/live-small sonrası:

- [ ] BTC 5m dışında işlem yok.
- [ ] Up/Down fill count farkı medyan <= 1.
- [ ] Inventory imbalance medyan < 2%.
- [ ] Fill size medyan 50–70.
- [ ] First fill medyan <= 15s.
- [ ] Last fill medyan 220–270s.
- [ ] Pair VWAP sum medyan 0.965–0.985.
- [ ] Stuck market rate < 15%.
- [ ] Mergeable çiftler otomatik merge ediliyor.
- [ ] Açık emirler market transition’da kalmıyor.
- [ ] Daily kill switch çalışıyor.

### 17.3 Güvenlik

- [ ] Main wallet kullanılmadı.
- [ ] Secrets commitlenmedi.
- [ ] Unknown outbound network call yok.
- [ ] Dependency audit yapıldı.
- [ ] Bot crash olunca open orders cancel/reconcile ediliyor.

---

## 18. Codex’e Verilecek Prompt

Aşağıdaki prompt’u Codex’e ver ve bu `.md` dosyasını ek olarak attach et:

```text
Sen kıdemli bir TypeScript/Node.js trading-systems mühendisisin. Ekteki `xuanxuan008_bot_clone_todolist.md` dosyasını tek kaynak spec olarak kullanarak bir Polymarket BTC 5m Up/Down market-maker/arbitrage botu geliştir.

Amaç: xuanxuan008 / Little-Fraction hesabının public trade footprint’ine davranışsal olarak çok yakın bir bot üretmek. Bu bir directional BTC tahmin botu değil; BTC 5m Up/Down marketlerinde maker-heavy YES/NO complete-set accumulation, Gabagool-style sumAvg hedge guard, taker completion, CTF merge/redeem ve xuan-like lot/timing/risk engine içeren bir execution botu olacak.

Lütfen aşağıdaki kurallara uy:

1. Önce repo yapısını oluştur:
   - TypeScript strict project
   - `src/` altında modüler yapı
   - `.env.example`
   - `README.md`
   - `TODO.md`
   - test klasörleri

2. Referans repoları kör kopyalama. Dokümandaki davranış ve mimariyi kendi temiz implementasyonunla kur:
   - direkturcrypto/polymarket-terminal: combined cap, maker pair MM, on-chain balance source-of-truth, stuck/ghost fill recovery fikri
   - TradeSEB/Gabagool: sumAvg guard, strict alternation, state persistence
   - Poly-Tutor/PolyScripts: BTC 5m timing/latency/dashboards fikri
   - warproxxx/poly-maker: WebSocket/orderbook/merge/stats mimari fikri
   - resmi Polymarket CLOB/CTF docs: order execution, post-only, FAK/FOK, split/merge/redeem, fees

3. CLOB V2 migration için adapter pattern kullan:
   - `ClobAdapter` interface
   - `v1Adapter.ts`
   - `v2Adapter.ts`
   - default `USE_CLOB_V2=true`, ama env ile değiştirilebilir
   - gerçek API fonksiyonlarında mümkün olduğunca official Polymarket SDK/client kullan

4. İlk çalışır MVP şu modülleri içermeli:
   - env/config validation
   - market discovery: current/next `btc-updown-5m-${windowStartUnix}`
   - market WebSocket client ve local orderbook
   - user WebSocket skeleton
   - Polygon ERC1155 balance reader skeleton
   - CTF merge/redeem skeleton
   - Xuan5m strategy engine
   - post-only maker order manager
   - FAK/FOK taker completion manager
   - risk engine
   - xuan JSON analyzer
   - dry-run/paper mode
   - structured logs

5. Strateji engine kuralları:
   - Ana market: BTC 5m only.
   - Ana davranış: Up ve Down tarafını dengeli toplamak.
   - `COMBINED_CAP_BASE≈0.977`, `COMPLETION_CAP≈0.982`, `HARD_PAIR_TAKER_CAP≈0.964`.
   - Fee formula: `size * 0.072 * price * (1 - price)` for crypto taker fees.
   - Maker orderlar post-only GTC/GTD olmalı.
   - Taker completion sadece pair cost post-fee pozitifse çalışmalı.
   - Lot ladder: 30/60/90/120/145; ilk live-small default 30/60.
   - New entry cutoff close’dan 30–60s önce; son 10–20s yalnızca completion/cancel/merge.
   - Inventory imbalance medyan hedefi <2%; hard limit >5%.
   - Mergeable çiftler `min(upShares, downShares)` ile hemen merge kuyruğuna alınmalı.

6. Güvenlik:
   - Ana wallet private key’i kullanılmasın.
   - `.env` commitlenmesin.
   - Third-party repolardan gizli outbound request, `eval`, `child_process`, postinstall script gibi riskleri audit eden bir script veya checklist ekle.
   - Varsayılan `DRY_RUN=true`.

7. Testler:
   - Unit tests: fee, tick rounding, sumAvg, pair cost, lot ladder, risk windows, imbalance.
   - Integration mocks: orderbook snapshot, fake fills, merge queue.
   - Analyzer test: ekteki xuan JSON’dan metrikleri hesaplayabilsin.

8. Çıktı beklentisi:
   - Çalışır skeleton + temel strategy logic
   - `npm run analyze:xuan`
   - `npm run paper`
   - `npm run bot:dry`
   - `npm test`
   - README içinde kurulum, env, güvenlik, paper mode ve live-small rollout anlatımı

Kod yazarken eksik API detaylarında compile-safe adapter/skeleton oluştur; TODO yorumları bırak ama ana mimariyi ve strategy logic’i implement et. Gereksiz UI veya büyük dashboard ile başlama; önce doğru state machine, risk, order, fill, merge ve analyzer altyapısını kur.
```

---

## 19. Kaynak Listesi

- https://github.com/direkturcrypto/polymarket-terminal
- https://github.com/TradeSEB/Polymarket-Trading-Bot-Gabagool
- https://github.com/Poly-Tutor/polymarket-5min-15min-1hour-arbitrage-trading-bot-tools
- https://github.com/PolyScripts/polymarket-5min-15min-1hr-btc-arbitrage-trading-bot-rust
- https://github.com/warproxxx/poly-maker
- https://docs.polymarket.com/trading/orders/overview
- https://docs.polymarket.com/trading/orders/create
- https://docs.polymarket.com/market-data/websocket/market-channel
- https://docs.polymarket.com/trading/ctf/overview
- https://docs.polymarket.com/trading/ctf/split
- https://docs.polymarket.com/trading/ctf/merge
- https://docs.polymarket.com/trading/fees
- https://docs.polymarket.com/market-makers/maker-rebates
- https://docs.polymarket.com/v2-migration

---

## 20. En Kritik Noktalar

Bu projede “aynı bot”a yaklaşmayı sağlayacak 5 şey:

1. **BTC 5m only**: başka marketlere dağılma.
2. **Pair/full-set ekonomi**: yön tahmini yerine Up+Down maliyeti.
3. **Maker-heavy execution**: post-only ve düşük combined cap.
4. **Balance-first fill detection**: CLOB event değil, ERC1155 balance source-of-truth.
5. **Merge/redeem discipline**: matched pairs hemen merge, stuck legs sıkı yönetim.

Bunlar doğru yapılmadan sadece repo birleştirmek xuanxuan008 davranışını üretmez.
