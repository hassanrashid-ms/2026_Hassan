import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchWorkspaceSettings,
  saveWorkspaceSettings,
  type WorkspaceSettingsView,
} from '../../api/agentApi.ts';
import { isAdmin, loadAgentSession } from '../../lib/agentSession.ts';
import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.tsx';

type FieldKey = keyof WorkspaceSettingsView;

const FIELDS: { key: FieldKey; label: string; min: number; max: number }[] = [
  { key: 'max_assigned_tickets', label: 'Max assigned tickets', min: 1, max: 100 },
  { key: 'auto_close_days', label: 'Auto-close days', min: 1, max: 365 },
  { key: 'inactivity_window_hours', label: 'Inactivity window (hours)', min: 1, max: 720 },
  { key: 'form_timeout_minutes', label: 'Form timeout (minutes)', min: 1, max: 1440 },
];

export function WorkspaceSettings() {
  const session = loadAgentSession();
  const queryClient = useQueryClient();
  const readOnly = !isAdmin(session);

  const settingsQuery = useQuery({
    queryKey: ['workspace-settings'],
    queryFn: () => fetchWorkspaceSettings(session!.token),
    enabled: session !== null,
  });

  const [form, setForm] = useState<WorkspaceSettingsView | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    if (settingsQuery.data) setForm(settingsQuery.data);
  }, [settingsQuery.data]);

  const save = useMutation({
    mutationFn: (patch: WorkspaceSettingsView) => saveWorkspaceSettings(session!.token, patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['workspace-settings'] }),
  });

  if (!session) return null;
  if (!form) return null;

  const errors: Partial<Record<FieldKey, string>> = {};
  for (const field of FIELDS) {
    const value = form[field.key];
    if (!Number.isInteger(value) || value < field.min || value > field.max) {
      errors[field.key] = `Must be a whole number between ${field.min} and ${field.max}`;
    }
  }
  const hasErrors = Object.keys(errors).length > 0;
  const isDirty = FIELDS.some((field) => form[field.key] !== settingsQuery.data?.[field.key]);

  const handleChange = (key: FieldKey, raw: string) => {
    const value = Number(raw);
    setForm({ ...form, [key]: Number.isNaN(value) ? 0 : value });
  };

  const handleSave = () => {
    if (hasErrors) return;
    setConfirmOpen(true);
  };

  const handleConfirmSave = () => {
    save.mutate(form, { onSuccess: () => setConfirmOpen(false) });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 p-3">
        <span className="text-sm font-semibold">Workspace Settings</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3">
        <div className="flex max-w-sm flex-col gap-3">
          {FIELDS.map((field) => (
            <div key={field.key} className="flex flex-col gap-1">
              <label htmlFor={field.key} className="text-xs font-medium text-muted">
                {field.label}
              </label>
              <Input
                id={field.key}
                type="number"
                min={field.min}
                max={field.max}
                value={form[field.key]}
                disabled={readOnly || save.isPending}
                onChange={(e) => handleChange(field.key, e.target.value)}
              />
              {errors[field.key] && <p className="text-xs text-red-600">{errors[field.key]}</p>}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            disabled={readOnly || hasErrors || !isDirty || save.isPending}
          >
            Save
          </Button>
          {readOnly && (
            <p className="text-xs text-muted">Only an admin can change workspace settings.</p>
          )}
        </div>
        {save.isError && <p className="text-xs text-red-600">{save.error?.message}</p>}
      </div>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Save workspace settings?"
        description="This changes ticket handling (assignment limits, auto-close, inactivity, and form timeout) for the whole workspace."
        confirmLabel="Save"
        confirming={save.isPending}
        onConfirm={handleConfirmSave}
      />
    </div>
  );
}
