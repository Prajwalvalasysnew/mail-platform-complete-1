# Message body storage

At volume, keeping `html_body`/`text_body` inline in the hot `messages` table
bloats it. The body store offloads bodies to object storage, leaving only a
pointer (`body_storage`, `body_object_key`, `body_size`, `body_hash`) on the
message. The send path and worker are agnostic to where the body lives.

Bodies are **content-addressed**: identical content (e.g. one campaign to many
recipients) dedupes to a single object.

## Backends (`BODY_STORAGE`)

### `inline` (default)
Bodies stay in Postgres. Nothing else to configure. Fine for low/medium volume.

### `fs` — local filesystem (zero extra cost, no external service)
Writes JSON objects under a directory. Best for single-node deployments — no
object-storage bill, no new vendor.

```
BODY_STORAGE=fs
BODY_FS_DIR=/var/lib/mailplatform/bodies
```

### `s3` — any S3-compatible store (no provider lock-in)
The same code talks to AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO, etc.
— the endpoint and credentials decide which. `forcePathStyle` defaults on
(required by MinIO and some others); set `BODY_S3_FORCE_PATH_STYLE=false` for
AWS-style virtual-hosted buckets.

```
BODY_STORAGE=s3
BODY_S3_BUCKET=mp-bodies
BODY_S3_PREFIX=bodies/
BODY_S3_REGION=auto
BODY_S3_ENDPOINT=...            # provider endpoint (omit for AWS S3)
BODY_S3_ACCESS_KEY_ID=...
BODY_S3_SECRET_ACCESS_KEY=...
BODY_S3_FORCE_PATH_STYLE=true
```

Provider endpoints:

| Provider | `BODY_S3_ENDPOINT` | Notes |
| --- | --- | --- |
| Cloudflare R2 | `https://<account>.r2.cloudflarestorage.com` | Zero egress fees; `region=auto`. |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` | Cheapest storage; free egress via Cloudflare. |
| Wasabi | `https://s3.<region>.wasabisys.com` | Flat rate, no egress/API fees (fair-use). |
| MinIO (self-hosted) | `http://minio:9000` | $0 extra; runs on your own host. |
| AWS S3 | *(omit)* | Set `BODY_S3_FORCE_PATH_STYLE=false`. |

Cost note: S3's egress (~$0.09/GB) is usually the surprise line item. R2/Wasabi
have zero egress; B2 is cheapest at rest; MinIO self-hosted costs nothing beyond
the box it runs on. Because the seam is S3-compatible, switching is a config
change, not a code change.

## Lifecycle

Object keys are stable and sharded by hash prefix, so a bucket lifecycle policy
(or `BodyStore.delete()`) can expire/erase old bodies — useful for retention
windows and GDPR erase.

## Extending

Implement the `BodyStore` interface (`put`/`get`/`delete`) and select it in
`getBodyStore()`, or inject one at runtime with `setBodyStore()` (used in tests
to run the filesystem and in-memory S3 backends without network). The S3 backend
itself is built on a small `ObjectClient` seam, so its logic is tested against
`InMemoryObjectClient` with no live bucket.
