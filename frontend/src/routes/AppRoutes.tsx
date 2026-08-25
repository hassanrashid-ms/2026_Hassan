import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AgentLogin } from '../surfaces/agent-console/pages/AgentLogin.tsx';
import { AdminLogin } from '../surfaces/admin-console/pages/AdminLogin.tsx';
import {
  importBotConfig,
  importForms,
  importGlobalInbox,
  importInbox,
  importKnowledgeBase,
  importTaxonomy,
  importTickets,
  importWorkload,
  importWorkspaceSettings,
} from '../surfaces/agent-console/lib/routePreload.ts';

/*
 * The agent console's router. The player surface is NOT here: it has its own
 * entry document and router at surfaces/webview/main.tsx, so that its shell and
 * home screen can be statically imported and preloaded, and so that no console
 * module is reachable from it. Nothing in this file should ever import from
 * surfaces/webview again.
 *
 * agent-console.css is imported by AgentConsoleShell.tsx alone, never statically
 * from here, so its Tailwind preflight reset stays in its own chunk.
 */
const AgentConsoleShell = lazy(async () => ({
  default: (await import('../surfaces/agent-console/components/AgentConsoleShell.tsx'))
    .AgentConsoleShell,
}));

const Inbox = lazy(async () => ({ default: (await importInbox()).Inbox }));
const GlobalInbox = lazy(async () => ({ default: (await importGlobalInbox()).GlobalInbox }));
const Tickets = lazy(async () => ({ default: (await importTickets()).Tickets }));
const KnowledgeBase = lazy(async () => ({
  default: (await importKnowledgeBase()).KnowledgeBase,
}));
const Forms = lazy(async () => ({ default: (await importForms()).Forms }));
const Taxonomy = lazy(async () => ({ default: (await importTaxonomy()).Taxonomy }));
const Workload = lazy(async () => ({ default: (await importWorkload()).Workload }));
const BotConfigPage = lazy(async () => ({ default: (await importBotConfig()).BotConfig }));
const WorkspaceSettingsPage = lazy(async () => ({
  default: (await importWorkspaceSettings()).WorkspaceSettings,
}));
const AgentNotFound = lazy(async () => ({
  default: (await import('../surfaces/agent-console/pages/NotFound.tsx')).NotFound,
}));

/*
 * The admin console's shell and pages, lazy for the same reason as the agent
 * console's above: admin-console.css is imported by AdminConsoleShell.tsx
 * alone, never statically from here, so its Tailwind preflight reset stays in
 * its own chunk and never reaches the other two surfaces.
 */
const AdminConsoleShell = lazy(async () => ({
  default: (await import('../surfaces/admin-console/components/AdminConsoleShell.tsx'))
    .AdminConsoleShell,
}));
const Overview = lazy(async () => ({
  default: (await import('../surfaces/admin-console/pages/Overview/Overview.tsx')).Overview,
}));
const WorkspaceDetail = lazy(async () => ({
  default: (await import('../surfaces/admin-console/pages/WorkspaceDetail/WorkspaceDetail.tsx'))
    .WorkspaceDetail,
}));
const Admins = lazy(async () => ({
  default: (await import('../surfaces/admin-console/pages/Admins/Admins.tsx')).Admins,
}));
const AdminNotFound = lazy(async () => ({
  default: (await import('../surfaces/admin-console/pages/NotFound.tsx')).NotFound,
}));

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="/login" element={<AgentLogin />} />
      <Route
        path="/"
        element={
          <Suspense fallback={null}>
            <AgentConsoleShell />
          </Suspense>
        }
      >
        <Route path="inbox" element={<Inbox />} />
        <Route path="inbox/:conversationId" element={<Inbox />} />
        <Route path="global-inbox" element={<GlobalInbox />} />
        <Route path="tickets" element={<Tickets />} />
        <Route path="tickets/:conversationId" element={<Tickets />} />
        <Route path="articles" element={<KnowledgeBase />} />
        <Route path="articles/:id" element={<KnowledgeBase />} />
        <Route path="forms" element={<Forms />} />
        <Route path="forms/:id" element={<Forms />} />
        <Route path="taxonomy" element={<Taxonomy />} />
        <Route path="workload" element={<Workload />} />
        <Route path="bot-config" element={<BotConfigPage />} />
        <Route path="workspace-settings" element={<WorkspaceSettingsPage />} />
        <Route path="*" element={<AgentNotFound />} />
      </Route>

      {/*
       * "/dashboard", not "/admin" — dev-proxy.mjs proxies any request under
       * "/admin/*" straight to the backend's real /admin API mount (app.ts),
       * so a frontend route sharing that prefix is unreachable through the
       * shared ngrok tunnel. See docs/decisions for the collision writeup.
       */}
      <Route path="/dashboard/login" element={<AdminLogin />} />
      <Route
        path="/dashboard"
        element={
          <Suspense fallback={null}>
            <AdminConsoleShell />
          </Suspense>
        }
      >
        <Route index element={<Navigate to="overview" replace />} />
        <Route path="overview" element={<Overview />} />
        <Route path="admins" element={<Admins />} />
        <Route path="workspaces/:id" element={<WorkspaceDetail />} />
        <Route path="*" element={<AdminNotFound />} />
      </Route>
    </Routes>
  );
}
