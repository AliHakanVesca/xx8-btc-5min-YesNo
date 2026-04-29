# External Operator Runbook

Bu not, botu baska bir makinede / baska bir operator hesabinda calistirmak icin
hazirlandi. Gercek `.env` icindeki private key, API key, secret, passphrase,
relayer key, wallet/funder adresi ve private RPC degerleri buraya yazilmadi.

## Kisa ozet

- Repo: `xx8-btc-5min-yesno`
- Runtime: Node.js `>=22`
- Dil / build: TypeScript ESM
- Ana hedef: Polymarket BTC 5m Up/Down marketlerinde Xuan-style, buy-only agirlikli
  taker pair accumulation, lagging-side rebalance, completion, merge ve redeem akisi.
- Varsayilan guvenlik durumu: `DRY_RUN=true`
- Canli emir gondermek icin: `DRY_RUN=false`, izole wallet, yeterli collateral,
  CLOB API credential seti, RPC, allowance ve `npm run live:check` gecisi gerekir.

## Makine hazirligi

```bash
node --version
npm --version
npm install
npm run typecheck
npm test
```

Beklenen minimum Node surumu `22.0.0` veya ustudur.

## Operatorun doldurmasi gereken gizli / kisiye ozel alanlar

Bu alanlar her operator icin kendi degerleriyle doldurulmalidir:

```dotenv
BOT_WALLET_ADDRESS=<operator_wallet_adresi>
BOT_PRIVATE_KEY=<operator_private_key>
POLY_FUNDER=<operator_funder_veya_proxy_adresi>
POLY_API_KEY=<clob_api_key>
POLY_API_SECRET=<clob_api_secret>
POLY_API_PASSPHRASE=<clob_api_passphrase>
POLY_RELAYER_API_KEY=<relayer_api_key>
POLY_RELAYER_API_KEY_ADDRESS=<relayer_api_key_address>
POLY_RPC_URL=<private_veya_authenticated_polygon_rpc_url>
```

Notlar:

- Ana wallet private key kullanilmaz; dusuk bakiyeli izole rollout wallet kullanilir.
- `POLY_SIGNATURE_TYPE=2` kullaniliyorsa `POLY_FUNDER` ve relayer alanlari topology ile
  uyumlu olmalidir.
- `POLY_API_KEY`, `POLY_API_SECRET`, `POLY_API_PASSPHRASE` alanlari su komutla
  turetilebilir:

```bash
npm run clob:derive -- --write-env
```

Bu komut operator makinesindeki `.env` dosyasina CLOB credential setini yazar.

## Mevcut transfer `.env` profili

Asagidaki profil mevcut runtime ayarlarindan sanitize edilmis transfer profilidir.
Gizli ve kisiye ozel alanlar placeholder olarak birakildi.

