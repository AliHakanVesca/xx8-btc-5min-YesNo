#!/usr/bin/env bash
set -euo pipefail

target="${1:-.}"

echo "audit_target=${target}"
echo "--- suspicious outbound calls ---"
rg -n --hidden --glob '!node_modules/**' --glob '!.git/**' 'https?://|wss?://' "${target}" || true

echo "--- risky primitives ---"
rg -n --hidden --glob '!node_modules/**' --glob '!.git/**' 'child_process|exec\\(|spawn\\(|fork\\(|eval\\(|new Function|vm\\.' "${target}" || true

echo "--- install scripts ---"
rg -n --hidden --glob '!node_modules/**' --glob '!.git/**' '"(preinstall|postinstall|prepare)"\\s*:' "${target}" || true

echo "--- dotenv exfil patterns ---"
rg -n --hidden --glob '!node_modules/**' --glob '!.git/**' 'process\\.env|dotenv|API_KEY|SECRET|PASSPHRASE' "${target}" || true
