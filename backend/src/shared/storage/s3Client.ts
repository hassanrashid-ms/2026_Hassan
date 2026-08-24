import { S3Client } from '@aws-sdk/client-s3';
import { getEnv } from '../../env.ts';

let cached: S3Client | undefined;

/**
 * Single S3Client instance, memoised the same way getEnv() is. MinIO requires
 * path-style addressing (forcePathStyle: true) — virtual-hosted-style bucket
 * URLs don't resolve against a self-hosted endpoint the way they do against AWS.
 */
export function getS3Client(): S3Client {
  if (cached) return cached;
  const env = getEnv();
  cached = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
    // AWS SDK v3 defaults to sending an x-amz-sdk-checksum-algorithm (CRC32)
    // request header on S3 calls. MinIO responds 501 NotImplemented to that
    // header on several operations (e.g. CreateBucket) — force checksums to
    // only be added when a command explicitly requires one.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

  // Some bucket-level operations (PutBucketCors, CreateBucket) have
  // requestChecksumRequired baked in by the SDK regardless of the
  // requestChecksumCalculation setting above, so they still get an
  // x-amz-checksum-crc32 header MinIO answers with 501 NotImplemented.
  // Strip any checksum headers right before the request goes out — we don't
  // rely on SDK-computed checksums anywhere in this app.
  cached.middlewareStack.add(
    (next) => async (args) => {
      const headers = (args.request as { headers?: Record<string, string> } | undefined)
        ?.headers;
      if (headers) {
        for (const name of Object.keys(headers)) {
          const lower = name.toLowerCase();
          if (lower === 'x-amz-sdk-checksum-algorithm' || lower.startsWith('x-amz-checksum-')) {
            delete headers[name];
          }
        }
      }
      return next(args);
    },
    // Must run in the "build" step (same step the checksum middleware adds
    // the header in) and after it, so the header is gone before signing
    // (finalizeRequest, later) computes the request's signature — stripping
    // it afterward would invalidate a signature that already covered it.
    { step: 'build', priority: 'low', name: 'stripUnsupportedS3ChecksumHeaders' },
  );

  return cached;
}

/** Tests only — forces the next getS3Client() to build a fresh client. */
export function resetS3ClientCache(): void {
  cached = undefined;
}
