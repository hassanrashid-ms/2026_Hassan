import type { RequestHandler } from 'express'
import { eq } from 'drizzle-orm'
import { sendError } from '../../errors.ts'
import { adminDb } from '../../shared/db/adminClient.ts'
import { workspace } from '../../shared/db/schema/index.ts'
import { getSecretMetadata, rotateSecret } from '../services/secretService.ts'

export const getSecretHandler: RequestHandler = async (req, res) => {
  const metadata = await getSecretMetadata(req.params.id!)
  res.status(200).json({ secrets: metadata })
}

export const rotateSecretHandler: RequestHandler = async (req, res) => {
  const [ws] = await adminDb.select({ slug: workspace.slug }).from(workspace).where(eq(workspace.id, req.params.id!)).limit(1)
  if (!ws) {
    sendError(res, 404, 'not_found', 'Workspace not found.')
    return
  }
  const rotated = await rotateSecret(req.params.id!, ws.slug)
  res.status(201).json(rotated)
}
