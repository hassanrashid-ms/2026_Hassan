import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DeclaredFieldType, DeclaredFieldView } from '@support/types';
import {
  archiveDeclaredField,
  deactivateDeclaredField,
  reactivateDeclaredField,
  updateDeclaredField,
} from '../../../api/agentApi.ts';
import { Badge } from '../../../components/ui/badge.tsx';
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

const TYPES: DeclaredFieldType[] = ['string', 'number', 'boolean', 'timestamp'];

export function DeclaredFieldRow({ token, field }: { token: string; field: DeclaredFieldView }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(field.label);
  const [type, setType] = useState<DeclaredFieldType>(field.type);
  const [confirmSave, setConfirmSave] = useState(false);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);
  const [confirmReactivate, setConfirmReactivate] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['declared-fields'] });

  const save = useMutation({
    mutationFn: () => updateDeclaredField(token, field.id, { label, type }),
    onSuccess: () => {
      setConfirmSave(false);
      setEditing(false);
      void invalidate();
    },
  });

  const deactivate = useMutation({
    mutationFn: () => deactivateDeclaredField(token, field.id),
    onSuccess: () => {
      setConfirmDeactivate(false);
      void invalidate();
    },
  });

  const reactivate = useMutation({
    mutationFn: () => reactivateDeclaredField(token, field.id),
    onSuccess: () => {
      setConfirmReactivate(false);
      void invalidate();
    },
  });

  const archive = useMutation({
    mutationFn: () => archiveDeclaredField(token, field.id),
    onSuccess: () => {
      setConfirmArchive(false);
      void invalidate();
    },
  });

  const dirty = label !== field.label || type !== field.type;
  const isActive = field.status === 'active';
  const isSeeded = field.declaredBy === null;

  return (
    <tr className={!isActive ? 'opacity-60' : undefined}>
      <td className="px-3 py-2 font-mono text-xs text-muted">{field.key}</td>
      <td className="px-3 py-2">
        {editing ? (
          <Input value={label} onChange={(e) => setLabel(e.target.value)} className="h-8 w-48" />
        ) : (
          field.label
        )}
      </td>
      <td className="px-3 py-2">
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
      </td>
      <td className="px-3 py-2">
        <Badge variant={isActive ? 'default' : 'secondary'}>{field.status}</Badge>
      </td>
      <td className="px-3 py-2 text-xs text-muted">
        {new Date(field.declaredAt).toLocaleDateString()}
        {field.declaredByName ? ` · ${field.declaredByName}` : ''}
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-1">
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
          {save.isError && <p className="text-xs text-red-600">{save.error?.message}</p>}
          {deactivate.isError && (
            <p className="text-xs text-red-600">{deactivate.error?.message}</p>
          )}
          {reactivate.isError && (
            <p className="text-xs text-red-600">{reactivate.error?.message}</p>
          )}
          {archive.isError && <p className="text-xs text-red-600">{archive.error?.message}</p>}
        </div>
      </td>
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
    </tr>
  );
}
