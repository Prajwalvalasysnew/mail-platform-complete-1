# DKIM Keys

This directory holds DKIM keypairs per domain. In production:

- The `private` file is the RSA private key — **never commit this**
- The `public` file contains the public key
- The `dns.txt` file shows the TXT record you must add to DNS

Structure:
```
infra/dkim/
└── yourdomain.com/
    ├── private          ← KEEP SECRET
    ├── public
    └── dns.txt
```

**The application reads keys from the `sending_domains` Postgres table, not from disk.**
This directory is only used for:
1. Manual DKIM key generation via `scripts/generate-dkim.sh`
2. Backup / disaster recovery

The Haraka outbound MTA queries Postgres directly for signing keys (see
`packages/haraka-outbound/plugins/customer_dkim.js`).
