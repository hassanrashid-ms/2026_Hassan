import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DeclaredFieldType } from '@support/types';
import { createDeclaredField, fetchDeclaredFields } from '../../api/agentApi.ts';
import { loadAgentSession } from '../../lib/agentSession.ts';
import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { ScrollArea } from '../../components/ui/scroll-area.tsx';
import { EmptyState } from '../../components/ui/empty-state.tsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.tsx';
import { DeclaredFieldRow } from './components/DeclaredFieldRow.tsx';

const TYPES: DeclaredFieldType[] = ['string', 'number', 'boolean', 'timestamp'];
const KEY_PATTERN = /^[a-z0-9_]+$/;

export function DeclaredFields() {
  const session = loadAgentSession();
  const queryClient = useQueryClient();
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [type, setType] = useState<DeclaredFieldType>('string');
  const [confirmPromote, setConfirmPromote] = useState(false);

  const fieldsQuery = useQuery({
    queryKey: ['declared-fields'],
    queryFn: () => fetchDeclaredFields(session!.token),
    enabled: session !== null,
  });

  const promote = useMutation({
    mutationFn: () => createDeclaredField(session!.token, { key, label, type }),
    onSuccess: () => {
      setKey('');
      setLabel('');
      setType('string');
      setConfirmPromote(false);
      void queryClient.invalidateQueries({ queryKey: ['declared-fields'] });
    },
  });

  if (!session) return null;

  const fields = fieldsQuery.data?.fields ?? [];
  const keyValid = KEY_PATTERN.test(key);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border p-3">
        <span className="text-sm font-semibold">Declared Fields</span>
        <div className="flex items-center gap-2">
          <Input
            placeholder="key (e.g. vip_status)"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="h-8 w-40 font-mono text-xs"
          />
          <Input
            placeholder="Label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="h-8 w-40"
          />
          <Select value={type} onValueChange={(v) => setType(v as DeclaredFieldType)}>
            <SelectTrigger className="h-8 w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            onClick={() => setConfirmPromote(true)}
            disabled={promote.isPending || !keyValid || !label}
          >
            + Promote field
          </Button>
        </div>
      </div>
      {promote.isError && (
        <p className="px-3 pt-2 text-xs text-red-600">{promote.error?.message}</p>
      )}
      <ScrollArea className="min-h-0 flex-1 p-3">
        {fieldsQuery.data && fields.length === 0 ? (
          <EmptyState message="No declared fields yet" />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="px-3 py-2">Key</th>
                <th className="px-3 py-2">Label</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Declared</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {fields.map((field) => (
                <DeclaredFieldRow key={field.id} token={session.token} field={field} />
              ))}
            </tbody>
          </table>
        )}
      </ScrollArea>
      <ConfirmDialog
        open={confirmPromote}
        onOpenChange={setConfirmPromote}
        title="Promote this key to declared?"
        description={`"${key}" will start being split out of raw player state into declared on every new snapshot from now on. Snapshots already stored are unaffected.`}
        confirmLabel="Promote"
        confirming={promote.isPending}
        onConfirm={() => promote.mutate()}
      />
    </div>
  );
}