```dotenv
NODE_ENV=development
POLY_STACK_MODE=post-cutover-v2
DRY_RUN=true
USE_CLOB_V2=true
LOG_LEVEL=info
BOT_WALLET_ADDRESS=<OPERATOR_ADRESI_GIRILECEK>
BOT_PRIVATE_KEY=<GIZLI_GIRILECEK>
POLY_SIGNATURE_TYPE=2
POLY_FUNDER=<OPERATOR_ADRESI_GIRILECEK>
POLY_API_KEY=<GIZLI_GIRILECEK>
POLY_API_SECRET=<GIZLI_GIRILECEK>
POLY_API_PASSPHRASE=<GIZLI_GIRILECEK>
POLY_RELAYER_API_KEY=<GIZLI_GIRILECEK>
POLY_RELAYER_API_KEY_ADDRESS=<OPERATOR_ADRESI_GIRILECEK>
POLY_RELAYER_BASE_URL=https://relayer-v2.polymarket.com
POLY_CHAIN_ID=137
POLY_RPC_URL=<PRIVATE_RPC_URL_GIRILECEK>
POLY_CLOB_BASE_URL=https://clob.polymarket.com
POLY_GAMMA_BASE_URL=https://gamma-api.polymarket.com
POLY_DATA_API_BASE_URL=https://data-api.polymarket.com
POLY_MARKET_WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market
POLY_USER_WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/user
CTF_CONTRACT_ADDRESS=0x4D97DCd97eC945f40cF65F87097ACe5EA0476045
POLY_USDC_TOKEN=0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174
POLY_PUSD_TOKEN=0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB
POLY_COLLATERAL_TOKEN=
CTF_MERGE_ENABLED=true
MERGE_MIN_SHARES=5
BOT_MODE=XUAN
XUAN_CLONE_MODE=PUBLIC_FOOTPRINT
XUAN_CLONE_INTENSITY=AGGRESSIVE
ENABLE_MAKER_LAYER=false
COMPLETION_CAP=0.982
MIN_EDGE_PER_SHARE=0.004
STRICT_PAIR_EFFECTIVE_CAP=1.006
NORMAL_PAIR_EFFECTIVE_CAP=1.020
PAIR_SWEEP_STRICT_CAP=1.006
XUAN_PAIR_SWEEP_SOFT_CAP=1.020
XUAN_PAIR_SWEEP_HARD_CAP=1.045
ENABLE_XUAN_HARD_PAIR_SWEEP=true
COMPLETION_STRICT_CAP=1.000
COMPLETION_SOFT_CAP=1.015
COMPLETION_HARD_CAP=1.030
EMERGENCY_COMPLETION_HARD_CAP=1.045
EMERGENCY_COMPLETION_MAX_QTY=5
EMERGENCY_REQUIRES_HARD_IMBALANCE=true
MAX_NEGATIVE_PAIR_EDGE_PER_CYCLE_USDC=3
MAX_NEGATIVE_PAIR_EDGE_PER_MARKET_USDC=5
MAX_NEGATIVE_DAILY_BUDGET_USDC=8
MAX_NEGATIVE_EDGE_PER_MARKET_USDC=5
MAX_MARKET_EXPOSURE_SHARES=80
SOFT_IMBALANCE_RATIO=0.02
HARD_IMBALANCE_RATIO=0.05
COMPLETION_QTY_MODE=MISSING_ONLY
POST_MERGE_MAX_COMPLETION_QTY_MODE=RESIDUAL_ONLY
MAX_COMPLETION_OVERSHOOT_SHARES=0.25
FORBID_BUY_THAT_INCREASES_IMBALANCE=true
POST_MERGE_NEW_SEED_COOLDOWN_MS=0
POST_MERGE_ONLY_COMPLETION=false
HIGH_SIDE_PRICE_THRESHOLD=0.75
LOW_SIDE_MAX_FOR_HIGH_COMPLETION=0.20
REQUIRE_STRICT_CAP_FOR_HIGH_LOW_MISMATCH=true
LOT_SCALING_MODE=BANKROLL_ADJUSTED
LOT_LADDER=5,8,12,15
XUAN_BASE_LOT_LADDER=5,8,12,15
LIVE_SMALL_LOTS=5,8,12,15
LIVE_SMALL_LOT_LADDER=5,8,12,15
DEFAULT_LOT=5
MAX_MARKET_NOTIONAL_PCT=0.45
MAX_SINGLE_ORDER_NOTIONAL_PCT=0.25
MAX_MARKET_SHARES_PER_SIDE=80
MAX_ONE_SIDED_EXPOSURE_SHARES=45
MAX_IMBALANCE_FRAC=0.02
FORCE_REBALANCE_IMBALANCE_FRAC=0.05
MAX_CYCLES_PER_MARKET=3
MAX_BUYS_PER_SIDE=4
ENTER_FROM_OPEN_SEC_MIN=3
ENTER_FROM_OPEN_SEC_MAX=230
NORMAL_ENTRY_CUTOFF_SEC_TO_CLOSE=60
COMPLETION_ONLY_CUTOFF_SEC_TO_CLOSE=20
HARD_CANCEL_SEC_TO_CLOSE=10
DAILY_MAX_LOSS_USDC=10
MARKET_MAX_LOSS_USDC=4
MIN_USDC_BALANCE=10
MIN_USDC_BALANCE_FOR_NEW_ENTRY=12
MIN_USDC_BALANCE_FOR_COMPLETION=3
ALLOW_SINGLE_LEG_SEED=true
ALLOW_TEMPORAL_SINGLE_LEG_SEED=true
TEMPORAL_SINGLE_LEG_TTL_SEC=90
TEMPORAL_SINGLE_LEG_MIN_OPPOSITE_DEPTH_RATIO=0.90
XUAN_BEHAVIOR_CAP=1.25
ALLOW_CHEAP_UNDERDOG_SEED=false
ALLOW_XUAN_COVERED_SEED=true
SINGLE_LEG_ORPHAN_CAP=0.97
ORPHAN_LEG_MAX_NOTIONAL_USDC=40
MAX_MARKET_ORPHAN_USDC=45
MAX_SINGLE_ORPHAN_QTY=15
ALLOW_COVERED_SEED_SAME_PAIRGROUP=true
ALLOW_COVERED_SEED_OPPOSITE_INVENTORY=false
ALLOW_NAKED_SINGLE_LEG_SEED=false
PRICE_TO_BEAT_POLICY=EXPLICIT_OR_START_CAPTURE
PRICE_TO_BEAT_START_CAPTURE_WINDOW_MS=3000
PRICE_TO_BEAT_MAX_FEED_AGE_MS=1000
PRICE_TO_BEAT_PROVISIONAL_ALLOWED=true
PRICE_TO_BEAT_EXPLICIT_OVERRIDE_ALLOWED=true
PRICE_TO_BEAT_FAIL_CLOSED_AFTER_SEC=15
PRICE_TO_BEAT_LATE_START_FALLBACK_ENABLED=false
PRICE_TO_BEAT_LATE_START_MAX_MARKET_AGE_SEC=90
PRICE_TO_BEAT_LATE_START_MAX_FEED_AGE_MS=1000
MERGE_BATCH_MODE=HYBRID_DELAYED
MIN_COMPLETED_CYCLES_BEFORE_FIRST_MERGE=2
MIN_FIRST_MATCHED_AGE_BEFORE_MERGE_SEC=45
MAX_MATCHED_AGE_BEFORE_FORCED_MERGE_SEC=75
FORCE_MERGE_IN_LAST_30S=true
FORCE_MERGE_ON_HARD_IMBALANCE=true
FORCE_MERGE_ON_LOW_COLLATERAL=true
REQUIRE_MATCHED_INVENTORY_BEFORE_SECOND_GROUP=false
WORST_CASE_AMPLIFICATION_TOLERANCE_SHARES=125
BLOCK_NEW_ENTRY_ON_EXTERNAL_ACTIVITY=true
REQUIRE_RECONCILE_AFTER_MANUAL_TRADE=true
BOOK_STALE_MS=2000
BALANCE_STALE_MS=5000
RECORDER_ENABLED=false
```

