# xx8 BTC 5m Yes/No Bot

Polymarket BTC 5m Up/Down marketlerinde fee-aware taker pair accumulation, lagging-side taker rebalance, merge/redeem recycle ve xuan-like timing/risk davranisi icin TypeScript/Node.js bot iskeleti.

## Hedef

Bu repo directional BTC tahmin botu degil. Ana hedef:

- `btc-updown-5m-*` marketlerini kesintisiz kesfetmek
- Up/Down taraflarini dengeli toplamak
- varsayilan modda market acildiktan hemen sonra iki tarafi da buy ederek pair seed acmak
- fee-sonrasi pair maliyeti uygunsa market icinde yeni rung'lar ekleyip matched inventory uretmek
- dengesizlikte entry penceresi boyunca sadece lagging tarafa buy-side scale yapmak
- entry cutoff sonrasi tek bacak doldugunda book-depth ve completion cap ile kismi / tam completion yapmak
- varsayilan modda residual tek tarafi SELL etmek yerine merge/redeem agirlikli buy-only akisi korumak
- eslesen ciftleri merge edip otomatik redeem ile collateral'a cevirmek
- one-sided inventory ve gec pencere riskini sikca sinirlamak

## Durum

Bu surum calisir MVP/skeleton'dir:

- strict TypeScript proje
- env/config validation
- CLOB V1/V2 adapter katmani
- market discovery
- market/user websocket skeleton
- local orderbook state
- ERC1155 balance reader skeleton
- CTF merge/redeem skeleton
- Xuan5m strategy/risk/order/completion engine
- xuan JSON analyzer
- dry-run ve paper mode
- unit ve integration mock testleri

## Kurulum

```bash
npm install
cp .env.example .env
```

Gerekli alanlar:

- `POLY_STACK_MODE`
- `BOT_WALLET_ADDRESS`
- `BOT_PRIVATE_KEY`
- `POLY_API_KEY`
- `POLY_API_SECRET`
- `POLY_API_PASSPHRASE`
- `POLY_SIGNATURE_TYPE` optional, proxy/safe kullaniminda
- `POLY_FUNDER` optional, proxy/funder adresi gerekiyorsa
- `POLY_RELAYER_API_KEY`, `POLY_RELAYER_API_KEY_ADDRESS`, `POLY_RELAYER_BASE_URL`
  `POLY_SIGNATURE_TYPE=1|2` ve `CTF_MERGE_ENABLED=true` ise gerekli
- `POLY_RPC_URL`
- `CTF_CONTRACT_ADDRESS`
- `POLY_USDC_TOKEN` current-prod V1 icin
- `POLY_PUSD_TOKEN` post-cutover V2 icin

Varsayilanlar guvenlik odaklidir:

- `DRY_RUN=true`
- `POLY_STACK_MODE=current-prod-v1`
- `CTF_MERGE_ENABLED=true`
- `CTF_AUTO_REDEEM_ENABLED=true`
- `ENTRY_TAKER_BUY_ENABLED=true`
- `ENTRY_TAKER_PAIR_CAP=1.02`
- `SELL_UNWIND_ENABLED=false`
- live rollout icin sadece izole cuzdan kullan

## Komutlar

```bash
npm run config:show
npm run live:check
npm run clob:derive -- --write-env
npm run analyze:xuan
npm run capture -- --duration-sec 75
npm run paper
npm run paper:multi -- --windows 3
npm run paper:live -- --duration-sec 20 --sample-ms 2000
npm run bot:dry
npm run bot:live
npm test
```

`npm run clob:derive -- --write-env` aktif stack'e gore resmi Polymarket CLOB client `createOrDeriveApiKey()` akisini kullanir ve `.env` icindeki `POLY_API_KEY`, `POLY_API_SECRET`, `POLY_API_PASSPHRASE` alanlarini doldurur. Bu komut signer olarak `BOT_PRIVATE_KEY`, proxy/safe senaryosunda `POLY_SIGNATURE_TYPE` ve `POLY_FUNDER` alanlarini kullanir.

`npm run live:check` canli preflight raporu uretir. RPC, Gamma discovery, CLOB auth, collateral balance/allowance, orderbook erisimi, market/user websocket, relayer auth, safe deployment ve merge readiness durumunu tek JSON cikti olarak verir.

`npm run capture -- --duration-sec 75` current+next BTC 5m marketleri icin capture-only oturum calistirir. Emir gondermez; raw market/user websocket payload'larini, token mapping'i ve ERC1155 balance snapshotlarini `data/capture/...` altina yazar ve validation raporu uretir.

