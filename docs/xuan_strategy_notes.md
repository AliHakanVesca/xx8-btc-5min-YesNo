# Xuan Strategy Notes

- Ana tez directional degil, pair/full-set ekonomisi.
- Birincil hedef market ailesi sadece `btc-updown-5m-*`.
- Lot ladder hedefi: `30 / 60 / 90 / 120 / 145`.
- Inventory median hedefi `< 2%`, hard intervention `> 5%`.
- Yeni entry cutoff kapanisa `30-60s`, son `10-20s` sadece completion/cancel/merge.
- Takas karari her zaman fee-sonrasi pair cost ile verilir.
- Maker agirligi korunur; taker sadece completion veya nadir hard-pair firsatinda acilir.
