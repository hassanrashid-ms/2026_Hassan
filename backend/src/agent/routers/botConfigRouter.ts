import { Router } from 'express';
import { requireAdminRole } from '../../shared/middleware/requireAdminRole.ts';
import { requireTeamLeadOrAdmin } from '../../shared/middleware/requireTeamLeadOrAdmin.ts';
import {
  getBotConfigHandler,
  getBotConfigVersionHandler,
  getBotConfigVersionsHandler,
  rollbackBotConfigHandler,
  saveBotConfigHandler,
} from '../controllers/botConfigController.ts';
import { testBotTurnHandler } from '../controllers/botTestTurnController.ts';
import { testResolutionAnswerHandler } from '../controllers/botTestResolutionController.ts';

/**
 * Roles follow the permission matrix in docs/project-overview.md, which splits
 * read from write:
 *
 *   "See bot config · trigger manual sync"            → Team Lead, Admin
 *   "Edit bot prompt or rules · provision or disable" → Admin only
 *
 * So the reads take a role SET and only the save takes requireAdminRole. A plain
 * agent is refused on all three. Both gates run after requireAgentSession, which
 * agent/router.ts installs before this router.
 *
 * Save is POST, not PUT/PATCH: app.ts's CORS allows only GET and POST, and the
 * console is a browser client.
 */
const canSeeBotConfig = requireTeamLeadOrAdmin;

export const botConfigRouter = Router();
botConfigRouter.get('/bot-config', canSeeBotConfig, getBotConfigHandler);
// requireAdminRole, NOT canSeeBotConfig: "Edit bot prompt or rules · provision or
// disable bot" is Admin-only in the matrix, while seeing it is Team Lead+Admin.
botConfigRouter.post('/bot-config', requireAdminRole, saveBotConfigHandler);
// canSeeBotConfig, the same Team Lead+Admin gate as the config read — reuse the
// constant rather than a second requireWorkspaceRole(...) call, so the two reads
// cannot drift apart.
botConfigRouter.get('/bot-config/versions', canSeeBotConfig, getBotConfigVersionsHandler);
botConfigRouter.get('/bot-config/versions/:version', canSeeBotConfig, getBotConfigVersionHandler);
botConfigRouter.post('/bot-config/rollback', requireAdminRole, rollbackBotConfigHandler);
// canSeeBotConfig, not requireAdminRole: Team Lead can exercise the test
// panel like Admin, but runTestBotTurn (domain/bot/botTestTurn.ts) refuses to
// run a non-admin's caller-supplied draft prompt/rules — it substitutes the
// persisted, already-vetted config instead. That keeps "execute arbitrary
// unsaved prompt text" admin-only in effect while letting Team Lead send test
// messages against what's actually live.
botConfigRouter.post('/bot-config/test-turn', canSeeBotConfig, testBotTurnHandler);
// test-resolution takes no prompt/rules input (just subintent_id, confirm_phase,
// helped), so there's no arbitrary-execution risk — same gate as test-turn.
botConfigRouter.post('/bot-config/test-resolution', canSeeBotConfig, testResolutionAnswerHandler);
