/*
 * Named dynamic importers for the agent console's lazy routes. AppRoutes.tsx
 * (the composition root) uses these to build its lazy() components, and
 * AgentConsoleShell.tsx uses the same importers to prefetch a tab's chunk on
 * nav hover/focus — one definition, so the two never drift apart.
 */
export const importInbox = () => import('../pages/Inbox/Inbox.tsx');
export const importGlobalInbox = () => import('../pages/GlobalInbox/GlobalInbox.tsx');
export const importTickets = () => import('../pages/Tickets/Tickets.tsx');
export const importKnowledgeBase = () => import('../pages/KnowledgeBase/KnowledgeBase.tsx');
export const importForms = () => import('../pages/Forms/Forms.tsx');
export const importTaxonomy = () => import('../pages/Taxonomy/Taxonomy.tsx');
export const importWorkload = () => import('../pages/Workload/Workload.tsx');
export const importBotConfig = () => import('../pages/BotConfig/BotConfig.tsx');
export const importWorkspaceSettings = () =>
  import('../pages/WorkspaceSettings/WorkspaceSettings.tsx');
export const importTemplates = () => import('../pages/Templates/Templates.tsx');

// Keyed by the NavLink `to` path AgentConsoleShell renders.
export const agentRoutePreload: Record<string, () => Promise<unknown>> = {
  '/inbox': importInbox,
  '/global-inbox': importGlobalInbox,
  '/tickets': importTickets,
  '/articles': importKnowledgeBase,
  '/forms': importForms,
  '/taxonomy': importTaxonomy,
  '/workload': importWorkload,
  '/bot-config': importBotConfig,
  '/workspace-settings': importWorkspaceSettings,
  '/templates': importTemplates,
};
