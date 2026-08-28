import type { RequestHandler } from 'express';
import { eq } from 'drizzle-orm';
import { sendError } from '../../errors.ts';
import { workspace } from '../db/schema/index.ts';
import { withoutWorkspace } from '../db/withWorkspace.ts';
import { InvalidPlayerToken, verifyPlayerToken } from '../auth/playerToken.ts';

export type PlayerContext = {
  workspaceId: string;
  playerId: string;
  externalPlayerId: string;
  workspaceSlug: string;
  sdkVersion: string | null;
  clientVersion: string | null;
  idempotencyKey: string | null;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      player?: PlayerContext;
    }
  }
}

/**
 * The workspace comes from the JWT claim and from nowhere else. The slug is looked
 * up here so requireSdkHeaders can cross-check the header against it.
 */
export const requirePlayerToken: RequestHandler = async (req, res, next) => {
  const header = req.header('authorization') ?? '';
  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || rest.length === 0) {
    sendError(res, 401, 'unauthorized', 'Expected an Authorization: Bearer <player_token> header.');
    return;
  }

  let claims;
  try {
    claims = await verifyPlayerToken(rest.join(' ').trim());
  } catch (error) {
    if (error instanceof InvalidPlayerToken) {
      sendError(res, 401, 'unauthorized', 'Player token is not valid.');
      return;
    }
    next(error);
    return;
  }

  const [found] = await withoutWorkspace(async (tx) =>
    tx
      .select({ slug: workspace.slug, disabledAt: workspace.disabledAt })
      .from(workspace)
      .where(eq(workspace.id, claims.workspace_id))
      .limit(1),
  );

  // A token for a deleted or disabled workspace is dead immediately, without
  // waiting out its 15 minutes.
  if (!found || found.disabledAt) {
    sendError(res, 401, 'unauthorized', 'Player token is not valid.');
    return;
  }

  req.player = {
    workspaceId: claims.workspace_id,
    playerId: claims.player_id,
    externalPlayerId: claims.external_player_id,
    workspaceSlug: found.slug,
    sdkVersion: null,
    clientVersion: null,
    idempotencyKey: null,
  };
  next();
};
