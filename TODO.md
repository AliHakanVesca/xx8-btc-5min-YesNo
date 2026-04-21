# TODO

## Next

- Gercek xuan export dosyasini `data/xuanxuan008_data_20260415_145447.json` altina koyup analyzer metriklerini fixture disi veriyle dogrula
- Gercek Polygon/CTF contract adreslerini `.env` ve docs altinda sabitle
- V2 SDK uzerinden canli auth/order placement entegrasyonunu staging wallet ile smoke et
- user websocket + on-chain balance reconcile loopunu canli eventlerle test et
- merge/redeem akislarini fork RPC veya test wallet ile dry-run disinda dogrula
- market discovery icin Gamma response schema'sini canli endpoint ornekleriyle sertlestir
- paper mode fill simulator'ini historical recorder verisiyle kalibre et

## Guardrails

- `DRY_RUN=true` defaultunu kaldirma
- tek wallet yerine mutlaka izole rollout wallet'i kullan
- hard stale/imbalance/daily-loss guardlarini gevsetmeden lot artirma
