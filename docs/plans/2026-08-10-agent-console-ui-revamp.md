# Agent Console UI Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle and restructure the agent-console surface (Inbox, Conversation, Admin Articles) with Tailwind v4 + shadcn/ui, mirroring the pattern already shipped for the webview surface (`docs/specs/2026-08-10-webview-game-ui-design.md`), per `docs/specs/2026-08-10-agent-console-ui-revamp-design.md`.

**Architecture:** New `agent-console.css` (Tailwind v4 CSS-first config, slate base color) scoped and lazily imported only by the new `AgentConsoleShell` layout route — mirroring how `webview.css` is isolated from the rest of the app today. shadcn primitives live under `surfaces/agent-console/components/ui/`. `/inbox` and `/inbox/:conversationId` become one merged split-view page; `/articles` (renamed from `/admin/articles`) becomes the Knowledge Base page with a slide-in editor `Sheet`. No backend or `@support/types` changes — this is pure frontend restructuring.

**Tech Stack:** Vite + React + TypeScript, Tailwind v4 (`@tailwindcss/vite`), shadcn/ui (new-york style, Radix primitives), TanStack Query, react-router-dom, Socket.io-client, MDXEditor (new dependency).

## Global Constraints

- No backend/API changes. `agentApi.ts` and `@support/types` contracts are unchanged — do not modify `backend/` or `packages/types/` in this plan.
- No changes to `AgentLogin.tsx` or `/login` — it stays outside `AgentConsoleShell`, untouched.
- No dark mode — light theme only.
- No new conversation-priority/SLA features — visual/structural only, same functionality as today.
- `agent-console.css` must **only** be imported by the new shell/layout route (lazy import), never from `main.tsx` or any statically-reachable module — otherwise Tailwind's preflight reset leaks into the webview surface (see `AppRoutes.tsx`'s existing comment on this).
- shadcn base color for agent-console is **slate** (webview uses violet) — the two surfaces must be visually distinguishable.
- All existing behavior (claim mutation + `conversation:changed` socket invalidation, `join_conversation`/`message:new`/mark-as-read socket logic, `canEditFields`/`canPublish` enablement logic) must be preserved unchanged — only presentation and file location change.

---

## File Structure

```
frontend/
├── agent-console-components.json          (new — shadcn config for this surface)
├── src/
│   ├── agent-console.css                  (new — scoped Tailwind v4 entry)
│   ├── routes/AppRoutes.tsx                (modified — new routes, lazy shell)
│   └── surfaces/agent-console/
│       ├── api/agentApi.ts                 (unchanged)
│       ├── lib/
│       │   ├── agentSession.ts             (unchanged)
│       │   └── cn.ts                       (new)
│       ├── components/
│       │   ├── AgentConsoleShell.tsx       (new)
│       │   └── ui/                         (new — shadcn primitives)
│       │       ├── button.tsx
│       │       ├── input.tsx
│       │       ├── textarea.tsx
│       │       ├── select.tsx
│       │       ├── tabs.tsx
│       │       ├── badge.tsx
│       │       ├── card.tsx
│       │       ├── sheet.tsx
│       │       ├── table.tsx
│       │       ├── dialog.tsx
│       │       ├── avatar.tsx
│       │       ├── dropdown-menu.tsx
│       │       ├── separator.tsx
│       │       └── scroll-area.tsx
│       └── pages/
│           ├── AgentLogin.tsx              (unchanged, out of scope)
│           ├── Inbox/
│           │   ├── Inbox.tsx               (new)
│           │   └── components/
│           │       ├── ConversationList.tsx      (new)
│           │       ├── ConversationList.test.tsx (new)
│           │       ├── ConversationRow.tsx        (new)
│           │       └── ThreadPanel.tsx            (new)
│           └── KnowledgeBase/
│               ├── KnowledgeBase.tsx        (new)
│               ├── articleForm.ts           (moved from pages/, unchanged content)
│               ├── articleForm.test.ts      (moved from pages/, unchanged content)
│               └── components/
│                   ├── CategorySidebar.tsx        (new)
│                   ├── ArticleTable.tsx            (new)
│                   ├── ArticleEditorSheet.tsx       (new)
│                   └── ArticleEditorSheet.test.tsx  (new)
```

Deleted at the end of this plan: `pages/AgentInbox.tsx`, `pages/AgentConversation.tsx`, `pages/AdminArticles.tsx`, `pages/articleForm.ts`, `pages/articleForm.test.ts` (last two after their move is confirmed).

---

### Task 1: Foundation — dependencies, shadcn config, scoped CSS, cn utility

**Files:**
- Create: `frontend/agent-console-components.json`
- Create: `frontend/src/agent-console.css`
- Create: `frontend/src/surfaces/agent-console/lib/cn.ts`
- Modify: `frontend/package.json` (add dependencies)

**Interfaces:**
- Produces: `cn(...inputs: ClassValue[]): string` from `frontend/src/surfaces/agent-console/lib/cn.ts` — every later component imports this, not the webview's `cn`.
- Produces: `agent-console.css` importable via `import '@/agent-console.css'` — consumed by Task 4's shell.

- [ ] **Step 1: Add new dependencies**

Run:
```bash
cd frontend && pnpm add @radix-ui/react-select @radix-ui/react-avatar @radix-ui/react-dropdown-menu @radix-ui/react-separator @mdxeditor/editor
```

`@radix-ui/react-tabs`, `@radix-ui/react-dialog`, `@radix-ui/react-scroll-area` are already present (webview already ships `tabs`, `dialog`/`sheet`, `scroll-area`) — confirm with:
```bash
grep -E '"@radix-ui/react-(tabs|dialog|scroll-area)"' frontend/package.json
```
Expected: all three present. If any is missing, add it with `pnpm add @radix-ui/react-<name>`.

- [ ] **Step 2: Create the agent-console shadcn config**

Create `frontend/agent-console-components.json`:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/agent-console.css",
    "baseColor": "slate",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "@/surfaces/agent-console/components",
    "ui": "@/surfaces/agent-console/components/ui",
    "utils": "@/surfaces/agent-console/lib/cn",
    "lib": "@/surfaces/agent-console/lib",
    "hooks": "@/surfaces/agent-console/hooks"
  },
  "iconLibrary": "lucide"
}
```

This is a second, separate config file (not the root `components.json`, which stays webview's) — its only role is to document this surface's shadcn setup for future `shadcn add` runs; the primitives in Tasks 2–3 are hand-written here to avoid an interactive CLI step.

- [ ] **Step 3: Create the scoped Tailwind v4 CSS entry**

Create `frontend/src/agent-console.css`:

```css
/*
 * The agent-console surface's entire stylesheet.
 *
 * Imported only by AgentConsoleShell.tsx via a lazy route — never by main.tsx
 * or any statically-reachable module. Mirrors webview.css's isolation: Vite
 * concatenates every statically reachable stylesheet into one bundle, so a
 * static import here would leak Tailwind's preflight reset into the webview
 * surface even though it never asks for it.
 */

@import "tailwindcss";

@theme {
  --color-bg:          #ffffff;
  --color-surface:     #f8fafc;  /* slate-50, agent-console's neutral card background */
  --color-accent:      #475569;  /* slate-600, primary */
  --color-accent-deep: #1e293b;  /* slate-800 */
  --color-accent-soft: #f1f5f9;  /* slate-100, selected row / active tab background */
  --color-accent-fg:   #ffffff;
  --color-text:        #0f172a;  /* slate-900 */
  --color-muted:       #64748b;  /* slate-500 */
  --radius-card:       0.75rem;
}

body {
  background: var(--color-bg);
  color: var(--color-text);
}

@utility no-scrollbar {
  scrollbar-width: none;
  -ms-overflow-style: none;
  &::-webkit-scrollbar {
    display: none;
  }
}
```

- [ ] **Step 4: Create the agent-console `cn` utility**

Create `frontend/src/surfaces/agent-console/lib/cn.ts`:

```typescript
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** shadcn's class merger. Lives inside the agent-console surface, not shared
 *  lib/ or the webview's copy, so each surface's Tailwind config stays isolated. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
