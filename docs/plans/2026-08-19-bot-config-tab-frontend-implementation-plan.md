# Bot Config Tab — Part 2: Frontend (Console UI) & Final Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This is Part 2 of 2. Prerequisite: complete `2026-08-19-bot-config-tab-backend-implementation-plan.md` (Part 1, Tasks 1–13) first.** That plan produces the `resolveBotConfig`/`saveBotConfig`/`seedBotConfig` domain functions, the `TOOL_CATALOG`/`rulesCatalog` modules, and the `GET/POST /agent/bot-config`, `GET /agent/bot-config/history`, and `POST /agent/bot-config/rollback` endpoints this plan's UI calls. Task numbers below (14–20) are preserved from the original combined plan so cross-references to Part 1's Tasks 1–13 stay accurate; this plan does not introduce Tasks 1–13 of its own.

**Goal:** Ship the three-tab (Prompt/Rules/Tools) admin console UI, with per-tab Save and a History panel with Restore, on top of the `/agent/bot-config*` endpoints built in Part 1 — then run one holistic review confirming the combined implementation (Parts 1 + 2) satisfies the spec end to end. The Tools tab also gets a "Conversation limits" section (Task 18 Step 6) exposing the 4 numeric ceilings from Part 1's `limits_config` — added to this plan after the original spec was written, so it is verified against this plan's own tasks in Task 20 rather than against `docs/specs/2026-08-19-bot-config-tab-design.md`.

**Architecture:** Three new admin console tabs under one shell (`BotConfig` page), each with its own Save button and a History panel with Restore, calling the Part 1 endpoints via a small API client module.

**Tech Stack:** React + TanStack Query + Tailwind v4 + shadcn/ui + Radix (frontend), Vitest.

## Global Constraints

- **Tailwind v4 utilities only** for every new frontend file — no hand-written CSS, no new `.css` files (`agent-console.css` theme tokens only).
- **`enforcement` is never client-settable** — the UI only ever displays it (from `RuleEntryView`), never sends it back in a save payload; see `stripView`/`RuleEntrySchema` in Part 1's Task 2/10.
- **No hard deletes; history stays append-only.** Restore is a new audited save via `POST /agent/bot-config/rollback`, never a mutation of history.

## Execution / Validation Policy

