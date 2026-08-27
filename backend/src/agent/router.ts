import { Router } from 'express';
import { requireAgentSession } from '../shared/middleware/requireAgentSession.ts';
import { resolveConsoleWorkspace } from '../shared/middleware/resolveConsoleWorkspace.ts';
import { authRouter } from './routers/authRouter.ts';
import { conversationsRouter } from './routers/conversationsRouter.ts';
import { messagesRouter } from './routers/messagesRouter.ts';
import { taxonomyRouter } from './routers/taxonomyRouter.ts';
import { tagsRouter } from './routers/tagsRouter.ts';
import { articlesRouter } from './routers/articlesRouter.ts';
import { botConfigRouter } from './routers/botConfigRouter.ts';
import { workspaceSettingsRouter } from './routers/workspaceSettingsRouter.ts';
import { declaredFieldRouter } from './routers/declaredFieldRouter.ts';
import { formsRouter } from './routers/formsRouter.ts';
import { agentsRouter } from './routers/agentsRouter.ts';
import { presenceRouter } from './routers/presenceRouter.ts';
import { membershipsRouter } from './routers/membershipsRouter.ts';
import { globalInboxRouter } from './routers/globalInboxRouter.ts';
import { uploadsRouter } from './routers/uploadsRouter.ts';

export const agentRouter = Router();

// Public: this IS the login flow, so it cannot require the session it mints.
agentRouter.use(authRouter);

agentRouter.use(requireAgentSession);
agentRouter.use(membershipsRouter);
agentRouter.use(globalInboxRouter);
agentRouter.use(resolveConsoleWorkspace);
agentRouter.use(taxonomyRouter);
agentRouter.use(tagsRouter);
agentRouter.use(articlesRouter);
agentRouter.use(botConfigRouter);
agentRouter.use(workspaceSettingsRouter);
agentRouter.use(declaredFieldRouter);
agentRouter.use(formsRouter);
agentRouter.use(conversationsRouter);
agentRouter.use(messagesRouter);
agentRouter.use(uploadsRouter);
agentRouter.use(agentsRouter);
agentRouter.use(presenceRouter);