```

- [ ] **Step 5: Verify the workspace still typechecks and installs cleanly**

Run: `cd frontend && pnpm install && pnpm typecheck`
Expected: no errors (no code yet references the new files except each other).

- [ ] **Step 6: Commit**

```bash
git add frontend/agent-console-components.json frontend/src/agent-console.css frontend/src/surfaces/agent-console/lib/cn.ts frontend/package.json frontend/pnpm-lock.yaml
git commit -m "feat(agent-console): add Tailwind v4 + shadcn foundation for revamp"
```

---

### Task 2: shadcn primitives — button, input, textarea, badge, card, separator, avatar

**Files:**
- Create: `frontend/src/surfaces/agent-console/components/ui/button.tsx`
- Create: `frontend/src/surfaces/agent-console/components/ui/input.tsx`
- Create: `frontend/src/surfaces/agent-console/components/ui/textarea.tsx`
- Create: `frontend/src/surfaces/agent-console/components/ui/badge.tsx`
- Create: `frontend/src/surfaces/agent-console/components/ui/card.tsx`
- Create: `frontend/src/surfaces/agent-console/components/ui/separator.tsx`
- Create: `frontend/src/surfaces/agent-console/components/ui/avatar.tsx`

**Interfaces:**
- Consumes: `cn` from `../../lib/cn.ts` (Task 1).
- Produces: `Button`, `buttonVariants`, `Input`, `Textarea`, `Badge`, `badgeVariants`, `Card`/`CardHeader`/`CardTitle`/`CardDescription`/`CardContent`/`CardFooter`, `Separator`, `Avatar`/`AvatarImage`/`AvatarFallback` — consumed by every page task below.

- [ ] **Step 1: Create `button.tsx`**

```typescript
import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/cn.ts'

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-accent [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: 'bg-accent text-accent-fg hover:bg-accent-deep',
        destructive: 'bg-red-600 text-white hover:bg-red-700',
        outline: 'border border-slate-200 bg-bg hover:bg-accent-soft',
        secondary: 'bg-accent-soft text-text hover:bg-slate-200',
        ghost: 'hover:bg-accent-soft',
        link: 'text-accent underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-6',
        icon: 'size-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button'
  return <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />
}

export { Button, buttonVariants }
```

Requires `@radix-ui/react-slot`; confirm it's installed (webview's button likely already pulled it in) with `grep '@radix-ui/react-slot' frontend/package.json`. If missing: `cd frontend && pnpm add @radix-ui/react-slot`.

- [ ] **Step 2: Create `input.tsx`**

```typescript
import * as React from 'react'
import { cn } from '../../lib/cn.ts'

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      className={cn(
        'flex h-9 w-full min-w-0 rounded-md border border-slate-200 bg-bg px-3 py-1 text-sm shadow-xs transition-colors outline-none',
        'placeholder:text-muted disabled:pointer-events-none disabled:opacity-50',
        'focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
```

- [ ] **Step 3: Create `textarea.tsx`**

```typescript
import * as React from 'react'
import { cn } from '../../lib/cn.ts'

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'flex min-h-16 w-full rounded-md border border-slate-200 bg-bg px-3 py-2 text-sm shadow-xs transition-colors outline-none',
        'placeholder:text-muted disabled:pointer-events-none disabled:opacity-50',
        'focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30',
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
```

- [ ] **Step 4: Create `badge.tsx`**

```typescript
import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/cn.ts'

const badgeVariants = cva(
  'inline-flex items-center justify-center rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap w-fit shrink-0 gap-1',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-accent text-accent-fg',
        secondary: 'border-transparent bg-accent-soft text-text',
        outline: 'border-slate-200 text-text',
        success: 'border-transparent bg-emerald-100 text-emerald-800',
        warning: 'border-transparent bg-amber-100 text-amber-800',
        info: 'border-transparent bg-sky-100 text-sky-800',
        destructive: 'border-transparent bg-red-100 text-red-800',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'span'
  return <Comp className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
```

- [ ] **Step 5: Create `card.tsx`**

```typescript
import * as React from 'react'
import { cn } from '../../lib/cn.ts'

function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('rounded-card border border-slate-200 bg-bg shadow-xs', className)} {...props} />
}
function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1.5 p-4', className)} {...props} />
}
function CardTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('text-sm font-semibold leading-none', className)} {...props} />
}
function CardDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('text-sm text-muted', className)} {...props} />
}
function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('p-4 pt-0', className)} {...props} />
}
function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex items-center p-4 pt-0', className)} {...props} />
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter }
```

- [ ] **Step 6: Create `separator.tsx`**

```typescript
import * as SeparatorPrimitive from '@radix-ui/react-separator'
import { cn } from '../../lib/cn.ts'

