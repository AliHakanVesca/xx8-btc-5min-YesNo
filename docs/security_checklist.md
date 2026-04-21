# Security Checklist

## Wallet

- Ana wallet private key kullanma.
- Ayrik rollout wallet ve dusuk bakiye kullan.
- Live-small oncesi allowance ve contract adreslerini elle dogrula.

## Secrets

- `.env` commitlenmez.
- API secret/passphrase sadece server-side kullanilir.
- User websocket istemci tarafta asla acilmaz.

## Code Audit

Su kaliplari tarat:

- bilinmeyen domain'e `fetch`, `axios`, `undici`, `request`
- `child_process`, `exec`, `spawn`, `fork`
- `eval`, `Function`, `vm`
- `Buffer.from(..., "base64")` ardindan dinamik kod calistirma
- `preinstall`, `postinstall`, `prepare`
- minified/obfuscated tek satir dosyalar

## Runtime

- Dry-run defaultunu koru.
- Book stale veya balance stale oldugunda tum open orderlari iptal et.
- Market transition sonrasi residual open order kalmamali.
- On-chain balance, user websocket ve REST state uyusmazsa on-chain source-of-truth say.
