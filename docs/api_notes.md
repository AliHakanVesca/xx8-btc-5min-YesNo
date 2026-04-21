# API Notes

Bu repo resmi Polymarket yuzeylerini adapter arkasinda tutar:

- V2 SDK paketi: `@polymarket/clob-client-v2`
- V1 fallback paketi: `@polymarket/clob-client`
- public market websocket: orderbook + trade + best bid/ask
- private user websocket: order/trade status
- Gamma market metadata
- Data API: trades/activity/positions
- Polygon RPC: ERC1155/CTF source-of-truth

Runtime mode:

- `current-prod-v1`: V1 adapter + production CLOB + `POLY_USDC_TOKEN`
- `post-cutover-v2`: V2 adapter + post-cutover stack + `POLY_PUSD_TOKEN`

Live entegrasyonlarda tum I/O adapter ve skeleton sinirlari uzerinden gecmelidir.
