import { Suspense, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import mindstormLogo from '@/assets/mindstorm_logo.png';
import {
  Inbox as InboxIcon,
  Globe,
  BookOpen,
  ClipboardList,
  ChevronDown,
  LogOut,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Tags,
  Gauge,
  MessageSquare,
  BarChart3,
} from 'lucide-react';
// agent-console.css is imported HERE and nowhere else — never from main.tsx or
// any statically-reachable module, so its Tailwind preflight never leaks into
// the webview surface (mirrors WebviewShell.tsx's isolation of webview.css).
import '@/agent-console.css';
import { readConsoleBoot } from '@/lib/consoleBoot.ts';
import { scrubToken } from '@/lib/boot.ts';
import {
  canBuildForms,
  clearAgentSession,
  isAdmin,
  loadAgentSession,
  saveAgentSession,
  saveLastActiveWorkspaceId,
} from '../lib/agentSession.ts';
import {
  fetchMemberships,
  fetchPresence,
  updatePresence,
  type DisplayStatus,
} from '../api/agentApi.ts';
import { WorkspaceSwitcher } from './WorkspaceSwitcher.tsx';
import { createSocket } from '../../../features/chat/api/socket.ts';
import { handleSessionExpired } from '../lib/authErrorHandling.ts';
import { Avatar, AvatarFallback } from './ui/avatar.tsx';
import { Badge } from './ui/badge.tsx';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.tsx';
import { PresenceDot } from './PresenceDot.tsx';
import { PageSkeleton } from './PageSkeleton.tsx';
import { agentRoutePreload } from '../lib/routePreload.ts';
import { cn } from '../lib/cn.ts';

const PRESENCE_OPTIONS: { value: 'online' | 'away'; label: string; dotClassName: string }[] = [
  { value: 'online', label: 'Online', dotClassName: 'bg-green-500' },
  { value: 'away', label: 'Away', dotClassName: 'bg-yellow-500' },
];

// Section labels mirror the role tier the items are actually gated by below
// (canBuildForms) — they encode the real permission boundary, not decoration.
const NAV_ITEMS = [
  { to: '/inbox', label: 'Inbox', icon: InboxIcon, group: 'Workspace' },
  { to: '/global-inbox', label: 'Global Inbox', icon: Globe, group: 'Workspace' },
  { to: '/tickets', label: 'Tickets', icon: ClipboardList, group: 'Workspace' },
  { to: '/articles', label: 'Knowledge Base', icon: BookOpen, group: 'Workspace' },
  { to: '/analytics', label: 'Analytics', icon: BarChart3, group: 'Workspace' },
  { to: '/taxonomy', label: 'Taxonomy', icon: Tags, group: 'Workspace' },
];

// Team Lead + Admin only — an Agent would 403 at the API anyway
// (requireWorkspaceRole('team_lead', 'admin') on formsRouter), so hiding the
// link here is UX, not the enforcement point.
const FORMS_NAV_ITEM = { to: '/forms', label: 'Forms', icon: ClipboardList, group: 'Manage' };

// Team Lead + Admin only, same gate as Forms above — an Agent would 403 at
// the API anyway once /agent/workload is implemented.
const WORKLOAD_NAV_ITEM = { to: '/workload', label: 'Team', icon: Gauge, group: 'Manage' };

// Team Lead + Admin, same gate as Forms/Workload/Workspace Settings above —
// "See bot config · trigger manual sync" is Team Lead + Admin in the
// permission matrix; only "Edit bot prompt or rules · provision or disable
// bot" is Admin-only, enforced inside the page itself and again by the API
// on POST/rollback. Hiding the link here is UX, not the enforcement point.
const BOT_CONFIG_NAV_ITEM = {
  to: '/bot-config',
  label: 'Bot Config',
  icon: Settings,
  group: 'Manage',
};

// Team Lead + Admin can read (GET /agent/workspace-settings), same gate as
// Forms/Workload above — only Admin can write, enforced client-side inside
// the page itself and again by the API on POST.
const WORKSPACE_SETTINGS_NAV_ITEM = {
  to: '/workspace-settings',
  label: 'Workspace Settings',
  icon: SlidersHorizontal,
  group: 'Manage',
};

// Team Lead + Admin can read, same gate as Bot Config/Workspace Settings —
// only Admin can write, enforced client-side inside the page itself and again
// by the API on POST/PATCH.
const TEMPLATES_NAV_ITEM = {
  to: '/templates',
  label: 'Templates',
  icon: MessageSquare,
  group: 'Manage',
};

const ROLE_LABEL: Record<string, string> = {
  agent: 'Agent',
  team_lead: 'Team Lead',
  admin: 'Admin',
};

export function AgentConsoleShell() {
  const navigate = useNavigate();
  const [session, setSession] = useState(loadAgentSession);
  // StrictMode double-invokes mount effects in development — mirrors
  // WebviewShell.tsx's startedRef guard for the same reason: scrubToken
  // removes the fragment as a side effect of the first run, so a naive
  // second run would read an already-scrubbed URL and see no boot data.
  const bootConsumedRef = useRef(false);
  // Defaults to a neutral/offline look while GET /agent/presence is in flight.
  const [presence, setPresence] = useState<DisplayStatus>('offline');

  // One effect, not two: boot consumption and the login redirect must not run
  // as independent effects on the same commit — the redirect would otherwise
  // read the pre-boot `session` (still null) and fire navigate('/login')
  // before the boot-triggered setSession has had a chance to re-render.
  useEffect(() => {
    if (!bootConsumedRef.current) {
      bootConsumedRef.current = true;
      const boot = readConsoleBoot(window.location);
      if (boot) {
        saveAgentSession({
          token: boot.token,
          agentId: boot.agentId,
          displayName: boot.displayName,
          workspaceSlug: '',
          workspaceId: boot.workspaceId,
        });
        scrubToken(window.history, window.location);
        setSession(loadAgentSession());
        return;
      }
    }
    if (!session) navigate('/login');
  }, [session, navigate]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void fetchPresence(session.token).then((res) => {
      if (!cancelled) setPresence(res.status);
    });
    return () => {
      cancelled = true;
    };
  }, [session]);

  const membershipsForFallback = useQuery({
    queryKey: ['memberships'],
    queryFn: () => fetchMemberships(session!.token),
    enabled: session !== null,
  });

  useEffect(() => {
    if (!session || !membershipsForFallback.data) return;
    const memberships = membershipsForFallback.data.memberships;
    if (memberships.length === 0) return;
    const current = memberships.find((m) => m.workspace_id === session.workspaceId);
    if (current) {
      // Membership for the current workspace still exists — reconcile its
      // role in case it changed since login (e.g. promoted to team lead)
      // rather than only reacting when the membership disappears entirely.
      // A team lead promoted while their tab stayed open would otherwise
      // keep showing "Agent" (and the form-builder nav gated on it) until
      // they logged out or switched workspace away and back.
      if (current.role !== session.role) {
        saveAgentSession({ ...session, role: current.role });
        setSession(loadAgentSession());
      }
      return;
    }
    const fallback = memberships[0]!;
    saveAgentSession({
      ...session,
      workspaceId: fallback.workspace_id,
      workspaceSlug: fallback.workspace_slug,
      role: fallback.role,
    });
    saveLastActiveWorkspaceId(fallback.workspace_id);
    setSession(loadAgentSession());
  }, [session, membershipsForFallback.data]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const socket = createSocket(session.token, 'agent');
    // The socket's own connect handshake — auth, DB membership lookup, then
    // incrementPresence — routinely takes longer than the REST snapshot in
    // the effect above, so that snapshot can land while this connection is
    // still mid-handshake and show a stale "offline" that nothing then
    // corrects if the presence_changed broadcast is missed (e.g. a room-join
    // race). Re-fetching on this socket's own 'connect' reconciles the dot
    // the moment the connection is actually live, on both first connect and
    // any later reconnect — no dependency on catching that one broadcast.
    socket.on('connect', () => {
      void fetchPresence(session.token).then((res) => {
        if (!cancelled) setPresence(res.status);
      });
    });
    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') handleSessionExpired();
    });
    socket.on('presence_changed', (payload: { agentId: string; status: DisplayStatus }) => {
      if (payload.agentId === session.agentId) setPresence(payload.status);
    });
    return () => {
      cancelled = true;
      socket.close();
    };
  }, [session]);

  if (!session) return null;

  function handlePresenceSelect(status: 'online' | 'away') {
    setPresence(status);
    void updatePresence(session!.token, status);
  }

  const navItems = canBuildForms(session)
    ? [
        ...NAV_ITEMS,
        FORMS_NAV_ITEM,
        WORKLOAD_NAV_ITEM,
        BOT_CONFIG_NAV_ITEM,
        WORKSPACE_SETTINGS_NAV_ITEM,
        TEMPLATES_NAV_ITEM,
      ]
    : NAV_ITEMS;

  // Preserves NAV_ITEMS/FORMS/WORKLOAD/etc.'s declaration order within each
  // group, and only emits a group header for a group that actually has
  // visible items for this session's role.
  const groups: { name: string; items: typeof navItems }[] = [];
  for (const item of navItems) {
    const group = groups.find((g) => g.name === item.group);
    if (group) group.items.push(item);
    else groups.push({ name: item.group, items: [item] });
  }

  const initials = session.displayName
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const roleLabel = session.role ? ROLE_LABEL[session.role] : undefined;

  return (
    <div className="flex h-screen w-screen bg-bg text-text">
      <aside className="relative z-10 flex w-60 shrink-0 flex-col bg-surface shadow-[1px_0_0_0_var(--color-border),2px_0_12px_0_rgb(15_23_42_/_0.04)]">
        <div className="flex items-center gap-2.5 px-4 py-4">
          <img src={mindstormLogo} alt="" className="size-8 shrink-0 rounded-lg object-contain" />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-semibold text-text">Support</span>
            <span className="truncate text-xs text-muted">Agent Console</span>
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-4 overflow-y-auto p-2 pt-3">
          {groups.map((group) => (
            <div key={group.name} className="flex flex-col gap-1">
              <div className="px-3 text-xs font-semibold tracking-wide text-muted uppercase">
                {group.name}
              </div>
              {group.items.map(({ to, label, icon: Icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  // Warms the tab's lazy chunk before the click lands — by the
                  // time onClick fires, the import is usually already
                  // in-flight or cached, which is most of what makes the
                  // click itself feel instant instead of stalling on a
                  // network+parse round trip.
                  onMouseEnter={() => void agentRoutePreload[to]?.()}
                  onFocus={() => void agentRoutePreload[to]?.()}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-2 rounded-md border-l-2 py-2 pr-3 pl-2.5 text-sm font-medium transition-colors',
                      isActive
                        ? 'border-accent bg-accent-soft text-accent-deep shadow-xs'
                        : 'border-transparent text-muted hover:bg-accent-soft/60 hover:text-text',
                    )
                  }
                >
                  <Icon className="size-4" />
                  {label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
          <WorkspaceSwitcher session={session} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-2 text-sm font-medium text-text"
              >
                <div className="relative">
                  <Avatar className="size-7">
                    <AvatarFallback>{initials}</AvatarFallback>
                  </Avatar>
                  <PresenceDot status={presence} className="absolute -right-0.5 -bottom-0.5" />
                </div>
                {session.displayName}
                {roleLabel && (
                  <Badge variant="secondary" className="text-accent-deep">
                    {roleLabel}
                  </Badge>
                )}
                <ChevronDown className="size-3.5 text-muted" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Status</DropdownMenuLabel>
              {PRESENCE_OPTIONS.map((option) => (
                <DropdownMenuCheckboxItem
                  key={option.value}
                  checked={presence === option.value}
                  onSelect={() => handlePresenceSelect(option.value)}
                >
                  <span className={cn('size-2 rounded-full', option.dotClassName)} />
                  {option.label}
                </DropdownMenuCheckboxItem>
              ))}
              {isAdmin(session) && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => {
                      // New tab, agent-console session untouched — mirrors
                      // admin-console Overview.tsx's "Open console" action in
                      // the opposite direction. The token already carries
                      // is_admin: true, so no new token needs to be minted;
                      // AdminConsoleShell's boot effect confirms it's really
                      // an admin token via GET /admin/agents before trusting it.
                      const params = new URLSearchParams({
                        agentId: session.agentId,
                        name: session.displayName,
                      });
                      window.open(
                        `/dashboard/overview?${params.toString()}#t=${session.token}`,
                        '_blank',
                        'noopener',
                      );
                    }}
                  >
                    <ShieldCheck className="size-4" />
                    Switch to Admin Dashboard
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  clearAgentSession();
                  navigate('/login');
                }}
              >
                <LogOut className="size-4" />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <main className="min-h-0 flex-1 overflow-hidden">
          {/* Its own boundary, nested below the shell's — a tab's lazy chunk
              loading never unmounts the sidebar/header, so the click that
              opens it feels instant and only the content area shows the
              skeleton while the chunk arrives. */}
          <Suspense fallback={<PageSkeleton />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
