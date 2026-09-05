import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DeclaredFieldType, DeclaredFieldView } from '@support/types';
import {
  archiveDeclaredField,
  deactivateDeclaredField,
  reactivateDeclaredField,
  updateDeclaredField,
} from '../../../api/adminApi.ts';
import { Badge } from '../../../components/ui/badge.tsx';
import { Button } from '../../../components/ui/button.tsx';
import { Input } from '../../../components/ui/input.tsx';
import { TableCell, TableRow } from '../../../components/ui/table.tsx';
import { ConfirmDialog } from '../../../components/ConfirmDialog.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select.tsx';

const TYPES: DeclaredFieldType[] = ['string', 'number', 'boolean', 'timestamp'];

export function DeclaredFieldRow({
  token,
  workspaceId,
  field,
}: {
  token: string;
  workspaceId: string;
  field: DeclaredFieldView;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(field.label);
  const [type, setType] = useState<DeclaredFieldType>(field.type);
  const [confirmSave, setConfirmSave] = useState(false);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [confirmReactivate, setConfirmReactivate] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['adminDeclaredFields', workspaceId] });

  const save = useMutation({
    mutationFn: () => updateDeclaredField(token, workspaceId, field.id, { label, type }),
    onSuccess: () => {
      setConfirmSave(false);
      setEditing(false);
      void invalidate();
    },
  });

  const deactivate = useMutation({
    mutationFn: () => deactivateDeclaredField(token, workspaceId, field.id),
    onSuccess: () => {
      setConfirmDeactivate(false);
      void invalidate();
    },
  });

  const reactivate = useMutation({
    mutationFn: () => reactivateDeclaredField(token, workspaceId, field.id),
    onSuccess: () => {
      setConfirmReactivate(false);
      void invalidate();
    },
  });

  const archive = useMutation({
    mutationFn: () => archiveDeclaredField(token, workspaceId, field.id),
    onSuccess: () => {
      setConfirmArchive(false);
      void invalidate();
    },
  });

  const dirty = label !== field.label || type !== field.type;
  const isActive = field.status === 'active';
  const isSeeded = field.declaredBy === null;

  return (
    <TableRow>
      <TableCell className="font-mono text-xs text-muted">{field.key}</TableCell>
      <TableCell>
        {editing ? (
          <Input value={label} onChange={(e) => setLabel(e.target.value)} className="h-8 w-48" />
        ) : (
          field.label
        )}
      </TableCell>
      <TableCell>
        {editing ? (
          <div className="flex items-center gap-2">
            <Select
              value={type}
              onValueChange={(v) => setType(v as DeclaredFieldType)}
              disabled={isSeeded}
            >
              <SelectTrigger className="h-8 w-32">
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
            {isSeeded && (
              <span className="text-xs text-muted">Type is locked for built-in fields</span>
            )}
          </div>
        ) : (
          <Badge variant="secondary">{field.type}</Badge>
        )}
      </TableCell>
      <TableCell>
        <Badge variant={isActive ? 'default' : 'secondary'}>{field.status}</Badge>
      </TableCell>
      <TableCell className="text-xs text-muted">
        {new Date(field.declaredAt).toLocaleDateString()}
        {field.declaredByName ? ` · ${field.declaredByName}` : ''}
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          {editing ? (
            <>
              <Button
                type="button"
                size="sm"
                onClick={() => setConfirmSave(true)}
                disabled={save.isPending || !label || !dirty}
              >
                Save
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setEditing(false);
                  setLabel(field.label);
                  setType(field.type);
                }}
              >
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
                Edit
              </Button>
              {isActive ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirmDeactivate(true)}
                >
                  Deactivate
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirmReactivate(true)}
                >
                  Reactivate
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setConfirmArchive(true)}
              >
                ×
              </Button>
            </>
          )}
        </div>
      </TableCell>
      <ConfirmDialog
        open={confirmSave}
        onOpenChange={setConfirmSave}
        title="Save changes to this declared field?"
        description={`"${field.key}" will be relabeled${
          type !== field.type ? ' and its type changed' : ''
        }. This does not affect data already stored.`}
        confirmLabel="Save"
        confirming={save.isPending}
        onConfirm={() => save.mutate()}
      />
      <ConfirmDialog
        open={confirmDeactivate}
        onOpenChange={setConfirmDeactivate}
        title="Deactivate this declared field?"
        description={`Future player-state writes for "${field.key}" will go back into raw, unfiltered data. Snapshots already captured keep their existing split. It stays visible here and can be reactivated any time.`}
        confirmLabel="Deactivate"
        variant="destructive"
        confirming={deactivate.isPending}
        onConfirm={() => deactivate.mutate()}
      />
      <ConfirmDialog
        open={confirmReactivate}
        onOpenChange={setConfirmReactivate}
        title="Reactivate this declared field?"
        description={`"${field.key}" will start being split into declared again on every new snapshot from now on.`}
        confirmLabel="Reactivate"
        confirming={reactivate.isPending}
        onConfirm={() => reactivate.mutate()}
      />
      <ConfirmDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title="Archive this declared field?"
        description={`"${field.key}" will be hidden from this list entirely and future writes fall back into raw. Snapshots already captured are unaffected. Promoting the same key again later revives it.`}
        confirmLabel="Archive"
        variant="destructive"
        confirming={archive.isPending}
        onConfirm={() => archive.mutate()}
      />
    </TableRow>
  );
}
