import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { Inbox as InboxIcon, BookOpen, ClipboardList, LogOut, Settings, Tags } from 'lucide-react'
// agent-console.css is imported HERE and nowhere else — never from main.tsx or
// any statically-reachable module, so its Tailwind preflight never leaks into
// the webview surface (mirrors WebviewShell.tsx's isolation of webview.css).
import '@/agent-console.css'
import { readConsoleBoot } from '@/lib/consoleBoot.ts'
import { scrubToken } from '@/lib/boot.ts'
import { canBuildForms, clearAgentSession, isAdmin, loadAgentSession, saveAgentSession } from '../lib/agentSession.ts'
import { Avatar, AvatarFallback } from './ui/avatar.tsx'
import { Button } from './ui/button.tsx'
import { Separator } from './ui/separator.tsx'
import { cn } from '../lib/cn.ts'

const NAV_ITEMS = [
  { to: '/inbox', label: 'Inbox', icon: InboxIcon },
  { to: '/tickets', label: 'Tickets', icon: ClipboardList },
  { to: '/articles', label: 'Knowledge Base', icon: BookOpen },
  { to: '/taxonomy', label: 'Taxonomy', icon: Tags },
]

// Team Lead + Admin only — an Agent would 403 at the API anyway
// (requireWorkspaceRole('team_lead', 'admin') on formsRouter), so hiding the
// link here is UX, not the enforcement point.
const FORMS_NAV_ITEM = { to: '/forms', label: 'Forms', icon: ClipboardList }

// Admin-only in the permission matrix ("Edit bot prompt or rules" is Admin).
// Hiding the link here is UX, not the enforcement point — the API still
// requires admin on POST/rollback.
const BOT_CONFIG_NAV_ITEM = { to: '/bot-config', label: 'Bot Config', icon: Settings }

export function AgentConsoleShell() {
  const navigate = useNavigate()
  const [session, setSession] = useState(loadAgentSession)
  // StrictMode double-invokes mount effects in development — mirrors
  // WebviewShell.tsx's startedRef guard for the same reason: scrubToken
  // removes the fragment as a side effect of the first run, so a naive
  // second run would read an already-scrubbed URL and see no boot data.
  const bootConsumedRef = useRef(false)

  // One effect, not two: boot consumption and the login redirect must not run
  // as independent effects on the same commit — the redirect would otherwise
  // read the pre-boot `session` (still null) and fire navigate('/login')
  // before the boot-triggered setSession has had a chance to re-render.
  useEffect(() => {
    if (!bootConsumedRef.current) {
      bootConsumedRef.current = true
      const boot = readConsoleBoot(window.location)
      if (boot) {
        saveAgentSession({
          token: boot.token,
          agentId: boot.agentId,
          displayName: boot.displayName,
          workspaceSlug: '',
          workspaceId: boot.workspaceId,
        })
        scrubToken(window.history, window.location)
        setSession(loadAgentSession())
        return
      }
    }
    if (!session) navigate('/login')
  }, [session, navigate])

  if (!session) return null

  const navItems = [
    ...(canBuildForms(session) ? [...NAV_ITEMS, FORMS_NAV_ITEM] : NAV_ITEMS),
    ...(isAdmin(session) ? [BOT_CONFIG_NAV_ITEM] : []),
  ]

  const initials = session.displayName
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

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
            <Avatar className="size-7">
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
            <span className="text-sm font-medium">{session.displayName}</span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              clearAgentSession()
              navigate('/login')
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
  )
}
