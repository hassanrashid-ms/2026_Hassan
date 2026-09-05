import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { DeclaredFieldType } from '@support/types';
import { createDeclaredField, fetchDeclaredFields } from '../../../api/adminApi.ts';
import { ApiError } from '../../../../../lib/httpClient.ts';
import { Button } from '../../../components/ui/button.tsx';
import { Input } from '../../../components/ui/input.tsx';
import { ConfirmDialog } from '../../../components/ConfirmDialog.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select.tsx';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../components/ui/table.tsx';
import { DeclaredFieldRow } from './DeclaredFieldRow.tsx';

const TYPES: DeclaredFieldType[] = ['string', 'number', 'boolean', 'timestamp'];
const KEY_PATTERN = /^[a-z0-9_]+$/;

function reportError(error: unknown) {
  toast.error(
    error instanceof ApiError ? error.message : 'Something went wrong. Please try again.',
  );
}

export function DeclaredFieldsPanel({
  token,
  workspaceId,
}: {
  token: string;
  workspaceId: string;
}) {
  const queryClient = useQueryClient();
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [type, setType] = useState<DeclaredFieldType>('string');
  const [confirmPromote, setConfirmPromote] = useState(false);

  const fieldsQuery = useQuery({
    queryKey: ['adminDeclaredFields', workspaceId],
    queryFn: () => fetchDeclaredFields(token, workspaceId),
  });

  const promote = useMutation({
    mutationFn: () => createDeclaredField(token, workspaceId, { key, label, type }),
    onSuccess: () => {
      setKey('');
      setLabel('');
      setType('string');
      setConfirmPromote(false);
      void queryClient.invalidateQueries({ queryKey: ['adminDeclaredFields', workspaceId] });
    },
    onError: reportError,
  });

  const fields = fieldsQuery.data?.fields ?? [];
  const keyValid = KEY_PATTERN.test(key);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end gap-2">
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

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Key</TableHead>
            <TableHead>Label</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Declared</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {fieldsQuery.isPending && (
            <TableRow>
              <TableCell colSpan={6} className="text-muted">
                Loading declared fields…
              </TableCell>
            </TableRow>
          )}
          {fieldsQuery.isSuccess && fields.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-muted">
                No declared fields yet.
              </TableCell>
            </TableRow>
          )}
          {fields.map((field) => (
            <DeclaredFieldRow
              key={field.id}
              token={token}
              workspaceId={workspaceId}
              field={field}
            />
          ))}
        </TableBody>
      </Table>

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
