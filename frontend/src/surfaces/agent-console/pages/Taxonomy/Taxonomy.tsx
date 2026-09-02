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

  const admin = isAdmin(session);
  const intents = intentsQuery.data?.intents ?? [];
  const allSubintents = intents.flatMap((i) =>
    i.subintents.map((s) => ({ ...s, intentId: i.id, intentName: i.name })),
  );
  const activeIntents = intents.filter((i) => i.archivedAt === null);
  const archivedIntents = intents.filter((i) => i.archivedAt !== null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 p-3">
        <span className="text-sm font-semibold">Taxonomy</span>
        <div
          className="flex items-center gap-2"
          title={admin ? undefined : 'Only an admin can add intents.'}
        >
          <Input
            placeholder="New intent name"
            value={newIntentName}
            onChange={(e) => setNewIntentName(e.target.value)}
            className="h-8 w-48"
            disabled={!admin}
          />
          <Button
            type="button"
            size="sm"
            onClick={() => addIntent.mutate()}
            disabled={!admin || addIntent.isPending || !newIntentName}
          >
            + Add intent
          </Button>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1 p-3">
        {intentsQuery.data && intents.length === 0 ? (
          <EmptyState message="Nothing to show" />
        ) : (
          <>
            <ul className="flex flex-col gap-4">
              {activeIntents.map((intent) => (
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
            {archivedIntents.length > 0 && (
              <div className="mt-6">
                <p className="mb-2 text-xs font-semibold text-muted">Archived</p>
                <ul className="flex flex-col gap-4">
                  {archivedIntents.map((intent) => (
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
              </div>
            )}
          </>
        )}
      </ScrollArea>
    </div>
  );
}
