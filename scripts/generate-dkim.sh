#!/usr/bin/env bash
# Generate a 2048-bit RSA DKIM keypair for a given domain.
# Usage: ./scripts/generate-dkim.sh yourdomain.com [selector]
#
# Outputs:
#   - infra/dkim/<domain>/private          (PEM private key — KEEP SECRET)
#   - infra/dkim/<domain>/public           (PEM public key)
#   - infra/dkim/<domain>/dns.txt          (TXT record to add to your DNS)

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <domain> [selector]" >&2
  exit 1
fi

DOMAIN="$1"
SELECTOR="${2:-default}"
OUT_DIR="infra/dkim/${DOMAIN}"

mkdir -p "$OUT_DIR"

echo "Generating 2048-bit RSA keypair for $DOMAIN (selector: $SELECTOR)..."

openssl genrsa -out "$OUT_DIR/private" 2048 2>/dev/null
chmod 600 "$OUT_DIR/private"
openssl rsa -in "$OUT_DIR/private" -pubout -out "$OUT_DIR/public" 2>/dev/null

# Extract the base64 portion of the public key (single line, no headers)
PUBKEY=$(grep -v '^-----' "$OUT_DIR/public" | tr -d '\n')

# Write the DNS TXT record
cat > "$OUT_DIR/dns.txt" <<EOF
Add this TXT record to your DNS:

Hostname: ${SELECTOR}._domainkey.${DOMAIN}
Value:    v=DKIM1; k=rsa; p=${PUBKEY}

After DNS propagates (5-60 min), verify with:
  dig TXT ${SELECTOR}._domainkey.${DOMAIN}
EOF

cat "$OUT_DIR/dns.txt"

echo ""
echo "Files written to: $OUT_DIR/"
echo "  private  - PEM private key (KEEP SECRET, never commit)"
echo "  public   - PEM public key"
echo "  dns.txt  - DNS record to add"
