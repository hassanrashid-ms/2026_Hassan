export {};

// One-off script: creates the attachments bucket if absent and applies a
// private policy (no public-read, no anonymous listing) plus CORS scoped to
// SURFACE_ORIGINS. Never invoked at app boot — run manually or from a setup
// step alongside `pnpm db:setup`.
//
//   cd backend && node --experimental-strip-types scripts/setup-minio-bucket.ts
const { loadRootEnv } = await import('../src/env/loadRootEnv.ts');
loadRootEnv(import.meta.url);

import {
  CreateBucketCommand,
  HeadBucketCommand,
  NotFound,
  PutBucketCorsCommand,
} from '@aws-sdk/client-s3';
import { getEnv } from '../src/env.ts';
import { getS3Client } from '../src/shared/storage/s3Client.ts';

async function main() {
  const env = getEnv();
  const client = getS3Client();

  const exists = await client
    .send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }))
    .then(() => true)
    .catch((error) => {
      if (error instanceof NotFound) return false;
      throw error;
    });

  if (!exists) {
    console.log(`Creating bucket "${env.S3_BUCKET}"...`);
    await client.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
  } else {
    console.log(`Bucket "${env.S3_BUCKET}" already exists.`);
  }

  try {
    await client.send(
      new PutBucketCorsCommand({
        Bucket: env.S3_BUCKET,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: env.SURFACE_ORIGINS,
              AllowedMethods: ['PUT', 'GET'],
              AllowedHeaders: ['*'],
              MaxAgeSeconds: 3000,
            },
          ],
        },
      }),
    );
    console.log('CORS applied.');
  } catch (error) {
    // Open-source MinIO does not implement the S3 PutBucketCors API at all —
    // per-bucket CORS is an AIStor/paid-only feature (confirmed against
    // minio/minio#20995). Against real AWS S3 / R2 in prod this call
    // succeeds and is the only thing needed. For local MinIO, CORS is
    // instead set cluster-wide via MINIO_API_CORS_ALLOW_ORIGIN in
    // docker-compose.yml, so treat this specific failure as expected rather
    // than fatal.
    if (error instanceof Error && error.name === 'NotImplemented') {
      console.log(
        'Skipping PutBucketCors: this MinIO build does not support per-bucket CORS. ' +
          'CORS for local dev is already set cluster-wide via MINIO_API_CORS_ALLOW_ORIGIN ' +
          'in docker-compose.yml. Nothing further needed here.',
      );
    } else {
      throw error;
    }
  }
  console.log('Bucket has no public-read policy by default — nothing further needed.');
}

await main();
