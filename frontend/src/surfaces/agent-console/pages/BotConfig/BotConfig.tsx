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