## Guvenli calistirma sirasi

1. `.env` dosyasini hazirla, ama `DRY_RUN=true` kalsin.
2. Bagimliliklari kur:

```bash
npm install
```

3. Kod ve testleri dogrula:

```bash
npm run typecheck
npm test
```

4. Aktif config'i secretsiz gor:

```bash
npm run config:show
```

5. CLOB API credential yoksa operator wallet ile turet:

```bash
npm run clob:derive -- --write-env
```

6. Canli baglanti ve readiness kontrolu:

```bash
npm run live:check
```

7. Gercek emir gondermeden market uzerinde paper izle:

```bash
npm run paper:live -- --duration-sec 305 --sample-ms 1000 --book-depth-levels 20
```

8. Ham feed ve balance capture al:

```bash
npm run capture -- --duration-sec 75
```

9. Tek market canary icin once dry-run / paper kaniti yeterli olduktan sonra
   operator bilincli olarak `DRY_RUN=false` yapar.

10. Ilk canli deneme:

```bash
npm run bot:live:canary
```

## Canli moda gecmeden once zorunlu kontroller

- `npm run live:check` kritik blokersiz gecmeli.
- Wallet izole olmali ve sadece kucuk rollout bakiyesi bulunmali.
- Aktif collateral `POLY_STACK_MODE=post-cutover-v2` icin pUSD olmali.
- `POLY_RPC_URL` public rate-limit riski tasimayan private/authenticated RPC olmali.
- `CTF_MERGE_ENABLED=true` ise relayer topology ve allowance hazir olmali.
- User websocket auth gecmeli; aksi durumda fill/open-order reconciliation guvenilmez olur.
- Manual trade veya dis aktivite varsa bot yeni entry acmamali; once
  `npm run inventory:reconcile` calistirilir.

## Operasyon komutlari

```bash
npm run live:check
npm run inventory:report
npm run inventory:reconcile
npm run inventory:manage
npm run inventory:merge-only
npm run inventory:redeem-only
npm run bot:resume -- --confirm
```

`bot:resume -- --confirm`, SAFE_HALT temizlemek icin kullanilir. Bunun oncesinde
`inventory:reconcile` calismis olmali.

## Log ve state dosyalari

- Runtime SQLite: `data/xuan_state.sqlite`
- Yeni runtime state defaultu: `data/runtime/xuan-state.sqlite`
- Live paper audit: `logs/paper-live/*.jsonl`
- Structured logs: `logs/*.jsonl`
- Capture oturumlari: `data/capture/<timestamp>/`

## Guvenlik kurallari

- `.env` commitlenmez ve chat / mail ile secretsiz olmayan hali paylasilmaz.
- Ana wallet private key kullanilmaz.
- Canli lotlar buyutulmeden once ghost fill, stale book, merge fail ve stuck market
  oranlari logdan kontrol edilir.
- `DRY_RUN=false` sadece operator kendi wallet / risk sorumlulugunu kabul ettikten sonra
  yapilir.
- Public RPC ile canli operasyon onerilmez; stale read ve rate-limit riski vardir.