function Separator({
  className,
  orientation = 'horizontal',
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      decorative={decorative}
      orientation={orientation}
      className={cn(
        'shrink-0 bg-slate-200',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...props}
    />
  )
}

export { Separator }
```

- [ ] **Step 7: Create `avatar.tsx`**

```typescript
import * as AvatarPrimitive from '@radix-ui/react-avatar'
import { cn } from '../../lib/cn.ts'

function Avatar({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Root>) {
  return (
    <AvatarPrimitive.Root
      className={cn('relative flex size-8 shrink-0 overflow-hidden rounded-full', className)}
      {...props}
    />
  )
}
function AvatarImage({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Image>) {
  return <AvatarPrimitive.Image className={cn('aspect-square size-full', className)} {...props} />
}
function AvatarFallback({ className, ...props }: React.ComponentProps<typeof AvatarPrimitive.Fallback>) {
  return (
    <AvatarPrimitive.Fallback
      className={cn('flex size-full items-center justify-center rounded-full bg-accent-soft text-sm font-medium text-text', className)}
      {...props}
    />
  )
}

export { Avatar, AvatarImage, AvatarFallback }
```

- [ ] **Step 8: Typecheck**

Run: `cd frontend && pnpm typecheck`
Expected: no errors. If `@radix-ui/react-slot` is missing this will surface here — install it as noted in Step 1.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/surfaces/agent-console/components/ui/button.tsx frontend/src/surfaces/agent-console/components/ui/input.tsx frontend/src/surfaces/agent-console/components/ui/textarea.tsx frontend/src/surfaces/agent-console/components/ui/badge.tsx frontend/src/surfaces/agent-console/components/ui/card.tsx frontend/src/surfaces/agent-console/components/ui/separator.tsx frontend/src/surfaces/agent-console/components/ui/avatar.tsx frontend/package.json frontend/pnpm-lock.yaml
git commit -m "feat(agent-console): add button/input/textarea/badge/card/separator/avatar primitives"
```

---

### Task 3: shadcn primitives — tabs, sheet, dialog, table, scroll-area, select, dropdown-menu

**Files:**
- Create: `frontend/src/surfaces/agent-console/components/ui/tabs.tsx`
- Create: `frontend/src/surfaces/agent-console/components/ui/sheet.tsx`
- Create: `frontend/src/surfaces/agent-console/components/ui/dialog.tsx`
- Create: `frontend/src/surfaces/agent-console/components/ui/table.tsx`
- Create: `frontend/src/surfaces/agent-console/components/ui/scroll-area.tsx`
- Create: `frontend/src/surfaces/agent-console/components/ui/select.tsx`
- Create: `frontend/src/surfaces/agent-console/components/ui/dropdown-menu.tsx`

**Interfaces:**
- Consumes: `cn` from `../../lib/cn.ts` (Task 1).
- Produces: `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent`, `Sheet` family, `Dialog` family, `Table` family, `ScrollArea`, `Select` family, `DropdownMenu` family — consumed by Task 6 (ThreadPanel tabs), Task 7 (Inbox tabs), Task 10 (ArticleEditorSheet), Task 9 (ArticleTable).

- [ ] **Step 1: Create `tabs.tsx`**

```typescript
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { cn } from '../../lib/cn.ts'

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root className={cn('flex flex-col gap-2', className)} {...props} />
}
function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn('inline-flex h-9 w-fit items-center justify-center rounded-md bg-accent-soft p-1', className)}
      {...props}
    />
  )
}
function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'inline-flex h-7 flex-1 items-center justify-center rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors',
        'text-muted data-[state=active]:bg-bg data-[state=active]:text-text data-[state=active]:shadow-xs',
        className,
      )}
      {...props}
    />
  )
}
function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn('flex-1 outline-none', className)} {...props} />
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
```

- [ ] **Step 2: Create `dialog.tsx`**

```typescript
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { XIcon } from 'lucide-react'
import { cn } from '../../lib/cn.ts'

function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root {...props} />
}
function DialogTrigger(props: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger {...props} />
}
function DialogPortal(props: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal {...props} />
}
function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        'fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        className,
      )}
      {...props}
    />
  )
}
function DialogContent({ className, children, ...props }: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          'fixed top-1/2 left-1/2 z-50 grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 rounded-card border border-slate-200 bg-bg p-6 shadow-lg',
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="absolute top-4 right-4 rounded-xs opacity-70 outline-none hover:opacity-100">
          <XIcon className="size-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}
function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-2 text-center sm:text-left', className)} {...props} />
}
function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props} />
}
function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('text-lg leading-none font-semibold', className)} {...props} />
}
function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn('text-sm text-muted', className)} {...props} />
}

export {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
```

- [ ] **Step 3: Create `sheet.tsx`** (built on the same `@radix-ui/react-dialog` primitive, slide-in variant)

```typescript
import * as SheetPrimitive from '@radix-ui/react-dialog'
import { XIcon } from 'lucide-react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/cn.ts'

function Sheet(props: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root {...props} />
}
function SheetTrigger(props: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger {...props} />
}
function SheetClose(props: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close {...props} />
}
function SheetOverlay({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      className={cn(
        'fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        className,
      )}
      {...props}
    />
  )
}

const sheetVariants = cva(
  'fixed z-50 flex flex-col gap-4 bg-bg shadow-lg transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500',
  {
    variants: {
      side: {
        right:
          'inset-y-0 right-0 h-full w-full border-l border-slate-200 sm:max-w-xl data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:animate-in data-[state=open]:slide-in-from-right',
        left: 'inset-y-0 left-0 h-full w-full border-r border-slate-200 sm:max-w-xl data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left data-[state=open]:animate-in data-[state=open]:slide-in-from-left',
        top: 'inset-x-0 top-0 h-auto border-b border-slate-200',
        bottom: 'inset-x-0 bottom-0 h-auto border-t border-slate-200',
      },
    },
    defaultVariants: { side: 'right' },
  },
)

function SheetContent({
  className,
  children,
  side = 'right',
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & VariantProps<typeof sheetVariants>) {
  return (
    <SheetPrimitive.Portal>
      <SheetOverlay />
      <SheetPrimitive.Content className={cn(sheetVariants({ side }), className)} {...props}>
        {children}
        <SheetPrimitive.Close className="absolute top-4 right-4 rounded-xs opacity-70 outline-none hover:opacity-100">
          <XIcon className="size-4" />
          <span className="sr-only">Close</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  )
}
function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1.5 p-4', className)} {...props} />
}
function SheetFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('mt-auto flex flex-col gap-2 p-4', className)} {...props} />
}
function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return <SheetPrimitive.Title className={cn('font-semibold text-text', className)} {...props} />
}
function SheetDescription({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return <SheetPrimitive.Description className={cn('text-sm text-muted', className)} {...props} />
}

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetFooter, SheetTitle, SheetDescription }
```

- [ ] **Step 4: Create `table.tsx`**

```typescript
import { cn } from '../../lib/cn.ts'

function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <div className="relative w-full overflow-x-auto">
      <table className={cn('w-full caption-bottom text-sm', className)} {...props} />
    </div>
  )
}
function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return <thead className={cn('[&_tr]:border-b [&_tr]:border-slate-200', className)} {...props} />
}
function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return <tbody className={cn('[&_tr:last-child]:border-0', className)} {...props} />
}
function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr className={cn('border-b border-slate-100 transition-colors hover:bg-accent-soft/50', className)} {...props} />
  )
}
function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      className={cn('h-10 px-3 text-left align-middle text-xs font-medium text-muted', className)}
      {...props}
    />
  )
}
function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return <td className={cn('p-3 align-middle', className)} {...props} />
}

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell }
```

- [ ] **Step 5: Create `scroll-area.tsx`**

```typescript
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area'
import { cn } from '../../lib/cn.ts'

function ScrollArea({ className, children, ...props }: React.ComponentProps<typeof ScrollAreaPrimitive.Root>) {
  return (
    <ScrollAreaPrimitive.Root className={cn('relative overflow-hidden', className)} {...props}>
      <ScrollAreaPrimitive.Viewport className="size-full rounded-[inherit]">{children}</ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}
function ScrollBar({
  className,
  orientation = 'vertical',
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      orientation={orientation}
      className={cn(
        'flex touch-none p-px transition-colors select-none',
        orientation === 'vertical' && 'h-full w-2.5 border-l border-l-transparent',
        orientation === 'horizontal' && 'h-2.5 flex-col border-t border-t-transparent',
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-slate-300" />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
```

- [ ] **Step 6: Create `select.tsx`**

```typescript
import * as SelectPrimitive from '@radix-ui/react-select'
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from 'lucide-react'
import { cn } from '../../lib/cn.ts'

function Select(props: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root {...props} />
}
function SelectValue(props: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value {...props} />
}
function SelectTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-slate-200 bg-bg px-3 py-2 text-sm shadow-xs outline-none',
        'focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="size-4 opacity-50" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}
function SelectContent({
  className,
  children,
  position = 'popper',
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position={position}
        className={cn(
          'relative z-50 max-h-96 min-w-32 overflow-hidden rounded-md border border-slate-200 bg-bg shadow-md',
          position === 'popper' && 'data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="flex items-center justify-center py-1">
          <ChevronUpIcon className="size-4" />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex items-center justify-center py-1">
          <ChevronDownIcon className="size-4" />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}
function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        'relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-none select-none',
        'focus:bg-accent-soft data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

export { Select, SelectValue, SelectTrigger, SelectContent, SelectItem }
```

- [ ] **Step 7: Create `dropdown-menu.tsx`**

```typescript
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { CheckIcon } from 'lucide-react'
import { cn } from '../../lib/cn.ts'

function DropdownMenu(props: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root {...props} />
}
function DropdownMenuTrigger(props: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger {...props} />
}
function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-32 overflow-hidden rounded-md border border-slate-200 bg-bg p-1 shadow-md',
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
}
function DropdownMenuItem({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & { variant?: 'default' | 'destructive' }) {
  return (
    <DropdownMenuPrimitive.Item
      className={cn(
        'relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none',
        'focus:bg-accent-soft data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    />
  )
}
function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      className={cn(
        'relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-none select-none',
        'focus:bg-accent-soft data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      checked={checked}
      {...props}
    >
      <span className="absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  )
}
function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return <DropdownMenuPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-slate-100', className)} {...props} />
}
function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return <DropdownMenuPrimitive.Label className={cn('px-2 py-1.5 text-xs font-medium text-muted', className)} {...props} />
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
}
```

- [ ] **Step 8: Typecheck**

Run: `cd frontend && pnpm typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/surfaces/agent-console/components/ui/tabs.tsx frontend/src/surfaces/agent-console/components/ui/sheet.tsx frontend/src/surfaces/agent-console/components/ui/dialog.tsx frontend/src/surfaces/agent-console/components/ui/table.tsx frontend/src/surfaces/agent-console/components/ui/scroll-area.tsx frontend/src/surfaces/agent-console/components/ui/select.tsx frontend/src/surfaces/agent-console/components/ui/dropdown-menu.tsx
git commit -m "feat(agent-console): add tabs/sheet/dialog/table/scroll-area/select/dropdown-menu primitives"
```

---

### Task 4: AgentConsoleShell + routing

**Files:**
- Create: `frontend/src/surfaces/agent-console/components/AgentConsoleShell.tsx`
- Modify: `frontend/src/routes/AppRoutes.tsx`

**Interfaces:**
- Consumes: `loadAgentSession`, `clearAgentSession` from `../lib/agentSession.ts`; `Button`, `Avatar`/`AvatarFallback`, `Separator` from `./ui/*`.
- Produces: `AgentConsoleShell` — a layout route rendered via `<Outlet />`, redirects to `/login` if no session, renders left nav (Inbox, Knowledge Base) + topbar (agent name, logout).

- [ ] **Step 1: Create `AgentConsoleShell.tsx`**

```typescript
import { useEffect } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { Inbox as InboxIcon, BookOpen, LogOut } from 'lucide-react'
import { clearAgentSession, loadAgentSession } from '../lib/agentSession.ts'
import { Avatar, AvatarFallback } from './ui/avatar.tsx'
import { Button } from './ui/button.tsx'
import { Separator } from './ui/separator.tsx'
import { cn } from '../lib/cn.ts'

const NAV_ITEMS = [
  { to: '/inbox', label: 'Inbox', icon: InboxIcon },
  { to: '/articles', label: 'Knowledge Base', icon: BookOpen },
]

export function AgentConsoleShell() {
  const navigate = useNavigate()
  const session = loadAgentSession()

  useEffect(() => {
    if (!session) navigate('/login')
  }, [session, navigate])

  if (!session) return null

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
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
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
```

- [ ] **Step 2: Wire routing in `AppRoutes.tsx`**

Modify `frontend/src/routes/AppRoutes.tsx` — replace the three old imports and the three old agent-console `<Route>` entries. Full new file:

```typescript
import { Suspense, lazy } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AgentLogin } from '../surfaces/agent-console/pages/AgentLogin.tsx'

/*
 * agent-console.css is scoped the same way webview.css is: lazily imported by
 * AgentConsoleShell.tsx alone, never statically, so its Tailwind preflight
 * reset never reaches the webview bundle (see the comment on WebviewShell below).
 */
const AgentConsoleShell = lazy(async () => ({
  default: (await import('../surfaces/agent-console/components/AgentConsoleShell.tsx')).AgentConsoleShell,
}))
const Inbox = lazy(async () => ({ default: (await import('../surfaces/agent-console/pages/Inbox/Inbox.tsx')).Inbox }))
const KnowledgeBase = lazy(async () => ({
  default: (await import('../surfaces/agent-console/pages/KnowledgeBase/KnowledgeBase.tsx')).KnowledgeBase,
}))

/*
 * The webview is lazily imported, and that is a correctness requirement rather
 * than a performance tweak.
 *
 * WebviewShell is the only importer of webview.css — but "only importer" is not
 * by itself isolation: Vite concatenates every statically reachable stylesheet
 * into one bundle, so a static import would ship Tailwind's preflight reset to
 * the agent console in production even though no console module mentions it.
 * A dynamic import puts the webview's CSS in its own chunk, fetched only when a
 * /embed/support route actually renders. Verified by there being two .css files
 * in dist/assets, not one.
 */
const WebviewShell = lazy(async () => ({ default: (await import('../surfaces/webview/components/WebviewShell.tsx')).WebviewShell }))
const SupportHome = lazy(async () => ({ default: (await import('../surfaces/webview/pages/SupportHome.tsx')).SupportHome }))
const SupportSearch = lazy(async () => ({ default: (await import('../surfaces/webview/pages/SupportSearch.tsx')).SupportSearch }))
const SupportChat = lazy(async () => ({ default: (await import('../surfaces/webview/pages/SupportChat.tsx')).SupportChat }))

export function AppRoutes() {
  return (
    <Routes>
      {/*
        webview routes — deliberately not at "/" so an agent poking at the
        console can't land on the player surface by accident. The SDK's
        webviewBaseUrl points at this prefix.

        Real routes rather than screen state, so Android's hardware back button
        does the obvious thing at every step and each screen can be mounted in
        isolation by a test. WebviewShell is the layout route: it owns the
        session for all four screens.
      */}
      <Route
        path="/embed/support"
        element={
          // The fallback is blank on purpose: the chunk is local and resolves in
          // a frame or two, and a spinner that flashes for 30ms over a paused
          // game is worse than nothing.
          <Suspense fallback={null}>
            <WebviewShell />
          </Suspense>
        }
      >
        <Route index element={<SupportHome />} />
        <Route path="search" element={<SupportSearch />} />
        {/* Deep link: home, with the article sheet already open over it. */}
        <Route path="articles/:id" element={<SupportHome />} />
        <Route path="chat" element={<SupportChat />} />
        {/* No dead ends, including mistyped ones. */}
        <Route path="*" element={<Navigate to="/embed/support" replace />} />
      </Route>

      {/* agent-console routes */}
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
        <Route path="articles" element={<KnowledgeBase />} />
      </Route>
    </Routes>
  )
}
```

Note: `Inbox` renders for both `/inbox` and `/inbox/:conversationId` (Task 7 reads `conversationId` via `useParams` internally to decide what's selected).

- [ ] **Step 3: Verify it builds (pages don't exist yet, so stub them minimally to unblock this task)**

Since `Inbox.tsx` and `KnowledgeBase.tsx` don't exist until Tasks 7 and 11, this task cannot fully typecheck in isolation. Create temporary placeholder stubs so Task 4 is independently testable, to be overwritten by Tasks 7 and 11:

Create `frontend/src/surfaces/agent-console/pages/Inbox/Inbox.tsx`:
```typescript
export function Inbox() {
  return <div className="p-4 text-sm text-muted">Inbox placeholder</div>
}
```

Create `frontend/src/surfaces/agent-console/pages/KnowledgeBase/KnowledgeBase.tsx`:
```typescript
export function KnowledgeBase() {
  return <div className="p-4 text-sm text-muted">Knowledge Base placeholder</div>
}
```

Run: `cd frontend && pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Manual verification**

Run: `pnpm dev` (from repo root, per README) and in a browser:
1. Go to `/login`, pick a dev agent.
2. Confirm redirect to `/inbox` renders the shell (left nav with Inbox/Knowledge Base, topbar with your name and Log out) around the "Inbox placeholder" text.
3. Click "Knowledge Base" nav item, confirm URL becomes `/articles` and shows "Knowledge Base placeholder".
4. Click "Log out", confirm redirect to `/login` and that reloading `/inbox` directly also redirects to `/login`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/components/AgentConsoleShell.tsx frontend/src/routes/AppRoutes.tsx frontend/src/surfaces/agent-console/pages/Inbox/Inbox.tsx frontend/src/surfaces/agent-console/pages/KnowledgeBase/KnowledgeBase.tsx
git commit -m "feat(agent-console): add AgentConsoleShell layout and merged inbox/articles routes"
```

---

### Task 5: ConversationRow + ConversationList

**Files:**
- Create: `frontend/src/surfaces/agent-console/pages/Inbox/components/ConversationRow.tsx`
- Create: `frontend/src/surfaces/agent-console/pages/Inbox/components/ConversationList.tsx`
- Create: `frontend/src/surfaces/agent-console/pages/Inbox/components/ConversationList.test.tsx`

**Interfaces:**
- Consumes: `fetchInbox`, `claimConversation` from `../../../api/agentApi.ts`; `AgentConversationSummary`, `ConversationStatusValue` from `@support/types`; `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent`, `Badge`, `ScrollArea`, `Button` from `../../../components/ui/*`.
- Produces: `ConversationList({ token, selectedId, onSelect }: { token: string; selectedId: string | null; onSelect: (id: string) => void })` — consumed by Task 7's `Inbox.tsx`.
- Produces: `ConversationRow({ conversation, selected, onSelect, onClaim, claiming }: { conversation: AgentConversationSummary; selected: boolean; onSelect: () => void; onClaim?: () => void; claiming?: boolean })`.
- Produces: `STATUS_BADGE_VARIANT: Record<ConversationStatusValue, 'default' | 'secondary' | 'success' | 'warning' | 'info' | 'destructive'>` (exported from `ConversationRow.tsx`) so the mapping is visible/testable independent of rendering.

- [ ] **Step 1: Write the failing test for the claim flow**

Create `frontend/src/surfaces/agent-console/pages/Inbox/components/ConversationList.test.tsx`:

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConversationList } from './ConversationList.tsx'
import * as agentApi from '../../../api/agentApi.ts'

vi.mock('../../../../../features/chat/api/socket.ts', () => ({
  createSocket: () => ({ on: vi.fn(), close: vi.fn() }),
}))

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

const UNASSIGNED_CONVERSATION = {
  id: 'conv-1',
  player: { external_player_id: 'player-42' },
  status: 'new' as const,
  last_message_preview: 'Help, my purchase failed',
  last_message_at: '2026-08-10T12:00:00Z',
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('ConversationList claim flow', () => {
  it('claims an unassigned conversation and refreshes the list', async () => {
    vi.spyOn(agentApi, 'fetchInbox').mockImplementation((_token, status) =>
      Promise.resolve({ conversations: status === 'unassigned' ? [UNASSIGNED_CONVERSATION] : [] }),
    )
    const claimSpy = vi.spyOn(agentApi, 'claimConversation').mockResolvedValue({ claimed: true })

    renderWithClient(<ConversationList token="tok" selectedId={null} onSelect={() => {}} />)

    const claimButton = await screen.findByRole('button', { name: /claim/i })
    await userEvent.click(claimButton)

    await waitFor(() => expect(claimSpy).toHaveBeenCalledWith('tok', 'conv-1'))
  })

  it('shows a notice when the conversation was already claimed by someone else', async () => {
    vi.spyOn(agentApi, 'fetchInbox').mockImplementation((_token, status) =>
      Promise.resolve({ conversations: status === 'unassigned' ? [UNASSIGNED_CONVERSATION] : [] }),
    )
    vi.spyOn(agentApi, 'claimConversation').mockResolvedValue({ claimed: false })

    renderWithClient(<ConversationList token="tok" selectedId={null} onSelect={() => {}} />)

    const claimButton = await screen.findByRole('button', { name: /claim/i })
    await userEvent.click(claimButton)

    expect(await screen.findByText(/already claimed/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/pages/Inbox/components/ConversationList.test.tsx`
Expected: FAIL — `ConversationList.tsx` doesn't exist yet.

- [ ] **Step 3: Create `ConversationRow.tsx`**

```typescript
import type { AgentConversationSummary, ConversationStatusValue } from '@support/types'
import { Badge } from '../../../components/ui/badge.tsx'
import { Button } from '../../../components/ui/button.tsx'
import { cn } from '../../../lib/cn.ts'

export const STATUS_BADGE_VARIANT: Record<
  ConversationStatusValue,
  'default' | 'secondary' | 'success' | 'warning' | 'info' | 'destructive'
> = {
  new: 'info',
  bot_active: 'secondary',
  open: 'default',
  awaiting_player: 'warning',
  escalated: 'destructive',
  resolved: 'success',
  closed: 'secondary',
}

function relativeTime(iso: string | null): string {
  if (!iso) return ''
  const diffMs = Date.now() - new Date(iso).getTime()
  const diffMin = Math.round(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  return `${Math.round(diffHr / 24)}d ago`
}

export function ConversationRow({
  conversation,
  selected,
  onSelect,
  onClaim,
  claiming,
}: {
  conversation: AgentConversationSummary
  selected: boolean
  onSelect: () => void
  onClaim?: () => void
  claiming?: boolean
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSelect()
      }}
      className={cn(
        'group flex cursor-pointer flex-col gap-1 border-b border-slate-100 px-4 py-3 text-left transition-colors',
        selected ? 'bg-accent-soft' : 'hover:bg-accent-soft/50',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{conversation.player.external_player_id}</span>
        <Badge variant={STATUS_BADGE_VARIANT[conversation.status]}>{conversation.status}</Badge>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs text-muted">{conversation.last_message_preview ?? '(no messages)'}</span>
        <span className="shrink-0 text-xs text-muted">{relativeTime(conversation.last_message_at)}</span>
      </div>
      {onClaim && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-1 hidden self-start group-hover:inline-flex"
          disabled={claiming}
          onClick={(e) => {
            e.stopPropagation()
            onClaim()
          }}
        >
          Claim
        </Button>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Create `ConversationList.tsx`**

```typescript
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { claimConversation, fetchInbox } from '../../../api/agentApi.ts'
import { createSocket } from '../../../../../features/chat/api/socket.ts'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/tabs.tsx'
import { ScrollArea } from '../../../components/ui/scroll-area.tsx'
import { ConversationRow } from './ConversationRow.tsx'

export function ConversationList({
  token,
  selectedId,
  onSelect,
}: {
  token: string
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const queryClient = useQueryClient()
  const [claimNotice, setClaimNotice] = useState<string | null>(null)

  const unassigned = useQuery({
    queryKey: ['inbox', 'unassigned'],
    queryFn: () => fetchInbox(token, 'unassigned'),
  })
  const mine = useQuery({
    queryKey: ['inbox', 'mine'],
    queryFn: () => fetchInbox(token, 'mine'),
  })

  const claim = useMutation({
    mutationFn: (conversationId: string) => claimConversation(token, conversationId),
    onSuccess: (result) => {
      setClaimNotice(result.claimed ? null : 'Already claimed by someone else.')
      void queryClient.invalidateQueries({ queryKey: ['inbox'] })
    },
  })

  useEffect(() => {
    const socket = createSocket(token, 'agent')
    socket.on('conversation:changed', () => {
      void queryClient.invalidateQueries({ queryKey: ['inbox'] })
    })
    return () => {
      socket.close()
    }
  }, [token, queryClient])

  return (
    <Tabs defaultValue="unassigned" className="flex h-full min-h-0 flex-col gap-0">
      <div className="p-2">
        <TabsList className="w-full">
          <TabsTrigger value="unassigned">Unassigned</TabsTrigger>
          <TabsTrigger value="mine">Mine</TabsTrigger>
        </TabsList>
      </div>
      {claimNotice && <p className="px-4 pb-2 text-xs text-amber-700">{claimNotice}</p>}

      <TabsContent value="unassigned" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          {unassigned.data?.conversations.map((c) => (
            <ConversationRow
              key={c.id}
              conversation={c}
              selected={c.id === selectedId}
              onSelect={() => onSelect(c.id)}
              onClaim={() => claim.mutate(c.id)}
              claiming={claim.isPending}
            />
          ))}
        </ScrollArea>
      </TabsContent>

      <TabsContent value="mine" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          {mine.data?.conversations.map((c) => (
            <ConversationRow key={c.id} conversation={c} selected={c.id === selectedId} onSelect={() => onSelect(c.id)} />
          ))}
        </ScrollArea>
      </TabsContent>
    </Tabs>
  )
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/pages/Inbox/components/ConversationList.test.tsx`
Expected: PASS (both tests). Note: Radix `Tabs` renders both `TabsContent` panels' children into the DOM by default with the inactive one hidden via CSS, so `findByRole('button', { name: /claim/i })` resolves against the "Unassigned" tab content which is active by default — no manual tab-switch needed in the test.

- [ ] **Step 6: Typecheck**

Run: `cd frontend && pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Inbox/components/ConversationRow.tsx frontend/src/surfaces/agent-console/pages/Inbox/components/ConversationList.tsx frontend/src/surfaces/agent-console/pages/Inbox/components/ConversationList.test.tsx
git commit -m "feat(agent-console): add ConversationList/ConversationRow with claim flow test"
```

---

### Task 6: ThreadPanel

**Files:**
- Create: `frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.tsx`

**Interfaces:**
- Consumes: `fetchConversationMessages`, `markAgentMessagesRead`, `sendAgentMessage` from `../../../api/agentApi.ts`; `createSocket` from `../../../../../features/chat/api/socket.ts`; `ChatThread`, `Composer` from `../../../../../features/chat/components/*`; `ChatMessage` type from same; `AgentMessageView`, `ConversationStatusValue` from `@support/types`; `Badge` from `../../../components/ui/badge.tsx`; `STATUS_BADGE_VARIANT` from `./ConversationRow.tsx`.
- Produces: `ThreadPanel({ token, conversationId, playerExternalId, status, onBack }: { token: string; conversationId: string | null; playerExternalId?: string; status?: ConversationStatusValue; onBack?: () => void })` — consumed by Task 7's `Inbox.tsx`. Renders an empty state when `conversationId` is `null`.

- [ ] **Step 1: Create `ThreadPanel.tsx`**

```typescript
import { useEffect } from 'react'
import type { AgentMessageView, ConversationStatusValue } from '@support/types'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, MessageSquare } from 'lucide-react'
import { fetchConversationMessages, markAgentMessagesRead, sendAgentMessage } from '../../../api/agentApi.ts'
import { createSocket } from '../../../../../features/chat/api/socket.ts'
import { ChatThread } from '../../../../../features/chat/components/ChatThread.tsx'
import { Composer } from '../../../../../features/chat/components/Composer.tsx'
import type { ChatMessage } from '../../../../../features/chat/components/types.ts'
import { Badge } from '../../../components/ui/badge.tsx'
import { Button } from '../../../components/ui/button.tsx'
import { STATUS_BADGE_VARIANT } from './ConversationRow.tsx'

function toChatMessage(m: AgentMessageView): ChatMessage {
  return {
    id: m.id,
    authorType: m.author_type,
    body: m.body,
    createdAt: m.created_at,
    deliveryState: m.delivery_state,
    visibility: m.visibility,
  }
}

export function ThreadPanel({
  token,
  conversationId,
  playerExternalId,
  status,
  onBack,
}: {
  token: string
  conversationId: string | null
  playerExternalId?: string
  status?: ConversationStatusValue
  onBack?: () => void
}) {
  const queryClient = useQueryClient()

  const messagesQuery = useQuery({
    queryKey: ['conversation', conversationId, 'messages'],
    queryFn: () => fetchConversationMessages(token, conversationId!),
    enabled: conversationId !== null,
  })

  const send = useMutation({
    mutationFn: ({ body, visibility }: { body: string; visibility?: 'public' | 'internal' }) =>
      sendAgentMessage(token, conversationId!, body, visibility),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'messages'] })
    },
  })

  useEffect(() => {
    if (!conversationId) return
    const socket = createSocket(token, 'agent')
    socket.emit('join_conversation', { conversation_id: conversationId })
    socket.on('message:new', () => {
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'messages'] })
    })
    return () => {
      socket.emit('leave_conversation', { conversation_id: conversationId })
      socket.close()
    }
  }, [token, conversationId, queryClient])

  useEffect(() => {
    const messages = messagesQuery.data?.messages
    if (!conversationId || !messages || messages.length === 0) return
    const lastSeq = Math.max(...messages.map((m) => m.seq))
    void markAgentMessagesRead(token, conversationId, lastSeq)
  }, [token, conversationId, messagesQuery.data])

  if (!conversationId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
        <MessageSquare className="size-8" />
        <p className="text-sm">Select a conversation</p>
      </div>
    )
  }

  const chatMessages: ChatMessage[] = messagesQuery.data?.messages.map(toChatMessage) ?? []

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 px-4 py-3">
        {onBack && (
          <Button type="button" variant="ghost" size="icon" onClick={onBack} aria-label="Back to list">
            <ArrowLeft className="size-4" />
          </Button>
        )}
        <span className="text-sm font-medium">{playerExternalId}</span>
        {status && <Badge variant={STATUS_BADGE_VARIANT[status]}>{status}</Badge>}
      </div>
      <div className="min-h-0 flex-1">
        <ChatThread messages={chatMessages} currentAuthorType="agent" />
      </div>
      <Composer onSend={(body, visibility) => send.mutate({ body, visibility })} disabled={send.isPending} allowVisibilityToggle />
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.tsx
git commit -m "feat(agent-console): add ThreadPanel with chat/socket logic moved from AgentConversation"
```

---

### Task 7: Inbox.tsx page (merged split view)

**Files:**
- Create: `frontend/src/surfaces/agent-console/pages/Inbox/Inbox.tsx` (overwrites Task 4's placeholder)

**Interfaces:**
- Consumes: `ConversationList` (Task 5), `ThreadPanel` (Task 6), `loadAgentSession` from `../../lib/agentSession.ts`, `fetchInbox` from `../../api/agentApi.ts` (to look up the selected conversation's player id/status for `ThreadPanel`'s header).
- Produces: route element for `/inbox` and `/inbox/:conversationId`.

- [ ] **Step 1: Overwrite `Inbox.tsx`**

```typescript
import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { fetchInbox } from '../../api/agentApi.ts'
import { loadAgentSession } from '../../lib/agentSession.ts'
import { ConversationList } from './components/ConversationList.tsx'
import { ThreadPanel } from './components/ThreadPanel.tsx'

export function Inbox() {
  const { conversationId } = useParams<{ conversationId?: string }>()
  const navigate = useNavigate()
  const session = loadAgentSession()

  // Both queries are already cached by ConversationList under the same keys;
  // this lookup is just to find the selected row's player id + status for
  // ThreadPanel's header without re-fetching or duplicating that state.
  const unassigned = useQuery({
    queryKey: ['inbox', 'unassigned'],
    queryFn: () => fetchInbox(session!.token, 'unassigned'),
    enabled: session !== null,
  })
  const mine = useQuery({
    queryKey: ['inbox', 'mine'],
    queryFn: () => fetchInbox(session!.token, 'mine'),
    enabled: session !== null,
  })

  const selected = useMemo(() => {
    if (!conversationId) return undefined
    return (
      unassigned.data?.conversations.find((c) => c.id === conversationId) ??
      mine.data?.conversations.find((c) => c.id === conversationId)
    )
  }, [conversationId, unassigned.data, mine.data])

  if (!session) return null

  const selectedId = conversationId ?? null

  return (
    <div className="flex h-full min-h-0">
      {/* Below the md breakpoint, a selected conversation replaces the list
          full-screen (back affordance via ThreadPanel's onBack) since
          side-by-side doesn't fit narrow viewports. */}
      <div className={selectedId ? 'hidden w-80 shrink-0 border-r border-slate-200 md:block' : 'w-full shrink-0 border-r border-slate-200 md:w-80'}>
        <ConversationList token={session.token} selectedId={selectedId} onSelect={(id) => navigate(`/inbox/${id}`)} />
      </div>
      <div className={selectedId ? 'min-w-0 flex-1' : 'hidden flex-1 md:block'}>
        <ThreadPanel
          token={session.token}
          conversationId={selectedId}
          playerExternalId={selected?.player.external_player_id}
          status={selected?.status}
          onBack={() => navigate('/inbox')}
        />
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Manual verification**

Run `pnpm dev`, log in, on `/inbox`:
1. Confirm the list shows in the left rail with Unassigned/Mine tabs.
2. Click a conversation row, confirm URL becomes `/inbox/<id>` and the thread renders on the right with header (player id + status badge), messages, and composer.
3. Narrow the browser window below `md` (768px): confirm the list disappears and the thread takes the full width with a working back button that returns to the list.
4. Confirm claiming an unassigned conversation still works (button appears on row hover, moves it to "Mine" after claim).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/Inbox/Inbox.tsx
git commit -m "feat(agent-console): implement merged Inbox split view"
```

---

### Task 8: CategorySidebar

**Files:**
- Create: `frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/CategorySidebar.tsx`

**Interfaces:**
- Consumes: `fetchIntents`, `createIntent`, `createSubintent` from `../../../api/agentApi.ts`; `IntentsResponse` from `@support/types`; `Input`, `Button` from `../../../components/ui/*`.
- Produces: `CategorySidebar({ token }: { token: string })` — consumed by Task 11's `KnowledgeBase.tsx`. Same data/behavior as today's intents tree in `AdminArticles.tsx`.

- [ ] **Step 1: Create `CategorySidebar.tsx`**

```typescript
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createIntent, createSubintent, fetchIntents } from '../../../api/agentApi.ts'
import { Button } from '../../../components/ui/button.tsx'
import { Input } from '../../../components/ui/input.tsx'
import { ScrollArea } from '../../../components/ui/scroll-area.tsx'

export function CategorySidebar({ token }: { token: string }) {
  const queryClient = useQueryClient()
  const [newIntentName, setNewIntentName] = useState('')

  const intents = useQuery({ queryKey: ['admin-intents'], queryFn: () => fetchIntents(token) })

  const addIntent = useMutation({
    mutationFn: () => createIntent(token, newIntentName),
    onSuccess: () => {
      setNewIntentName('')
      void queryClient.invalidateQueries({ queryKey: ['admin-intents'] })
    },
  })

  return (
    <div className="flex h-full min-h-0 flex-col border-r border-slate-200">
      <div className="p-3 text-sm font-semibold">Categories</div>
      <ScrollArea className="min-h-0 flex-1 px-3">
        <ul className="flex flex-col gap-2">
          {intents.data?.intents.map((intent) => (
            <li key={intent.id}>
              <p className="text-sm font-medium">{intent.name}</p>
              {intent.subintents.length > 0 && (
                <ul className="mt-1 flex flex-col gap-0.5 pl-3">
                  {intent.subintents.map((s) => (
                    <li key={s.id} className="text-xs text-muted">
                      {s.name}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </ScrollArea>
      <div className="flex flex-col gap-2 border-t border-slate-200 p-3">
        <Input
          placeholder="New category name"
          value={newIntentName}
          onChange={(e) => setNewIntentName(e.target.value)}
        />
        <Button type="button" size="sm" onClick={() => addIntent.mutate()} disabled={addIntent.isPending || !newIntentName}>
          Add Category
        </Button>
      </div>
    </div>
  )
}
```

Note: `createSubintent` import is kept available for a future "add subintent under a category" control, matching today's `AdminArticles.tsx` which defines `addSubintent` but the plan's scope (per spec, "unchanged data/behavior") only requires the add-category input to be present — remove the unused `createSubintent` import if `pnpm typecheck`/lint flags it as unused.

- [ ] **Step 2: Fix the unused-import lint issue**

Run: `cd frontend && pnpm typecheck && pnpm lint` (or whatever the repo's lint script is — check `package.json` `scripts`).
If `createSubintent` is flagged unused, remove that import from Step 1's file (it is not referenced by any UI control in this task, matching the spec's minimal "add-category input" scope).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/CategorySidebar.tsx
git commit -m "feat(agent-console): add CategorySidebar for Knowledge Base"
```

---

### Task 9: ArticleTable

**Files:**
- Create: `frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleTable.tsx`

**Interfaces:**
- Consumes: `fetchArticles` from `../../../api/agentApi.ts`; `AgentArticleSummary` from `@support/types`; `Table`/`TableHeader`/`TableBody`/`TableRow`/`TableHead`/`TableCell`, `Badge`, `Button` from `../../../components/ui/*`.
- Produces: `ArticleTable({ token, selectedId, onSelect, onNew }: { token: string; selectedId: string | null; onSelect: (id: string) => void; onNew: () => void })` — consumed by Task 11's `KnowledgeBase.tsx`.

- [ ] **Step 1: Create `ArticleTable.tsx`**

```typescript
import { useQuery } from '@tanstack/react-query'
import type { ArticleStateValue } from '@support/types'
import { fetchArticles } from '../../../api/agentApi.ts'
import { Badge } from '../../../components/ui/badge.tsx'
import { Button } from '../../../components/ui/button.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../../components/ui/table.tsx'
import { cn } from '../../../lib/cn.ts'

const STATE_BADGE_VARIANT: Record<ArticleStateValue, 'secondary' | 'success' | 'outline'> = {
  draft: 'secondary',
  published: 'success',
  archived: 'outline',
}

export function ArticleTable({
  token,
  selectedId,
  onSelect,
  onNew,
}: {
  token: string
  selectedId: string | null
  onSelect: (id: string) => void
  onNew: () => void
}) {
  const articles = useQuery({ queryKey: ['admin-articles'], queryFn: () => fetchArticles(token) })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 p-3">
        <span className="text-sm font-semibold">Articles</span>
        <Button type="button" size="sm" onClick={onNew}>
          + New
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {articles.data?.articles.map((a) => (
              <TableRow
                key={a.id}
                onClick={() => onSelect(a.id)}
                className={cn('cursor-pointer', selectedId === a.id && 'bg-accent-soft')}
              >
                <TableCell className="font-medium">{a.title}</TableCell>
                <TableCell>
                  <Badge variant={STATE_BADGE_VARIANT[a.state]}>{a.state}</Badge>
                </TableCell>
                <TableCell className="text-muted">
                  {new Date(a.published_at ?? a.created_at).toLocaleDateString()}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleTable.tsx
git commit -m "feat(agent-console): add ArticleTable for Knowledge Base"
```

---

### Task 10: ArticleEditorSheet with MDXEditor

**Files:**
- Create: `frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleEditorSheet.tsx`
- Create: `frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleEditorSheet.test.tsx`

**Interfaces:**
- Consumes: `fetchArticle`, `createArticle`, `updateArticle`, `publishArticle`, `archiveArticle`, `fetchIntents` from `../../../api/agentApi.ts`; `canEditFields`, `canPublish`, `parseKeywordsInput` from `../articleForm.ts` (Task 11 moves this file first — see note below); `Sheet`/`SheetContent`/`SheetHeader`/`SheetTitle`/`SheetFooter`, `Input`, `Select`/`SelectTrigger`/`SelectValue`/`SelectContent`/`SelectItem`, `Button` from `../../../components/ui/*`; MDXEditor's `MDXEditor`, `headingsPlugin`, `listsPlugin`, `linkPlugin`, `quotePlugin`, `codeBlockPlugin`, `toolbarPlugin`, `BoldItalicUnderlineToggles`, `ListsToggle`, `BlockTypeSelect`, `CreateLink`, `InsertCodeBlock` from `@mdxeditor/editor`.
- Produces: `ArticleEditorSheet({ token, articleId, open, onOpenChange, onCreated }: { token: string; articleId: string | null; open: boolean; onOpenChange: (open: boolean) => void; onCreated: (id: string) => void })` — consumed by Task 11's `KnowledgeBase.tsx`. `articleId === null` means "new article" mode.

This task assumes Task 11 has already moved `articleForm.ts`/`articleForm.test.ts` into `pages/KnowledgeBase/`. If executing tasks out of order, do Task 11's Step 1 (the file move) first.

- [ ] **Step 1: Write the failing MDXEditor round-trip test**

Create `frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleEditorSheet.test.tsx`:

```typescript
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ArticleEditorSheet } from './ArticleEditorSheet.tsx'
import * as agentApi from '../../../api/agentApi.ts'

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

const EXISTING_ARTICLE = {
  id: 'art-1',
  title: 'Refunds',
  body: '# Refund policy\n\nWe refund within **30 days**.',
  keywords: ['refund'],
  state: 'draft' as const,
  intent_id: null,
  created_by: 'agent-1',
  published_by: null,
  published_at: null,
  created_at: '2026-08-01T00:00:00Z',
}

describe('ArticleEditorSheet MDXEditor round-trip', () => {
  it('writes markdown in and saves the same markdown back out', async () => {
    vi.spyOn(agentApi, 'fetchArticle').mockResolvedValue(EXISTING_ARTICLE)
    vi.spyOn(agentApi, 'fetchIntents').mockResolvedValue({ intents: [] })
    const updateSpy = vi.spyOn(agentApi, 'updateArticle').mockResolvedValue(EXISTING_ARTICLE)

    renderWithClient(
      <ArticleEditorSheet token="tok" articleId="art-1" open onOpenChange={() => {}} onCreated={() => {}} />,
    )

    await screen.findByDisplayValue('Refunds')

    const saveButton = screen.getByRole('button', { name: /save/i })
    await userEvent.click(saveButton)

    await waitFor(() =>
      expect(updateSpy).toHaveBeenCalledWith(
        'tok',
        'art-1',
        expect.objectContaining({ body: expect.stringContaining('Refund policy') }),
      ),
    )
    // The same markdown emphasis marker round-trips unchanged.
    const [, , patch] = updateSpy.mock.calls[0]!
    expect(patch.body).toContain('**30 days**')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleEditorSheet.test.tsx`
Expected: FAIL — `ArticleEditorSheet.tsx` doesn't exist yet.

- [ ] **Step 3: Create `ArticleEditorSheet.tsx`**

```typescript
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AgentArticleDetail } from '@support/types'
import {
  MDXEditor,
  headingsPlugin,
  listsPlugin,
  linkPlugin,
  quotePlugin,
  codeBlockPlugin,
  toolbarPlugin,
  BoldItalicUnderlineToggles,
  ListsToggle,
  BlockTypeSelect,
  CreateLink,
  InsertCodeBlock,
  UndoRedo,
} from '@mdxeditor/editor'
import '@mdxeditor/editor/style.css'
import {
  archiveArticle,
  createArticle,
  fetchArticle,
  fetchIntents,
  publishArticle,
  updateArticle,
} from '../../../api/agentApi.ts'
import { canEditFields, canPublish, parseKeywordsInput } from '../articleForm.ts'
import { Button } from '../../../components/ui/button.tsx'
import { Input } from '../../../components/ui/input.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/select.tsx'
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '../../../components/ui/sheet.tsx'

type Draft = { title: string; body: string; keywordsInput: string; intentId: string }

const EMPTY_DRAFT: Draft = { title: '', body: '', keywordsInput: '', intentId: '' }

export function ArticleEditorSheet({
  token,
  articleId,
  open,
  onOpenChange,
  onCreated,
}: {
  token: string
  articleId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (id: string) => void
}) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)

  const intents = useQuery({ queryKey: ['admin-intents'], queryFn: () => fetchIntents(token) })
  const selected = useQuery({
    queryKey: ['admin-article', articleId],
    queryFn: () => fetchArticle(token, articleId!),
    enabled: articleId !== null,
  })

  useEffect(() => {
    if (articleId === null) {
      setDraft(EMPTY_DRAFT)
    } else if (selected.data) {
      setDraft({
        title: selected.data.title,
        body: selected.data.body,
        keywordsInput: selected.data.keywords.join(', '),
        intentId: selected.data.intent_id ?? '',
      })
    }
  }, [articleId, selected.data])

  const invalidateArticles = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin-articles'] })
    void queryClient.invalidateQueries({ queryKey: ['admin-article', articleId] })
  }

  const createDraft = useMutation({
    mutationFn: () =>
      createArticle(token, {
        title: draft.title,
        body: draft.body,
        keywords: parseKeywordsInput(draft.keywordsInput),
        intent_id: draft.intentId || undefined,
      }),
    onSuccess: (created: AgentArticleDetail) => {
      invalidateArticles()
      onCreated(created.id)
    },
  })

  const saveDraft = useMutation({
    mutationFn: () =>
      updateArticle(token, articleId!, {
        title: draft.title,
        body: draft.body,
        keywords: parseKeywordsInput(draft.keywordsInput),
        intent_id: draft.intentId || null,
      }),
    onSuccess: invalidateArticles,
  })

  const publish = useMutation({ mutationFn: () => publishArticle(token, articleId!), onSuccess: invalidateArticles })
  const archive = useMutation({ mutationFn: () => archiveArticle(token, articleId!), onSuccess: invalidateArticles })

  const state = selected.data?.state ?? 'draft'
  const editable = articleId === null || canEditFields(state)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex flex-col gap-0 p-0 sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{articleId ? 'Edit Article' : 'New Article'}</SheetTitle>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted">Title</label>
            <Input
              placeholder="Article title"
              value={draft.title}
              disabled={!editable}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted">Keywords</label>
            <Input
              placeholder="refund, billing, cancel subscription"
              value={draft.keywordsInput}
              disabled={!editable}
              onChange={(e) => setDraft({ ...draft, keywordsInput: e.target.value })}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted">Category</label>
            <Select
              value={draft.intentId || undefined}
              disabled={!editable}
              onValueChange={(value) => setDraft({ ...draft, intentId: value })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Uncategorized" />
              </SelectTrigger>
              <SelectContent>
                {intents.data?.intents.map((intent) => (
                  <SelectItem key={intent.id} value={intent.id}>
                    {intent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-1.5">
            <label className="text-xs font-medium text-muted">Body</label>
            <div className="min-h-64 rounded-md border border-slate-200">
              <MDXEditor
                markdown={draft.body}
                readOnly={!editable}
                onChange={(markdown) => setDraft((d) => ({ ...d, body: markdown }))}
                contentEditableClassName="prose prose-sm max-w-none px-3 py-2 min-h-56"
                plugins={[
                  headingsPlugin(),
                  listsPlugin(),
                  linkPlugin(),
                  quotePlugin(),
                  codeBlockPlugin({ defaultCodeBlockLanguage: 'txt' }),
                  toolbarPlugin({
                    toolbarContents: () => (
                      <>
                        <UndoRedo />
                        <BoldItalicUnderlineToggles />
                        <BlockTypeSelect />
                        <ListsToggle />
                        <CreateLink />
                        <InsertCodeBlock />
                      </>
                    ),
                  }),
                ]}
              />
            </div>
          </div>
        </div>

        <SheetFooter className="flex-row justify-end gap-2 border-t border-slate-200">
          {articleId === null ? (
            <Button
              type="button"
              onClick={() => createDraft.mutate()}
              disabled={createDraft.isPending || !draft.title || !draft.body}
            >
              Create Draft
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => archive.mutate()} disabled={archive.isPending}>
                Archive
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => saveDraft.mutate()}
                disabled={!editable || saveDraft.isPending}
              >
                Save
              </Button>
              <Button
                type="button"
                onClick={() => publish.mutate()}
                disabled={!canPublish(state, draft.title, draft.body) || publish.isPending}
              >
                Publish
              </Button>
            </>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleEditorSheet.test.tsx`
Expected: PASS. If MDXEditor's initial render is async (it lazy-mounts its ProseMirror instance), and `findByDisplayValue('Refunds')` doesn't resolve, add `await waitFor(() => expect(screen.getByDisplayValue('Refunds')).toBeInTheDocument())` with a longer default timeout, or check MDXEditor's docs for a `ref.current.getMarkdown()` based assertion instead of relying on DOM text — adjust the test to whichever is reliable, keeping the assertion "markdown in equals markdown out" intact.

- [ ] **Step 5: Typecheck**

Run: `cd frontend && pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleEditorSheet.tsx frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleEditorSheet.test.tsx
git commit -m "feat(agent-console): add ArticleEditorSheet with MDXEditor and round-trip test"
```

---

### Task 11: KnowledgeBase.tsx page + move articleForm

**Files:**
- Move: `frontend/src/surfaces/agent-console/pages/articleForm.ts` → `frontend/src/surfaces/agent-console/pages/KnowledgeBase/articleForm.ts`
- Move: `frontend/src/surfaces/agent-console/pages/articleForm.test.ts` → `frontend/src/surfaces/agent-console/pages/KnowledgeBase/articleForm.test.ts`
- Create: `frontend/src/surfaces/agent-console/pages/KnowledgeBase/KnowledgeBase.tsx` (overwrites Task 4's placeholder)

**Interfaces:**
- Consumes: `CategorySidebar` (Task 8), `ArticleTable` (Task 9), `ArticleEditorSheet` (Task 10), `loadAgentSession` from `../../lib/agentSession.ts`.
- Produces: route element for `/articles`.

Note: if Task 10 was executed before this task per the plan's stated order, its import path `'../articleForm.ts'` already assumes the moved location — do the move (Step 1 below) first if working strictly in order, or note that Task 10 already wrote code assuming the file lives at `pages/KnowledgeBase/articleForm.ts`.

- [ ] **Step 1: Move `articleForm.ts` and its test**

```bash
mkdir -p frontend/src/surfaces/agent-console/pages/KnowledgeBase
git mv frontend/src/surfaces/agent-console/pages/articleForm.ts frontend/src/surfaces/agent-console/pages/KnowledgeBase/articleForm.ts
git mv frontend/src/surfaces/agent-console/pages/articleForm.test.ts frontend/src/surfaces/agent-console/pages/KnowledgeBase/articleForm.test.ts
```

Contents are unchanged — do not edit the moved files.

- [ ] **Step 2: Run the moved test to confirm it still passes**

Run: `cd frontend && pnpm vitest run src/surfaces/agent-console/pages/KnowledgeBase/articleForm.test.ts`
Expected: PASS (3 describe blocks, same as before the move).

- [ ] **Step 3: Overwrite `KnowledgeBase.tsx`**

```typescript
import { useState } from 'react'
import { loadAgentSession } from '../../lib/agentSession.ts'
import { CategorySidebar } from './components/CategorySidebar.tsx'
import { ArticleTable } from './components/ArticleTable.tsx'
import { ArticleEditorSheet } from './components/ArticleEditorSheet.tsx'

export function KnowledgeBase() {
  const session = loadAgentSession()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)

  if (!session) return null

  return (
    <div className="flex h-full min-h-0">
      <div className="w-56 shrink-0">
        <CategorySidebar token={session.token} />
      </div>
      <div className="min-w-0 flex-1">
        <ArticleTable
          token={session.token}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id)
            setSheetOpen(true)
          }}
          onNew={() => {
            setSelectedId(null)
            setSheetOpen(true)
          }}
        />
      </div>
      <ArticleEditorSheet
        token={session.token}
        articleId={selectedId}
        open={sheetOpen}
        onOpenChange={(open) => {
          setSheetOpen(open)
          if (!open) setSelectedId(null)
        }}
        onCreated={(id) => setSelectedId(id)}
      />
    </div>
  )
}
```

- [ ] **Step 4: Typecheck**

Run: `cd frontend && pnpm typecheck`
Expected: no errors.

- [ ] **Step 5: Manual verification**

Run `pnpm dev`, navigate to `/articles`:
1. Confirm the category tree renders in the left sidebar, and "Add Category" works.
2. Confirm the article table lists title/state/updated date.
3. Click "+ New", confirm the Sheet slides in from the right with empty fields and the MDXEditor toolbar.
4. Type a title and some markdown body (headings, bold, a list), click "Create Draft", confirm the sheet stays open on the new article (now editable) and the table refreshes to include it.
5. Click "Save", "Publish", confirm state badge updates in the table. Confirm fields become read-only after publish (only Archive enabled).
6. Close the sheet, confirm selection clears.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/KnowledgeBase/KnowledgeBase.tsx frontend/src/surfaces/agent-console/pages/KnowledgeBase/articleForm.ts frontend/src/surfaces/agent-console/pages/KnowledgeBase/articleForm.test.ts
git commit -m "feat(agent-console): implement Knowledge Base page, move articleForm module"
```

---

### Task 12: Delete superseded files

**Files:**
- Delete: `frontend/src/surfaces/agent-console/pages/AgentInbox.tsx`
- Delete: `frontend/src/surfaces/agent-console/pages/AgentConversation.tsx`
- Delete: `frontend/src/surfaces/agent-console/pages/AdminArticles.tsx`

**Interfaces:** None — this task only removes now-dead code. `AppRoutes.tsx` (Task 4) already stopped importing these files.

- [ ] **Step 1: Confirm nothing else references the old files**

Run:
```bash
grep -rn "AgentInbox\|AgentConversation\|AdminArticles" frontend/src --include='*.ts' --include='*.tsx'
```
Expected: no matches outside the three files themselves (Task 4's `AppRoutes.tsx` rewrite already removed their imports).

- [ ] **Step 2: Delete the files**

```bash
git rm frontend/src/surfaces/agent-console/pages/AgentInbox.tsx frontend/src/surfaces/agent-console/pages/AgentConversation.tsx frontend/src/surfaces/agent-console/pages/AdminArticles.tsx
```

- [ ] **Step 3: Full verification pass**

Run, from repo root:
```bash
pnpm typecheck
pnpm --filter <frontend-package-name> test  # or `cd frontend && pnpm test`, matching whatever `pnpm test` resolves to for this workspace
```
Expected: typecheck clean; all frontend tests pass, including `articleForm.test.ts`, `ConversationList.test.tsx`, `ArticleEditorSheet.test.tsx`, and pre-existing suites (`chatReconcile.test.ts`, `articleSearch.test.ts`) untouched by this plan.

- [ ] **Step 4: Manual smoke test of the full flow**

Run `pnpm dev` and walk through, in order: `/login` → pick agent → `/inbox` shell renders → claim a conversation → open its thread → send a message → switch to Knowledge Base via the nav → create/publish an article → log out → confirm redirect to `/login`.

- [ ] **Step 5: Commit**

```bash
git commit -m "chore(agent-console): remove pages superseded by the UI revamp"
```

---

## Self-Review Notes

- **Spec coverage:** Foundation (Task 1), shadcn primitives (Tasks 2–3), `AgentConsoleShell` + routing (Task 4), Inbox split view incl. `ConversationList`/`ConversationRow`/`ThreadPanel` and responsive behavior (Tasks 5–7), Knowledge Base incl. `CategorySidebar`/`ArticleTable`/`ArticleEditorSheet` with MDXEditor (Tasks 8–11), file deletions (Task 12), and both nice-to-have tests (claim flow, MDXEditor round-trip) are all covered. `AgentLogin.tsx` is untouched throughout, per scope.
- **Type consistency:** `AgentConversationSummary`, `ConversationStatusValue`, `AgentMessageView`, `AgentArticleDetail`, `AgentArticleSummary`, `ArticleStateValue` are used with the exact shapes captured from `@support/types` in research; `STATUS_BADGE_VARIANT` (Task 5) is imported by name into `ThreadPanel` (Task 6) and `ArticleTable` defines its own analogous `STATE_BADGE_VARIANT` for article state — no naming drift between tasks.
- **Known risk flagged inline:** MDXEditor's async mount behavior in jsdom (Task 10, Step 4) — the plan calls out the fallback approach rather than asserting a specific untested timing.
