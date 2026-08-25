import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createIntent, fetchIntents } from '../../api/agentApi.ts';
import { isAdmin, loadAgentSession } from '../../lib/agentSession.ts';
import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { ScrollArea } from '../../components/ui/scroll-area.tsx';
import { EmptyState } from '../../components/ui/empty-state.tsx';
import { IntentRow } from './components/IntentRow.tsx';

export function Taxonomy() {
  const session = loadAgentSession();
  const queryClient = useQueryClient();
  const [newIntentName, setNewIntentName] = useState('');

  const intentsQuery = useQuery({
    queryKey: ['admin-intents'],
    queryFn: () => fetchIntents(session!.token),
    enabled: session !== null,
  });

  const addIntent = useMutation({
    mutationFn: () => createIntent(session!.token, newIntentName),
    onSuccess: () => {
      setNewIntentName('');
      void queryClient.invalidateQueries({ queryKey: ['admin-intents'] });
    },
  });

  if (!session) return null;

  const intents = intentsQuery.data?.intents ?? [];
  const allSubintents = intents.flatMap((i) =>
    i.subintents.map((s) => ({ ...s, intentId: i.id, intentName: i.name })),
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 p-3">
        <span className="text-sm font-semibold">Taxonomy</span>
        {isAdmin(session) && (
          <div className="flex items-center gap-2">
            <Input
              placeholder="New intent name"
              value={newIntentName}
              onChange={(e) => setNewIntentName(e.target.value)}
              className="h-8 w-48"
            />
            <Button
              type="button"
              size="sm"
              onClick={() => addIntent.mutate()}
              disabled={addIntent.isPending || !newIntentName}
            >
              + Add intent
            </Button>
          </div>
        )}
      </div>
      <ScrollArea className="min-h-0 flex-1 p-3">
        {intentsQuery.data && intents.length === 0 ? (
          <EmptyState message="Nothing to show" />
        ) : (
          <ul className="flex flex-col gap-4">
            {intents.map((intent) => (
              <IntentRow
                key={intent.id}
                token={session.token}
                session={session}
                intent={intent}
                allIntents={intents}
                allSubintents={allSubintents}
              />
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}
