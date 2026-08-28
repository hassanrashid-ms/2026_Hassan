import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getEnv } from '../../env.ts';
import { getS3Client } from './s3Client.ts';

export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const ALLOWED_VIDEO_MIME_TYPES = ['video/mp4', 'video/webm'] as const;

export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

export const ALLOWED_CHAT_ATTACHMENT_MIME_TYPES = [
  ...ALLOWED_IMAGE_MIME_TYPES,
  ...ALLOWED_VIDEO_MIME_TYPES,
] as const;

/** Chat/forms attachments only — articles keep the flat MAX_ATTACHMENT_BYTES image cap. */
export function maxBytesForAttachment(contentType: string): number {
  return (ALLOWED_VIDEO_MIME_TYPES as readonly string[]).includes(contentType)
    ? MAX_VIDEO_BYTES
    : MAX_ATTACHMENT_BYTES;
}

const PUT_TTL_SECONDS = 5 * 60;
const GET_TTL_SECONDS = 10 * 60;

/**
 * Signs a PUT with ContentType and ContentLength as part of the signed request.
 * A client that sends different header values gets a signature mismatch from
 * MinIO/S3 directly — this is what enforces "only this exact declared type and
 * size may be uploaded to this key", with no separate POST-policy needed.
 */
export async function presignPutObject(input: {
  key: string;
  contentType: string;
  contentLength: number;
}): Promise<{ url: string; expiresAt: string }> {
  const env = getEnv();
  const command = new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: input.key,
    ContentType: input.contentType,
    ContentLength: input.contentLength,
  });
  const url = await getSignedUrl(getS3Client(), command, { expiresIn: PUT_TTL_SECONDS });
  const expiresAt = new Date(Date.now() + PUT_TTL_SECONDS * 1000).toISOString();
  return { url, expiresAt };
}

/** Fresh every call, never cached — a stored GET URL would eventually 403/expire silently. */
export async function presignGetObject(key: string): Promise<string> {
  const env = getEnv();
  const command = new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key });
  return getSignedUrl(getS3Client(), command, { expiresIn: GET_TTL_SECONDS });
}

/**
 * Null, not a throw, when the object is missing — the caller (claim, or the
 * read-side signer) treats "gone" as an ordinary case to handle, not a fault.
 */
export async function headObject(
  key: string,
): Promise<{ contentType: string; contentLength: number } | null> {
  const env = getEnv();
  try {
    const result = await getS3Client().send(
      new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
    );
    return {
      contentType: result.ContentType ?? '',
      contentLength: result.ContentLength ?? 0,
    };
  } catch (error) {
    if (error instanceof NotFound) return null;
    throw error;
  }
}

export async function copyObject(input: { sourceKey: string; destKey: string }): Promise<void> {
  const env = getEnv();
  await getS3Client().send(
    new CopyObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: input.destKey,
      CopySource: `${env.S3_BUCKET}/${input.sourceKey}`,
    }),
  );
}

/** Resolves even if the object is already gone — cancel/cleanup must be idempotent. */
export async function deleteObject(key: string): Promise<void> {
  const env = getEnv();
  try {
    await getS3Client().send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  } catch (error) {
    if (!(error instanceof NotFound)) throw error;
  }
}