`npm run bot:live` varsayilan olarak continuous rollover daemon calistirir. Her markette gercek orderbook, user websocket ve on-chain balance reconcile ile inventory state tasir; guvenlik icin `DRY_RUN=false` olmadan calismaz. `--max-markets 1` tek market canary/smoke icin kullanilir.

`npm run analyze:xuan` once `data/xuanxuan008_data_20260415_145447.json` yolunu dener. Dosya yoksa bundled fixture ile devam eder ve bunu loglar.

`npm run paper:multi -- --windows 3` synthetic scenario matrix replay calistirir. Bu komut historical PnL backtest degil; temsilî 5m pencerelerde early pair-seed buy, lagging-side buy rebalance, streaming merge, completion ve hard-cancel davranisini toplu sayilarla gosterir.

`npm run paper:live -- --duration-sec 20 --sample-ms 2000` gercek market orderbook'u ustunde canli paper decision loop calistirir. Emir gondermez; pair-entry readiness, lagging-side rebalance sinyali, completion-only / hard-cancel gecisleri, buy notional, merge readiness ve fee-sonrasi pair cost gibi karar metriklerini toplar. Current market gec pencereye girmisse otomatik olarak next 5m marketi secer.

## CLOB V2 Notu

Polymarket dokumanina gore CLOB V2 go-live tarihi 28 Nisan 2026. Bu repo iki ayri runtime moda sahiptir:

- `POLY_STACK_MODE=current-prod-v1`
  Bugunku production stack. Varsayilan adapter V1, varsayilan CLOB base URL `https://clob.polymarket.com`, aktif collateral `POLY_USDC_TOKEN`.
- `POLY_STACK_MODE=post-cutover-v2`
  Migration sonrasi stack. Varsayilan adapter V2, aktif collateral `POLY_PUSD_TOKEN`.

`USE_CLOB_V2` ve `POLY_CLOB_BASE_URL` alanlarini bos birakirsan mode'dan turetilir. Tutarsiz kombinasyonlar load sirasinda hata verir.

## Paper Mode

Paper mode:

- market websocket ve market discovery calistirir
- pair-entry/rebalance/completion/merge kararlarini hesaplar
- gercek emir gondermez
- orderbook/fill simülasyonlariyla acceptance metrikleri uretir

## Live-Small Rollout

Onerilen rollout:

1. `DRY_RUN=true` ile en az bir seans paper
2. current production icin `POLY_STACK_MODE=current-prod-v1`
3. ayrik cuzdan, dusuk bakiye, `LOT_LADDER=20,40`
4. live'a cikmadan once `POLY_USDC_TOKEN`, `CTF_CONTRACT_ADDRESS` ve API key setini doldur
   API key setini manuel aramak yerine `npm run clob:derive -- --write-env` ile turet
5. `npm run live:check` ile preflight raporunu temizle
6. safe/proxy kullaniyorsan `POLY_RELAYER_*` setini doldur ve `CTF_MERGE_ENABLED=true` ile `npm run live:check` raporunda `merge.ready=true` gor
7. canary parametrelerini `LIVE_SMALL_LOTS=20`, `MAX_MARKET_SHARES_PER_SIDE=60`, `MAX_ONE_SIDED_EXPOSURE_SHARES=30`, `MAX_CYCLES_PER_MARKET=2`, `MAX_BUYS_PER_SIDE=2` olarak tut
8. mumkunse authenticated/private Polygon RPC kullan; public RPC ilk testte calisabilir ama stale read / rate limit riski tasir
9. ancak ondan sonra `DRY_RUN=false`
10. once `npm run capture -- --duration-sec 75` ile raw ws/balance capture al
11. sonra `npm run bot:live -- --max-markets 1 --duration-sec 600` ile kucuk canary calistir
12. ghost fill, stale book, merge fail ve stuck market oranlari log ile dogrulanmadan buyuk lot acma

## Guvenlik

- ana wallet private key kullanma
- `.env` commit etme
- `npm run audit:repo` ile repo taramasi yap
- `npm run audit:deps` ile dependency risklerini kontrol et
- safe/proxy merge bu repoda relayer path uzerinden gider; `POLY_RELAYER_*` ile signer/funder topology eslesmesini `npm run live:check` ile dogrula
- hidden outbound request, `eval`, `child_process`, install script riski icin [docs/security_checklist.md](/Users/cakir/Documents/Projeler/git/bots/xx8-btc-5min-YesNo/docs/security_checklist.md) dosyasina bak

## Kapsam Disi

Bu ilk surum buyuk dashboard/UI eklemez. Odak state machine, risk, order, fill, merge, analyzer ve rollout emniyetidir.
