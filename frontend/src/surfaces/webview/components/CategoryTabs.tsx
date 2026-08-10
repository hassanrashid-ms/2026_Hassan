import { Tabs, TabsList, TabsTrigger } from '@/surfaces/webview/components/ui/tabs'

export const ALL_INTENTS = 'all'

type Intent = { id: string; name: string }

type CategoryTabsProps = {
  intents: readonly Intent[]
  /** null means "All". */
  intentId: string | null
  onIntentChange: (intentId: string | null) => void
}

/**
 * The selected intent is passed straight back to fetchArticles as `intentId`, so
 * the filter composes with the query server-side and Weaviate receives it. This
 * component must never filter the article array it sits above — see the search
 * regression note in the design doc.
 */
export function CategoryTabs({ intents, intentId, onIntentChange }: CategoryTabsProps) {
  if (intents.length === 0) return null

  return (
    <Tabs
      value={intentId ?? ALL_INTENTS}
      onValueChange={(value) => onIntentChange(value === ALL_INTENTS ? null : value)}
    >
      <TabsList aria-label="Filter by category">
        <TabsTrigger value={ALL_INTENTS}>All</TabsTrigger>
        {intents.map((intent) => (
          <TabsTrigger key={intent.id} value={intent.id}>
            {intent.name}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
