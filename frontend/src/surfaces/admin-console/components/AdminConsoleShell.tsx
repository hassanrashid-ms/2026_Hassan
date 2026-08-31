import { Suspense, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { LayoutGrid, LogOut, ShieldCheck } from 'lucide-react';
// admin-console.css is imported HERE and nowhere else — never from main.tsx or
// any statically-reachable module, so its Tailwind preflight never leaks into
// the other two surfaces (mirrors AgentConsoleShell.tsx / WebviewShell.tsx).
import '@/admin-console.css';
import { readAdminConsoleBoot } from '@/lib/adminConsoleBoot.ts';
import { scrubToken } from '@/lib/boot.ts';
import { clearAdminSession, loadAdminSession, saveAdminSession } from '../lib/adminSession.ts';
import { fetchAgents } from '../api/adminApi.ts';
import { Avatar, AvatarFallback } from './ui/avatar.tsx';
import { Badge } from './ui/badge.tsx';
import { Button } from './ui/button.tsx';
import { Separator } from './ui/separator.tsx';
import { PageSkeleton } from './PageSkeleton.tsx';
import { cn } from '../lib/cn.ts';

const NAV_ITEMS = [
  { to: '/dashboard/overview', label: 'Overview', icon: LayoutGrid },
  { to: '/dashboard/admins', label: 'Admins', icon: ShieldCheck },
];

export function AdminConsoleShell() {
  const navigate = useNavigate();
  const [session, setSession] = useState(loadAdminSession);
  // StrictMode double-invokes mount effects in development — mirrors
  // AgentConsoleShell.tsx's startedRef guard for the same reason: scrubToken
  // removes the fragment as a side effect of the first run, so a naive
  // second run would read an already-scrubbed URL and see no boot data.
  const bootConsumedRef = useRef(false);
  const [booting, setBooting] = useState(false);

  useEffect(() => {
    if (!bootConsumedRef.current) {
      bootConsumedRef.current = true;
      const boot = readAdminConsoleBoot(window.location);
      if (boot) {
        setBooting(true);
        // The boot token carries no is_super_admin claim — same lookup
        // routes/Login.tsx does after a normal sign-in, via a route already
        // gated by requireAdminAccess, so a non-admin token fails closed here
        // instead of silently landing with isSuperAdmin: false.
        void fetchAgents(boot.token)
          .then((res) => {
            const self = res.agents.find((a) => a.id === boot.agentId);
            saveAdminSession({
              token: boot.token,
              agentId: boot.agentId,
              displayName: boot.displayName,
              isSuperAdmin: self?.is_super_admin ?? false,
            });
            scrubToken(window.history, window.location);
            setSession(loadAdminSession());
          })
          .catch(() => navigate('/dashboard/login'))
          .finally(() => setBooting(false));
        return;
      }
    }
    if (!session && !booting) navigate('/dashboard/login');
  }, [session, booting, navigate]);

  if (booting || !session) return null;

  const initials = session.displayName
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className="flex h-screen w-screen bg-bg text-text">
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface">
        <div className="flex items-center gap-2.5 px-4 py-4">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-deep text-sm font-semibold text-accent-fg">
            S
          </div>
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-semibold text-text">Support</span>
            <span className="truncate text-xs text-muted">Admin Console</span>
          </div>
        </div>
        <Separator />
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2 pt-3">
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 rounded-md border-l-2 py-2 pr-3 pl-2.5 text-sm font-medium transition-colors',
                  isActive
                    ? 'border-accent bg-accent-soft text-accent-deep'
                    : 'border-transparent text-muted hover:bg-accent-soft/60 hover:text-text',
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
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
          <div className="flex items-center gap-2">
            <Avatar className="size-7">
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
            <span className="text-sm font-medium">{session.displayName}</span>
            {session.isSuperAdmin && (
              <Badge variant="secondary" className="text-muted">
                Super admin
              </Badge>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              clearAdminSession();
              navigate('/dashboard/login');
            }}
          >
            <LogOut className="size-4" />
            Log out
          </Button>
        </header>

        <main className="min-h-0 flex-1 overflow-auto">
          <Suspense fallback={<PageSkeleton />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