**Per task (14–19):** the only automated check at the end of each task is running the relevant Vitest suite (`pnpm --filter @support/web test <file>`, as scoped in each task's steps). **Do not run an AI/LLM-driven code review or "does this look right" pass per task** — a green test run is sufficient to move to the next task.

**Once, at the very end (Task 20 below):** run the full test suites plus one holistic review that walks the spec (`docs/specs/2026-08-19-bot-config-tab-design.md`) section by section and confirms every Goal, data-model rule, validation rule, and Testing-section item is actually implemented — across **both** Part 1 (Tasks 1–13) and Part 2 (Tasks 14–19). This is the only point where an AI-driven "does this satisfy the requirement scope" validation happens.

---

### Task 14: Frontend — API client functions + Switch UI primitive + nav wiring

**Files:**
- Modify: `frontend/src/surfaces/agent-console/api/agentApi.ts`
- Create: `frontend/src/surfaces/agent-console/components/ui/switch.tsx`
- Modify: `frontend/src/surfaces/agent-console/components/AgentConsoleShell.tsx`
- Modify: `frontend/package.json` (add `@radix-ui/react-switch`)

**Interfaces:**
- Produces: `fetchBotConfig(token)`, `saveBotConfig(token, patch)`, `fetchBotConfigHistory(token, opts?)`, `rollbackBotConfig(token, input)`; `Switch` component.

- [ ] **Step 1: Install the Radix switch primitive**

Run: `pnpm --filter @support/web add @radix-ui/react-switch`

- [ ] **Step 2: Add the Switch UI component**, mirroring `tabs.tsx`'s style

```tsx
// frontend/src/surfaces/agent-console/components/ui/switch.tsx
import * as React from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import { cn } from '../../lib/cn.ts'

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors',
        'data-[state=checked]:bg-accent data-[state=unchecked]:bg-accent-soft',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block size-4 rounded-full bg-bg shadow-xs transition-transform',
          'data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0',
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
```

- [ ] **Step 3: Add API client functions** to `frontend/src/surfaces/agent-console/api/agentApi.ts`

```ts
import type { BotConfigView, ChangeLogHistoryResponse, RollbackBotConfigBodyValue, SaveBotConfigBodyValue } from '@support/types'

export function fetchBotConfig(token: string): Promise<BotConfigView> {
  return apiCall('/agent/bot-config', token)
}

export function saveBotConfig(token: string, patch: SaveBotConfigBodyValue): Promise<BotConfigView> {
  return apiCall('/agent/bot-config', token, { method: 'POST', body: JSON.stringify(patch) })
}

export function fetchBotConfigHistory(
  token: string,
  opts: { field?: 'prompt' | 'rules' | 'tools_config' | 'limits_config'; limit?: number; cursor?: string } = {},
): Promise<ChangeLogHistoryResponse> {
  const params = new URLSearchParams()
  if (opts.field) params.set('field', opts.field)
  if (opts.limit) params.set('limit', String(opts.limit))
  if (opts.cursor) params.set('cursor', opts.cursor)
  const query = params.toString()
  return apiCall(`/agent/bot-config/history${query ? `?${query}` : ''}`, token)
}

export function rollbackBotConfig(token: string, input: RollbackBotConfigBodyValue): Promise<BotConfigView> {
  return apiCall('/agent/bot-config/rollback', token, { method: 'POST', body: JSON.stringify(input) })
}
```

(Add these alongside the existing exports; add the new type imports to the top `import type { ... } from '@support/types'` line rather than a second import statement, matching the file's existing single-import convention.)

- [ ] **Step 4: Add the nav item**, admin-gated like Forms

```ts
// frontend/src/surfaces/agent-console/components/AgentConsoleShell.tsx
import { Inbox as InboxIcon, BookOpen, ClipboardList, LogOut, Settings, Tags } from 'lucide-react'
import { canBuildForms, clearAgentSession, isAdmin, loadAgentSession } from '../lib/agentSession.ts'

// ... NAV_ITEMS unchanged ...
const FORMS_NAV_ITEM = { to: '/forms', label: 'Forms', icon: ClipboardList }
// Admin-only in the permission matrix ("Edit bot prompt or rules" is Admin).
// Hiding the link here is UX, not the enforcement point — the API still
// requires admin on POST/rollback.
const BOT_CONFIG_NAV_ITEM = { to: '/bot-config', label: 'Bot Config', icon: Settings }

export function AgentConsoleShell() {
  // ...
  const navItems = [
    ...(canBuildForms(session) ? [...NAV_ITEMS, FORMS_NAV_ITEM] : NAV_ITEMS),
    ...(isAdmin(session) ? [BOT_CONFIG_NAV_ITEM] : []),
  ]
  // ... rest unchanged ...
}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @support/web typecheck`
Expected: PASS (no test file for this task — it's pure plumbing exercised by Task 15's component tests).

- [ ] **Step 6: Commit**

```bash
git add frontend/package.json frontend/src/surfaces/agent-console/api/agentApi.ts \
  frontend/src/surfaces/agent-console/components/ui/switch.tsx frontend/src/surfaces/agent-console/components/AgentConsoleShell.tsx
git commit -m "feat(bot-config): frontend API client, Switch primitive, nav entry"
```

---

### Task 15: Frontend — `BotConfig` shell + route registration

**Files:**
- Create: `frontend/src/surfaces/agent-console/pages/BotConfig/BotConfig.tsx`
- Modify: `frontend/src/routes/AppRoutes.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/BotConfig/BotConfig.test.tsx`

**Interfaces:**
- Consumes: `fetchBotConfig` from Task 14.
- Produces: `BotConfig` page component (default-exports nothing; named export `BotConfig`, matching `Taxonomy`'s convention).

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/surfaces/agent-console/pages/BotConfig/BotConfig.test.tsx
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { BotConfig } from './BotConfig.tsx'
import * as agentApi from '../../api/agentApi.ts'
import * as agentSession from '../../lib/agentSession.ts'

function renderWithQuery() {
  const queryClient = new QueryClient()
  return render(
    <QueryClientProvider client={queryClient}>
      <BotConfig />
    </QueryClientProvider>,
  )
}

describe('BotConfig page', () => {
  beforeEach(() => {
    vi.spyOn(agentSession, 'loadAgentSession').mockReturnValue({
      token: 't', agentId: 'a', displayName: 'Admin', workspaceSlug: 'ws', role: 'admin',
    })
  })

  it('renders three tabs: Prompt, Rules, Tools', async () => {
    vi.spyOn(agentApi, 'fetchBotConfig').mockResolvedValue({
      is_provisioned: true,
      prompt: 'P',
      rules: [],
      tools_config: [],
      enabled_tools: [],
      system_prompt: 'P',
      is_prompt_customized: false,
      is_rules_customized: false,
      is_tools_customized: false,
      updated_at: null,
    })

    renderWithQuery()

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Prompt' })).toBeInTheDocument())
    expect(screen.getByRole('tab', { name: 'Rules' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Tools' })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/web test BotConfig -- --run`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```tsx
// frontend/src/surfaces/agent-console/pages/BotConfig/BotConfig.tsx
import { useQuery } from '@tanstack/react-query'
import { fetchBotConfig } from '../../api/agentApi.ts'
import { loadAgentSession } from '../../lib/agentSession.ts'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.tsx'
import { PromptTab } from './components/PromptTab.tsx'
import { RulesTab } from './components/RulesTab.tsx'
import { ToolsTab } from './components/ToolsTab.tsx'

export function BotConfig() {
  const session = loadAgentSession()

  const configQuery = useQuery({
    queryKey: ['bot-config'],
    queryFn: () => fetchBotConfig(session!.token),
    enabled: session !== null,
  })

  if (!session) return null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 p-3">
        <span className="text-sm font-semibold">Bot Config</span>
      </div>
      <Tabs defaultValue="prompt" className="min-h-0 flex-1 gap-0 p-3">
        <TabsList>
          <TabsTrigger value="prompt">Prompt</TabsTrigger>
          <TabsTrigger value="rules">Rules</TabsTrigger>
          <TabsTrigger value="tools">Tools</TabsTrigger>
        </TabsList>
        <TabsContent value="prompt" className="min-h-0 overflow-auto pt-3">
          <PromptTab token={session.token} config={configQuery.data} />
        </TabsContent>
        <TabsContent value="rules" className="min-h-0 overflow-auto pt-3">
          <RulesTab token={session.token} config={configQuery.data} />
        </TabsContent>
        <TabsContent value="tools" className="min-h-0 overflow-auto pt-3">
          <ToolsTab token={session.token} config={configQuery.data} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
```

- [ ] **Step 4: Register the route**

```ts
// frontend/src/routes/AppRoutes.tsx
const BotConfigPage = lazy(async () => ({
  default: (await import('../surfaces/agent-console/pages/BotConfig/BotConfig.tsx')).BotConfig,
}))

// inside <Route path="/" element={<Suspense><AgentConsoleShell/></Suspense>}>, add:
<Route path="bot-config" element={<BotConfigPage />} />
```

(Task 16 creates `PromptTab.tsx`, `RulesTab.tsx`, `ToolsTab.tsx` — the test above will fail to compile until those exist as at least stub components; write minimal stub components now — `export function PromptTab() { return null }` etc. in their own files — so this task's test passes in isolation, then Task 16 fleshes them out with their own tests.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @support/web test BotConfig -- --run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/BotConfig frontend/src/routes/AppRoutes.tsx
git commit -m "feat(bot-config): BotConfig page shell with three tabs, route registered"
```

---

### Task 16: Frontend — `PromptTab`

**Files:**
- Modify: `frontend/src/surfaces/agent-console/pages/BotConfig/components/PromptTab.tsx` (replace Task 15's stub)
- Test: `frontend/src/surfaces/agent-console/pages/BotConfig/components/PromptTab.test.tsx`

**Interfaces:**
- Consumes: `BotConfigView` from `@support/types`; `saveBotConfig`, `fetchBotConfigHistory`, `rollbackBotConfig` from Task 14.
- Produces: `PromptTab({ token, config }: { token: string; config: BotConfigView | undefined })`.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/surfaces/agent-console/pages/BotConfig/components/PromptTab.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { PromptTab } from './PromptTab.tsx'
import * as agentApi from '../../../api/agentApi.ts'

const BASE_CONFIG = {
  is_provisioned: true,
  prompt: 'Original prompt',
  rules: [],
  tools_config: [],
  enabled_tools: [],
  system_prompt: 'Original prompt',
  is_prompt_customized: false,
  is_rules_customized: false,
  is_tools_customized: false,
  updated_at: null,
}

function renderTab(config = BASE_CONFIG) {
  const queryClient = new QueryClient()
  return render(
    <QueryClientProvider client={queryClient}>
      <PromptTab token="t" config={config} />
    </QueryClientProvider>,
  )
}

describe('PromptTab', () => {
  it('saves an edited prompt', async () => {
    const saveSpy = vi.spyOn(agentApi, 'saveBotConfig').mockResolvedValue({ ...BASE_CONFIG, prompt: 'Edited', is_prompt_customized: true })
    renderTab()

    const textarea = screen.getByLabelText('Prompt')
    fireEvent.change(textarea, { target: { value: 'Edited' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith('t', { prompt: 'Edited' }))
  })

  it('shows "Reset to default" only when customised', () => {
    renderTab({ ...BASE_CONFIG, is_prompt_customized: false })
    expect(screen.queryByRole('button', { name: 'Reset to default' })).not.toBeInTheDocument()

    renderTab({ ...BASE_CONFIG, is_prompt_customized: true })
    expect(screen.getByRole('button', { name: 'Reset to default' })).toBeInTheDocument()
  })

  it('resets by saving prompt: null', async () => {
    const saveSpy = vi.spyOn(agentApi, 'saveBotConfig').mockResolvedValue(BASE_CONFIG)
    renderTab({ ...BASE_CONFIG, is_prompt_customized: true })

    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }))

    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith('t', { prompt: null }))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/web test PromptTab -- --run`
Expected: FAIL — stub renders `null`.

- [ ] **Step 3: Write the implementation**

```tsx
// frontend/src/surfaces/agent-console/pages/BotConfig/components/PromptTab.tsx
import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { BotConfigView } from '@support/types'
import { saveBotConfig } from '../../../api/agentApi.ts'
import { Button } from '../../../components/ui/button.tsx'
import { Textarea } from '../../../components/ui/textarea.tsx'
import { HistoryPanel } from './HistoryPanel.tsx'

export function PromptTab({ token, config }: { token: string; config: BotConfigView | undefined }) {
  const queryClient = useQueryClient()
  const [prompt, setPrompt] = useState(config?.prompt ?? '')

  useEffect(() => {
    if (config) setPrompt(config.prompt)
  }, [config?.prompt])

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['bot-config'] })

  const save = useMutation({
    mutationFn: (value: string | null) => saveBotConfig(token, { prompt: value }),
    onSuccess: () => void invalidate(),
  })

  if (!config) return null

  return (
    <div className="flex h-full min-h-0 gap-4">
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <label htmlFor="bot-config-prompt" className="text-xs font-medium text-muted">
          Prompt
        </label>
        <Textarea
          id="bot-config-prompt"
          aria-label="Prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className="min-h-64 flex-1 font-mono text-xs"
        />
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" onClick={() => save.mutate(prompt)} disabled={save.isPending || !prompt.trim()}>
            Save
          </Button>
          {config.is_prompt_customized && (
            <Button type="button" size="sm" variant="outline" onClick={() => save.mutate(null)} disabled={save.isPending}>
              Reset to default
            </Button>
          )}
        </div>
        {save.isError && <p className="text-xs text-red-600">{save.error?.message}</p>}
      </div>
      <HistoryPanel token={token} field="prompt" onRestored={invalidate} />
    </div>
  )
}
```

(Task 17 provides `HistoryPanel`; write a minimal stub `export function HistoryPanel() { return null }` in `HistoryPanel.tsx` now so this compiles, then Task 17 fleshes it out with its own test.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @support/web test PromptTab -- --run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/BotConfig/components/PromptTab.tsx \
  frontend/src/surfaces/agent-console/pages/BotConfig/components/PromptTab.test.tsx \
  frontend/src/surfaces/agent-console/pages/BotConfig/components/HistoryPanel.tsx
git commit -m "feat(bot-config): PromptTab with save and reset-to-default"
```

---

### Task 17: Frontend — `RulesTab`

**Files:**
- Modify: `frontend/src/surfaces/agent-console/pages/BotConfig/components/RulesTab.tsx` (replace Task 15's stub)
- Test: `frontend/src/surfaces/agent-console/pages/BotConfig/components/RulesTab.test.tsx`

**Interfaces:**
- Consumes: `saveBotConfig`; `Switch` from Task 14.
- Produces: `RulesTab({ token, config }: { token: string; config: BotConfigView | undefined })`.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/surfaces/agent-console/pages/BotConfig/components/RulesTab.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { RulesTab } from './RulesTab.tsx'
import * as agentApi from '../../../api/agentApi.ts'

const CONFIG = {
  is_provisioned: true,
  prompt: 'p',
  rules: [
    { key: 'no_credentials', text: 'Never ask for a password.', enabled: true, locked: true, source: 'builtin', enforcement: 'prompt' },
    { key: 'no_regreet', text: 'Do not greet twice.', enabled: true, locked: false, source: 'builtin', enforcement: 'prompt' },
  ],
  tools_config: [],
  enabled_tools: [],
  system_prompt: 'p',
  is_prompt_customized: false,
  is_rules_customized: false,
  is_tools_customized: false,
  updated_at: null,
}

function renderTab() {
  const queryClient = new QueryClient()
  return render(
    <QueryClientProvider client={queryClient}>
      <RulesTab token="t" config={CONFIG} />
    </QueryClientProvider>,
  )
}

describe('RulesTab', () => {
  it('renders a disabled switch for a locked rule', () => {
    renderTab()
    const switches = screen.getAllByRole('switch')
    const lockedSwitch = switches[0]
    expect(lockedSwitch).toBeDisabled()
  })

  it('toggling an unlocked rule saves the full updated rules array', async () => {
    const saveSpy = vi.spyOn(agentApi, 'saveBotConfig').mockResolvedValue(CONFIG)
    renderTab()

    fireEvent.click(screen.getAllByRole('switch')[1]!)

    await waitFor(() =>
      expect(saveSpy).toHaveBeenCalledWith('t', {
        rules: [
          CONFIG.rules[0],
          { ...CONFIG.rules[1], enabled: false },
        ].map(({ enforcement, ...rest }) => rest),
      }),
    )
  })

  it('adds a custom rule via the free-text input', async () => {
    const saveSpy = vi.spyOn(agentApi, 'saveBotConfig').mockResolvedValue(CONFIG)
    renderTab()

    fireEvent.change(screen.getByPlaceholderText('Add a custom rule…'), { target: { value: 'No emoji.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(saveSpy).toHaveBeenCalled())
    const call = saveSpy.mock.calls[0]![1] as { rules: { text: string; source: string }[] }
    expect(call.rules.at(-1)).toMatchObject({ text: 'No emoji.', source: 'custom', enabled: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/web test RulesTab -- --run`
Expected: FAIL — stub renders `null`.

- [ ] **Step 3: Write the implementation**

```tsx
// frontend/src/surfaces/agent-console/pages/BotConfig/components/RulesTab.tsx
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { BotConfigView, RuleEntryView } from '@support/types'
import { saveBotConfig } from '../../../api/agentApi.ts'
import { Badge } from '../../../components/ui/badge.tsx'
import { Button } from '../../../components/ui/button.tsx'
import { Input } from '../../../components/ui/input.tsx'
import { Switch } from '../../../components/ui/switch.tsx'
import { HistoryPanel } from './HistoryPanel.tsx'

function stripView(rule: RuleEntryView) {
  const { enforcement, ...rest } = rule
  return rest
}

export function RulesTab({ token, config }: { token: string; config: BotConfigView | undefined }) {
  const queryClient = useQueryClient()
  const [newRuleText, setNewRuleText] = useState('')
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['bot-config'] })

  const save = useMutation({
    mutationFn: (rules: ReturnType<typeof stripView>[]) => saveBotConfig(token, { rules }),
    onSuccess: () => {
      setNewRuleText('')
      void invalidate()
    },
  })

  if (!config) return null

  const toggle = (key: string) => {
    const updated = config.rules.map((r) => (r.key === key ? { ...r, enabled: !r.enabled } : r))
    save.mutate(updated.map(stripView))
  }

  const addCustom = () => {
    if (!newRuleText.trim()) return
    const updated = [
      ...config.rules,
      { key: `custom-${Date.now()}`, text: newRuleText.trim(), enabled: true, locked: false, source: 'custom' as const },
    ]
    save.mutate(updated.map(stripView))
  }

  const activeCount = config.rules.filter((r) => r.enabled).length
  const lockedCount = config.rules.filter((r) => r.locked).length

  return (
    <div className="flex h-full min-h-0 gap-4">
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <p className="text-xs text-muted">
          {activeCount} active · {lockedCount} cannot be switched off
        </p>
        <ul className="flex flex-col gap-2">
          {config.rules.map((rule) => (
            <li key={rule.key} className="flex items-start gap-3 rounded-md border border-slate-200 p-2">
              <Switch checked={rule.enabled} disabled={rule.locked || save.isPending} onCheckedChange={() => toggle(rule.key)} />
              <div className="flex flex-1 flex-col gap-1">
                <p className="text-xs">{rule.text}</p>
                <div className="flex items-center gap-1">
                  {rule.locked && <Badge variant="secondary">Locked</Badge>}
                  <Badge variant="outline">{rule.enforcement === 'code' ? 'Enforced in code' : 'Prompt only'}</Badge>
                  {rule.source === 'custom' && <Badge variant="outline">Custom</Badge>}
                </div>
              </div>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-2">
          <Input
            placeholder="Add a custom rule…"
            value={newRuleText}
            onChange={(e) => setNewRuleText(e.target.value)}
            className="h-8 flex-1"
          />
          <Button type="button" size="sm" onClick={addCustom} disabled={save.isPending || !newRuleText.trim()}>
            Add
          </Button>
        </div>
        {save.isError && <p className="text-xs text-red-600">{save.error?.message}</p>}
      </div>
      <HistoryPanel token={token} field="rules" onRestored={invalidate} />
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @support/web test RulesTab -- --run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/BotConfig/components/RulesTab.tsx \
  frontend/src/surfaces/agent-console/pages/BotConfig/components/RulesTab.test.tsx
git commit -m "feat(bot-config): RulesTab with toggles, enforcement badges, custom rule add"
```

---

### Task 18: Frontend — `ToolsTab`

**Files:**
- Modify: `frontend/src/surfaces/agent-console/pages/BotConfig/components/ToolsTab.tsx` (replace Task 15's stub)
- Test: `frontend/src/surfaces/agent-console/pages/BotConfig/components/ToolsTab.test.tsx`

**Interfaces:**
- Consumes: `saveBotConfig`, `Switch`.
- Produces: `ToolsTab({ token, config }: { token: string; config: BotConfigView | undefined })`.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/surfaces/agent-console/pages/BotConfig/components/ToolsTab.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { ToolsTab } from './ToolsTab.tsx'
import * as agentApi from '../../../api/agentApi.ts'

const CONFIG = {
  is_provisioned: true,
  prompt: 'p',
  rules: [],
  tools_config: [
    { tool: 'search_articles', enabled: true },
    { tool: 'classify', enabled: true },
  ],
  enabled_tools: ['search_articles', 'classify'],
  limits_config: [
    { key: 'max_bot_messages', value: 8 },
    { key: 'max_tool_calls_per_turn', value: 6 },
    { key: 'max_articles_per_turn', value: 3 },
    { key: 'max_unhelped_replies', value: 3 },
  ],
  resolved_limits: { max_bot_messages: 8, max_tool_calls_per_turn: 6, max_articles_per_turn: 3, max_unhelped_replies: 3 },
  system_prompt: 'p',
  is_prompt_customized: false,
  is_rules_customized: false,
  is_tools_customized: false,
  is_limits_customized: false,
  updated_at: null,
}

function renderTab() {
  const queryClient = new QueryClient()
  return render(
    <QueryClientProvider client={queryClient}>
      <ToolsTab token="t" config={CONFIG} />
    </QueryClientProvider>,
  )
}

describe('ToolsTab', () => {
  it('shows a static "always on" row for handoff, with no switch', () => {
    renderTab()
    expect(screen.getByText('handoff')).toBeInTheDocument()
    expect(screen.getByText('Always on')).toBeInTheDocument()
  })

  it('shows the consequence copy inline when a toggle is off', () => {
    const off = { ...CONFIG, tools_config: [{ tool: 'search_articles', enabled: false }, { tool: 'classify', enabled: true }] }
    const queryClient = new QueryClient()
    render(
      <QueryClientProvider client={queryClient}>
        <ToolsTab token="t" config={off} />
      </QueryClientProvider>,
    )
    expect(screen.getByText(/Bot can never look anything up/)).toBeInTheDocument()
  })

  it('toggling a tool saves the updated tools_config array', async () => {
    const saveSpy = vi.spyOn(agentApi, 'saveBotConfig').mockResolvedValue(CONFIG)
    renderTab()

    fireEvent.click(screen.getAllByRole('switch')[0]!)

    await waitFor(() =>
      expect(saveSpy).toHaveBeenCalledWith('t', {
        tools_config: [{ tool: 'search_articles', enabled: false }, { tool: 'classify', enabled: true }],
      }),
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/web test ToolsTab -- --run`
Expected: FAIL — stub renders `null`.

- [ ] **Step 3: Write the implementation**

```tsx
// frontend/src/surfaces/agent-console/pages/BotConfig/components/ToolsTab.tsx
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { BotConfigView } from '@support/types'
import { saveBotConfig } from '../../../api/agentApi.ts'
import { Badge } from '../../../components/ui/badge.tsx'
import { Switch } from '../../../components/ui/switch.tsx'
import { HistoryPanel } from './HistoryPanel.tsx'

// Mirrors backend/src/domain/bot/tools.ts TOOL_CATALOG — kept in sync by hand;
// this is display copy only, not enforcement (the API is the enforcement point).
const CONSEQUENCE_COPY: Record<string, string> = {
  search_articles: 'Bot can never look anything up; every turn ends in classify-only or handoff.',
  classify: 'Conversations stay unclassified from the bot; agents classify manually.',
  answer_from_article: 'Bot can search/classify but never answers itself — always hands off after searching.',
  confirm_resolution: 'Article answers are never confirmed by the player; bot_active exits only via handoff or the turn cap.',
}

export function ToolsTab({ token, config }: { token: string; config: BotConfigView | undefined }) {
  const queryClient = useQueryClient()
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['bot-config'] })

  const save = useMutation({
    mutationFn: (toolsConfig: { tool: string; enabled: boolean }[]) => saveBotConfig(token, { tools_config: toolsConfig }),
    onSuccess: () => void invalidate(),
  })

  if (!config) return null

  const toggle = (tool: string) => {
    const updated = config.tools_config.map((t) => (t.tool === tool ? { ...t, enabled: !t.enabled } : t))
    save.mutate(updated)
  }

  return (
    <div className="flex h-full min-h-0 gap-4">
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <ul className="flex flex-col gap-2">
          {config.tools_config.map((t) => (
            <li key={t.tool} className="flex flex-col gap-1 rounded-md border border-slate-200 p-2">
              <div className="flex items-center gap-3">
                <Switch checked={t.enabled} disabled={save.isPending} onCheckedChange={() => toggle(t.tool)} />
                <span className="text-xs font-medium">{t.tool}</span>
              </div>
              {!t.enabled && <p className="pl-11 text-xs text-muted">{CONSEQUENCE_COPY[t.tool]}</p>}
            </li>
          ))}
          <li className="flex items-center gap-3 rounded-md border border-slate-200 p-2 opacity-70">
            <Badge variant="secondary">Always on</Badge>
            <span className="text-xs font-medium">handoff</span>
          </li>
        </ul>
        {save.isError && <p className="text-xs text-red-600">{save.error?.message}</p>}
      </div>
      <HistoryPanel token={token} field="tools_config" onRestored={invalidate} />
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @support/web test ToolsTab -- --run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/BotConfig/components/ToolsTab.tsx \
  frontend/src/surfaces/agent-console/pages/BotConfig/components/ToolsTab.test.tsx
git commit -m "feat(bot-config): ToolsTab with per-tool toggles and consequence copy"
```

- [ ] **Step 6: Add a "Limits" section to the same tab** (per the design conversation: limits live inside Tools, not a separate tab)

Renders the 4 `limits_config` entries as number inputs, grouped so each numeric ceiling sits near the tool behavior it constrains: `max_articles_per_turn` directly under the `search_articles` row, `max_tool_calls_per_turn` and `max_bot_messages`/`max_unhelped_replies` in a "Conversation limits" block below the tool list (these two aren't tied to one specific tool). Bounds (`min`/`max` per key) are **not** sent by the API in the response body — the plan's design decision was that `LIMIT_CATALOG` bounds are a backend concern (Task 6.5) enforced at save time, so the frontend does not need to fetch or duplicate them; it only needs to show the server's 422 message when a save is rejected, the same pattern `RulesTab`/`ToolsTab` already use for `save.isError`.

(The `CONFIG` fixture in Step 1 above already carries `limits_config`/`resolved_limits`/`is_limits_customized` — no further fixture change needed.)

New test cases:

```tsx
it('renders a number input per limit, seeded from resolved_limits', () => {
  renderTab()
  expect(screen.getByLabelText('Max bot messages per conversation')).toHaveValue(8)
  expect(screen.getByLabelText('Max article searches per turn')).toHaveValue(3)
})

it('saves a changed limit on blur, sending the full limits_config array', async () => {
  const saveSpy = vi.spyOn(agentApi, 'saveBotConfig').mockResolvedValue(CONFIG)
  renderTab()

  const input = screen.getByLabelText('Max unhelped replies before handoff')
  fireEvent.change(input, { target: { value: '5' } })
  fireEvent.blur(input)

  await waitFor(() =>
    expect(saveSpy).toHaveBeenCalledWith('t', {
      limits_config: [
        { key: 'max_bot_messages', value: 8 },
        { key: 'max_tool_calls_per_turn', value: 6 },
        { key: 'max_articles_per_turn', value: 3 },
        { key: 'max_unhelped_replies', value: 5 },
      ],
    }),
  )
})

it('shows the server error message when a save is rejected as out of bounds', async () => {
  vi.spyOn(agentApi, 'saveBotConfig').mockRejectedValue(new Error('"max_bot_messages" must be between 3 and 20.'))
  renderTab()

  const input = screen.getByLabelText('Max bot messages per conversation')
  fireEvent.change(input, { target: { value: '999' } })
  fireEvent.blur(input)

  await waitFor(() => expect(screen.getByText(/must be between 3 and 20/)).toBeInTheDocument())
})
```

Implementation addition to `ToolsTab.tsx`:

```tsx
const LIMIT_LABELS: Record<string, string> = {
  max_bot_messages: 'Max bot messages per conversation',
  max_tool_calls_per_turn: 'Max tool calls per turn',
  max_articles_per_turn: 'Max article searches per turn',
  max_unhelped_replies: 'Max unhelped replies before handoff',
}

// Inside ToolsTab, alongside the existing `save` mutation:
const saveLimits = useMutation({
  mutationFn: (limitsConfig: { key: string; value: number }[]) => saveBotConfig(token, { limits_config: limitsConfig }),
  onSuccess: () => void invalidate(),
})

const updateLimit = (key: string, value: number) => {
  const updated = config.limits_config.map((l) => (l.key === key ? { ...l, value } : l))
  saveLimits.mutate(updated)
}

// Rendered inside the tab, below the tools <ul>:
<div className="flex flex-col gap-2 rounded-md border border-slate-200 p-2">
  <h3 className="text-xs font-semibold">Conversation limits</h3>
  {config.limits_config.map((l) => (
    <label key={l.key} className="flex items-center justify-between gap-3 text-xs">
      <span>{LIMIT_LABELS[l.key]}</span>
      <input
        type="number"
        aria-label={LIMIT_LABELS[l.key]}
        defaultValue={l.value}
        disabled={saveLimits.isPending}
        onBlur={(e) => updateLimit(l.key, Number(e.target.value))}
        className="w-16 rounded border border-slate-200 px-1 py-0.5 text-right"
      />
    </label>
  ))}
  {saveLimits.isError && <p className="text-xs text-red-600">{saveLimits.error?.message}</p>}
</div>
```

`defaultValue` (not `value`) is deliberate here — an uncontrolled input that re-syncs only via React key/remount avoids fighting the user's keystroke while they're typing between the change and blur events; the mutation is the source of truth, not local state.

- [ ] **Step 7: Run test to verify it passes, and commit**

Run: `pnpm --filter @support/web test ToolsTab -- --run`
Expected: PASS

```bash
git add frontend/src/surfaces/agent-console/pages/BotConfig/components/ToolsTab.tsx \
  frontend/src/surfaces/agent-console/pages/BotConfig/components/ToolsTab.test.tsx
git commit -m "feat(bot-config): editable per-workspace limits in ToolsTab"
```

---

### Task 19: Frontend — `HistoryPanel` with Restore

**Files:**
- Modify: `frontend/src/surfaces/agent-console/pages/BotConfig/components/HistoryPanel.tsx` (replace Tasks 16–18's stub)
- Test: `frontend/src/surfaces/agent-console/pages/BotConfig/components/HistoryPanel.test.tsx`

**Interfaces:**
- Consumes: `fetchBotConfigHistory`, `rollbackBotConfig`.
- Produces: `HistoryPanel({ token, field, onRestored }: { token: string; field: 'prompt' | 'rules' | 'tools_config'; onRestored: () => void })`.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/surfaces/agent-console/pages/BotConfig/components/HistoryPanel.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { HistoryPanel } from './HistoryPanel.tsx'
import * as agentApi from '../../../api/agentApi.ts'

function renderPanel(onRestored = vi.fn()) {
  const queryClient = new QueryClient()
  render(
    <QueryClientProvider client={queryClient}>
      <HistoryPanel token="t" field="prompt" onRestored={onRestored} />
    </QueryClientProvider>,
  )
  return { onRestored }
}

describe('HistoryPanel', () => {
  it('lists entries for the given field with a Restore control per entry', async () => {
    vi.spyOn(agentApi, 'fetchBotConfigHistory').mockResolvedValue({
      entries: [
        { id: '2', field: 'prompt', before_value: 'A', after_value: 'B', actor: { id: 'a', display_name: 'Admin', email: 'a@x.test' }, changed_at: '2026-08-19T00:00:00.000Z' },
      ],
      next_cursor: null,
    })

    renderPanel()

    await waitFor(() => expect(screen.getByText('Admin')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument()
  })

  it('calls rollbackBotConfig with the entry id and invokes onRestored on success', async () => {
    vi.spyOn(agentApi, 'fetchBotConfigHistory').mockResolvedValue({
      entries: [
        { id: '2', field: 'prompt', before_value: 'A', after_value: 'B', actor: { id: 'a', display_name: 'Admin', email: 'a@x.test' }, changed_at: '2026-08-19T00:00:00.000Z' },
      ],
      next_cursor: null,
    })
    const rollbackSpy = vi.spyOn(agentApi, 'rollbackBotConfig').mockResolvedValue({} as never)
    const { onRestored } = renderPanel()

    await waitFor(() => screen.getByRole('button', { name: 'Restore' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))

    await waitFor(() => expect(rollbackSpy).toHaveBeenCalledWith('t', { field: 'prompt', change_log_id: '2', side: 'before' }))
    await waitFor(() => expect(onRestored).toHaveBeenCalled())
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/web test HistoryPanel -- --run`
Expected: FAIL — stub renders `null`.

- [ ] **Step 3: Write the implementation**

```tsx
// frontend/src/surfaces/agent-console/pages/BotConfig/components/HistoryPanel.tsx
import { useQuery, useMutation } from '@tanstack/react-query'
import { fetchBotConfigHistory, rollbackBotConfig } from '../../../api/agentApi.ts'
import { Button } from '../../../components/ui/button.tsx'
import { ScrollArea } from '../../../components/ui/scroll-area.tsx'

/**
 * "Restore" always targets the entry's `before_value` — the state right
 * before this change happened, i.e. "undo this specific edit" — which is what
 * the doc's per-row Restore control means. `after_value` restores are still
 * reachable via the rollback endpoint (e.g. redo), but there is no button for
 * that in this UI; it isn't part of the doc's Rules/Prompt/Tools screens.
 */
export function HistoryPanel({
  token,
  field,
  onRestored,
}: {
  token: string
  field: 'prompt' | 'rules' | 'tools_config'
  onRestored: () => void
}) {
  const historyQuery = useQuery({
    queryKey: ['bot-config-history', field],
    queryFn: () => fetchBotConfigHistory(token, { field, limit: 20 }),
  })

  const restore = useMutation({
    mutationFn: (changeLogId: string) => rollbackBotConfig(token, { field, change_log_id: changeLogId, side: 'before' }),
    onSuccess: () => onRestored(),
  })

  const entries = historyQuery.data?.entries ?? []

  return (
    <div className="flex w-64 shrink-0 flex-col gap-2 border-l border-slate-200 pl-3">
      <span className="text-xs font-semibold text-muted">History</span>
      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col gap-2">
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-col gap-1 rounded-md border border-slate-200 p-2 text-xs">
              <span className="font-medium">{entry.actor.display_name}</span>
              <span className="text-muted">{new Date(entry.changed_at).toLocaleString()}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => restore.mutate(entry.id)}
                disabled={restore.isPending}
              >
                Restore
              </Button>
            </li>
          ))}
          {entries.length === 0 && <li className="text-xs text-muted">No changes yet.</li>}
        </ul>
      </ScrollArea>
      {restore.isError && <p className="text-xs text-red-600">{restore.error?.message}</p>}
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @support/web test HistoryPanel -- --run`
Expected: PASS

Then run every BotConfig-related frontend test together:

Run: `pnpm --filter @support/web test BotConfig -- --run`
Expected: PASS (all of Tasks 15–19's suites)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/BotConfig/components/HistoryPanel.tsx \
  frontend/src/surfaces/agent-console/pages/BotConfig/components/HistoryPanel.test.tsx
git commit -m "feat(bot-config): HistoryPanel with per-entry Restore"
```

---

### Task 20: Full-suite run + final validation against the spec's requirement scope

**Files:** none (verification-only task).

This is the **only** task in the plan that includes an AI-driven review rather than a mechanical test run — per the Execution / Validation Policy above, every task before this one was gated on Vitest alone.

- [ ] **Step 1: Run every test suite**

```bash
pnpm --filter @support/types test -- --run
pnpm --filter @support/api test -- --run
pnpm --filter @support/web test -- --run
pnpm typecheck
```

Expected: all green, no type errors.

- [ ] **Step 2: Run the parity checks explicitly, by name, and read their output**

```bash
pnpm --filter @support/api test bot.config -- --run -t PARITY
pnpm --filter @support/api test bot.tools -- --run -t PARITY
pnpm --filter @support/api test bot.limitsCatalog -- --run
pnpm --filter @support/api test bot.toolLoop.determinism -- --run
```

Expected: all PASS — these are the tests that mechanically enforce "zero behavior change for an uncustomised workspace," including the limits parity case added in Part 1 Task 8 Step 6 (default `limits_config` behaves identically to the old hardcoded `MAX_BOT_MESSAGES`/`MAX_TOOL_CALLS_PER_TURN`/`MAX_ARTICLES_PER_TURN`).

- [ ] **Step 3: Manual smoke test**

Run `pnpm dev`, log in as an admin (dev login), open `/bot-config`, and confirm:
- Prompt tab loads the seeded `DEFAULT_BOT_PROMPT`, Save and Reset-to-default both work, History lists a "System" seed entry.
- Rules tab shows 8 rows, the two locked rows (`handoff_immediate`, `no_credentials`) have a disabled switch, adding a custom rule works and appears in Rules and in the Prompt tab's rendered `system_prompt` (visible via `GET /agent/bot-config`'s `system_prompt` field or the interactive Swagger UI at `http://localhost:4000/docs`).
- Tools tab shows 4 toggleable rows plus a static "Always on" `handoff` row; disabling `search_articles` shows its consequence copy.
- Tools tab's "Conversation limits" section shows all 4 numeric limits seeded at their defaults (8/6/3/3); changing `max_bot_messages` to a value outside 3–20 and blurring shows the server's bound-violation message; changing it to a valid value persists across a page reload.
- `http://localhost:4000/docs` lists all four `/agent/bot-config*` paths with descriptions matching Task 13, including `limits_config` in the POST body schema and `'limits_config'` in the history/rollback field enums.

- [ ] **Step 4: Walk the spec section-by-section and confirm every requirement has a corresponding implementation**

Open `docs/specs/2026-08-19-bot-config-tab-design.md` and check off each of the following against the code actually written (not against this plan — against the live repo state after Tasks 1–19):

- **Goals** (spec lines 17–32): toggleable rule list with 2 locked + free-text custom, all required-non-empty → Task 7 `validateRules`. Deterministic tool gating, no reliance on model compliance → Task 6/8. History + rollback via `change_log`, no new table → Task 9/10/11. Seeded real rows, not virtual defaults → Task 3/7/13. Custom rules can never claim `enforcement: 'code'` → Task 2 (`RuleEntrySchema` omits the field) + Task 10 (`deriveEnforcement` hardcodes `'prompt'` for custom).
- **Data model** (35–76): schema matches Task 3's final `bot.ts`. `RuleEntry`/`ToolToggle` shapes match Task 1/2/6.
- **Built-in rule catalog** (78–126): 8 rules, exact texts/keys/locked flags per Task 1's table; `buildSystemPrompt` catalog-order rendering per Task 5.
- **Tool gating** (128–161): `TOOL_CATALOG` order and names, `toolsForPhase` filter behavior, `handoff` never filtered — Task 6/8.
- **Seeding / baseline** (163–203): `seedBotConfig` — Task 7; dev-seed wiring — Task 13; existing-workspace backfill — Task 3's backfill script; behavior parity guarantee — Task 5/6 parity tests.
- **Versioning / history / rollback** (205–219): `change_log` field values, history endpoint `field=` filter, rollback endpoint semantics — Task 9/10/11/12.
- **API / types** (221–268): Zod schemas, save-time domain validation list (locked-missing, builtin-missing, zero-enabled, custom-reused-key, unknown-tool-name, no-block-on-dead-tool-combo) — confirm each bullet against Task 7's `validateRules`/`validateToolsConfig` and Task 2's schemas; the "no validation blocks disabling search_articles while answer_from_article stays enabled" bullet should have **no** corresponding validation code — confirm that's true (it's a deliberate absence).
- **Frontend** (270–287): three tabs, per-tab Save, Rules count summary + enforcement badges + locked rows, Tools consequence copy + static handoff row, History + Restore on all three — Task 15–19.
- **Testing** (289–309): every bullet in the spec's own Testing section should map to a task above — parity test (Task 5/6), `bot.config.test.ts` updates (Task 7), `agent.botConfig.test.ts` updates including rollback (Task 12), `toolLoop` determinism test (Task 8).
- **Out of scope** (311–319): confirm nothing in Tasks 1–19 touched Forms/Knowledge tabs, added code-level content scanning beyond `scoreGrounding`, or invented new migration-script infrastructure beyond what Task 3 needed.
- **Configurable limits (added after this spec was written — not in the spec doc itself, verify against this plan's own tasks instead):** `LIMIT_CATALOG` (4 keys, defaults matching today's hardcoded constants, min/max bounds) — Part 1 Task 6.5. `resolveBotConfig`/`saveBotConfig`/`seedBotConfig` handle `limits_config` with the same before/after/change-log shape as `tools_config` — Task 7.5. `toolLoopDecider` reads `resolvedLimits` instead of the deleted `MAX_BOT_MESSAGES`/`MAX_TOOL_CALLS_PER_TURN` constants and `tools.ts`'s deleted `MAX_ARTICLES_PER_TURN` — Task 8 Steps 6–7. The new `max_unhelped_replies` ceiling forces a `reason: 'unhelped_cap'` handoff, derived from the event log with no new stored counter, and fires independently of (and typically before) `max_bot_messages` — Task 8 Step 7. `limits_config`/`resolved_limits`/`is_limits_customized` appear in `BotConfigView`, and `'limits_config'` is a valid `RollbackBotConfigBody`/history `field` value — Task 2/10/11/13. Frontend renders all 4 limits as editable number inputs inside the Tools tab, grouped near the tool each constrains — Task 18 Step 6.

If this walk-through finds a gap, write and execute a follow-up task before considering the feature done — do not silently mark this task complete with a known gap.

- [ ] **Step 5: Commit** (only if Step 4 required follow-up fixes; otherwise this task produces no diff)

```bash
git add -A
git commit -m "test(bot-config): close gaps found in final spec-scope validation"
```
