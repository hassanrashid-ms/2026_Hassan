import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  copyObject,
  deleteObject,
  headObject,
  presignGetObject,
  presignPutObject,
} from '../src/shared/storage/presign.ts';

async function putViaPresignedUrl(url: string, contentType: string, body: Buffer) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, 'Content-Length': String(body.length) },
    body,
  });
  if (!res.ok) throw new Error(`PUT failed with ${res.status}: ${await res.text()}`);
}

describe('storage/presign', () => {
  it('round-trips an object through presigned PUT, HEAD, copy, and GET', async () => {
    const key = `test/${randomUUID()}.png`;
    const body = Buffer.from('fake-png-bytes');

    const { url } = await presignPutObject({
      key,
      contentType: 'image/png',
      contentLength: body.length,
    });
    await putViaPresignedUrl(url, 'image/png', body);

    const head = await headObject(key);
    expect(head).toMatchObject({ contentType: 'image/png', contentLength: body.length });

    const destKey = `test/${randomUUID()}.png`;
    await copyObject({ sourceKey: key, destKey });
    expect(await headObject(destKey)).toMatchObject({ contentType: 'image/png' });

    const getUrl = await presignGetObject(destKey);
    const getRes = await fetch(getUrl);
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe(body.toString());

    await deleteObject(key);
    await deleteObject(destKey);
  });

  it('headObject returns null for a missing key', async () => {
    expect(await headObject(`test/${randomUUID()}.png`)).toBeNull();
  });

  it('deleteObject resolves even when the object never existed', async () => {
    await expect(deleteObject(`test/${randomUUID()}.png`)).resolves.toBeUndefined();
  });
});
