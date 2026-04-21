# Xuan Strategy Notes

- Ana tez directional degil, pair/full-set ekonomisi.
- Birincil hedef market ailesi sadece `btc-updown-5m-*`.
- Lot ladder hedefi: `30 / 60 / 90 / 120 / 145`.
- Inventory median hedefi `< 2%`, hard intervention `> 5%`.
- Yeni entry cutoff kapanisa `30-60s`, son `10-20s` sadece completion/cancel/merge.
- Takas karari her zaman fee-sonrasi pair cost ile verilir.
- Dogrulanmis model taker-only / taker-dominant pair accumulation'dir; runtime'da maker quoting yolu kaldirildi.
- Denge varken iki tarafi birlikte taker BUY, dengesizlikte yalnizca lagging tarafi taker BUY et.
- Eslesen ciftleri merge et, resolve sonrasi residual winner'lari redeem et; SELL unwind varsayilan cikis yolu degildir.
