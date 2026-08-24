import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  Inbox as InboxIcon,
  BookOpen,
  ClipboardList,
  ChevronDown,
  LogOut,
  Settings,
  SlidersHorizontal,
  Tags,
  Gauge,
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
} from '../lib/agentSession.ts';
import { fetchPresence, updatePresence, type DisplayStatus } from '../api/agentApi.ts';
import { createSocket } from '../../../features/chat/api/socket.ts';
import { Avatar, AvatarFallback } from './ui/avatar.tsx';
import { Button } from './ui/button.tsx';
import { Separator } from './ui/separator.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.tsx';
import { PresenceDot } from './PresenceDot.tsx';
import { cn } from '../lib/cn.ts';

const PRESENCE_OPTIONS: { value: 'online' | 'away'; label: string }[] = [
  { value: 'online', label: 'Online' },
  { value: 'away', label: 'Away' },
];

const NAV_ITEMS = [
  { to: '/inbox', label: 'Inbox', icon: InboxIcon },
  { to: '/tickets', label: 'Tickets', icon: ClipboardList },
  { to: '/articles', label: 'Knowledge Base', icon: BookOpen },
  { to: '/taxonomy', label: 'Taxonomy', icon: Tags },
];

// Team Lead + Admin only — an Agent would 403 at the API anyway
// (requireWorkspaceRole('team_lead', 'admin') on formsRouter), so hiding the
// link here is UX, not the enforcement point.
const FORMS_NAV_ITEM = { to: '/forms', label: 'Forms', icon: ClipboardList };

// Team Lead + Admin only, same gate as Forms above — an Agent would 403 at
// the API anyway once /agent/workload is implemented.
const WORKLOAD_NAV_ITEM = { to: '/workload', label: 'Team', icon: Gauge };

// Admin-only in the permission matrix ("Edit bot prompt or rules" is Admin).
// Hiding the link here is UX, not the enforcement point — the API still
// requires admin on POST/rollback.
const BOT_CONFIG_NAV_ITEM = { to: '/bot-config', label: 'Bot Config', icon: Settings };

// Team Lead + Admin can read (GET /agent/workspace-settings), same gate as
// Forms/Workload above — only Admin can write, enforced client-side inside
// the page itself and again by the API on POST.
const WORKSPACE_SETTINGS_NAV_ITEM = {
  to: '/workspace-settings',
  label: 'Workspace Settings',
  icon: SlidersHorizontal,
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

  useEffect(() => {
    if (!session) return;
    const socket = createSocket(session.token, 'agent', session.workspaceId);
    socket.on('presence_changed', (payload: { agentId: string; status: DisplayStatus }) => {
      if (payload.agentId === session.agentId) setPresence(payload.status);
    });
    return () => {
      socket.close();
    };
  }, [session]);

  if (!session) return null;

  function handlePresenceSelect(status: 'online' | 'away') {
    setPresence(status);
    void updatePresence(session!.token, status);
  }

  const navItems = [
    ...(canBuildForms(session)
      ? [...NAV_ITEMS, FORMS_NAV_ITEM, WORKLOAD_NAV_ITEM, WORKSPACE_SETTINGS_NAV_ITEM]
      : NAV_ITEMS),
    ...(isAdmin(session) ? [BOT_CONFIG_NAV_ITEM] : []),
  ];

  const initials = session.displayName
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className="flex h-screen w-screen bg-bg text-text">
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-surface">
        <div className="px-4 py-4 text-sm font-semibold">Support Console</div>
        <Separator />
        <nav className="flex flex-col gap-1 p-2">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive ? 'bg-accent-soft text-text' : 'text-muted hover:bg-accent-soft/60',
                )
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 px-4">
          <div className="flex items-center gap-2">
            <div className="relative">
              <Avatar className="size-7">
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
              <PresenceDot status={presence} className="absolute -right-0.5 -bottom-0.5" />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-1 text-sm font-medium text-text"
                >
                  {session.displayName}
                  <ChevronDown className="size-3.5 text-muted" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {PRESENCE_OPTIONS.map((option) => (
                  <DropdownMenuItem
                    key={option.value}
                    onSelect={() => handlePresenceSelect(option.value)}
                  >
                    {option.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              clearAgentSession();
              navigate('/login');
            }}
          >
            <LogOut className="size-4" />
            Log out
          </Button>
        </header>

        <main className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
