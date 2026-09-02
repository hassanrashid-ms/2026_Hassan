import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FormDetail, FormField, IntentView } from '@support/types';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import {
  archiveForm,
  createForm,
  fetchForm,
  fetchIntents,
  publishForm,
  setFormSubintents,
  updateForm,
} from '../../../api/agentApi.ts';
import { isAdmin, type StoredAgentSession } from '../../../lib/agentSession.ts';
import {
  BUILDER_FIELD_TYPES,
  FIELD_TYPE_LABELS,
  canPublish,
  nextPosition,
  slugifyKey,
  renumberPositions,
  validateFields,
} from '../formForm.ts';
import { Badge } from '../../../components/ui/badge.tsx';
import { Button } from '../../../components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog.tsx';
import { Input } from '../../../components/ui/input.tsx';
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '../../../components/ui/sheet.tsx';
import { Skeleton } from '../../../components/ui/skeleton.tsx';
import { FormLivePreview } from './FormLivePreview.tsx';
import { ShownForPicker } from './ShownForPicker.tsx';

export function FormEditorSheet({
  token,
  session,
  formId,
  open,
  onOpenChange,
  onCreated,
}: {
  token: string;
  session: StoredAgentSession;
  formId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const intents = useQuery({ queryKey: ['admin-intents'], queryFn: () => fetchIntents(token) });
  const selected = useQuery({
    queryKey: ['admin-form', formId],
    queryFn: () => fetchForm(token, formId!),
    enabled: formId !== null,
  });

  const loading = (formId !== null && selected.isLoading) || intents.isLoading;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex flex-col gap-0 p-0 sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{formId ? 'Edit Form' : 'New Form'}</SheetTitle>
        </SheetHeader>

        {loading ? (
          <div
            className="flex min-h-0 flex-1 flex-col gap-4 p-4"
            data-testid="form-editor-skeleton"
          >
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="min-h-64 flex-1" />
          </div>
        ) : selected.isError ? (
          <div className="flex min-h-0 flex-1 flex-col items-start gap-3 p-4">
            <p className="text-sm text-muted">This form could not be loaded.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void selected.refetch()}
            >
              Retry
            </Button>
          </div>
        ) : (
          <FormEditorForm
            key={formId ?? 'new'}
            token={token}
            session={session}
            formId={formId}
            form={selected.data ?? null}
            intents={intents.data?.intents ?? []}
            onCreated={onCreated}
            onOpenChange={onOpenChange}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function FormEditorForm({
  token,
  session,
  formId,
  form,
  intents,
  onCreated,
  onOpenChange,
}: {
  token: string;
  session: StoredAgentSession;
  formId: string | null;
  form: FormDetail | null;
  intents: IntentView[];
  onCreated: (id: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const initialFields = form?.draft?.fields ?? form?.published?.fields ?? [];
  const [name, setName] = useState(form?.name ?? '');
  const [fields, setFields] = useState<FormField[]>(initialFields);
  const [shownFor, setShownFor] = useState<string[]>(form?.subintents.map((s) => s.id) ?? []);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [addingField, setAddingField] = useState(false);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);

  const errors = validateFields(fields);
  const admin = isAdmin(session);
  const archived = form?.archivedAt !== null && form?.archivedAt !== undefined;

  const invalidate = (id: string) => {
    void queryClient.invalidateQueries({ queryKey: ['admin-forms'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-form', id] });
  };

  const createMutation = useMutation({
    mutationFn: async () => {
      const created = await createForm(token, name);
      if (fields.length > 0) await updateForm(token, created.id, { fields });
      if (shownFor.length > 0) await setFormSubintents(token, created.id, shownFor);
      return created.id;
    },
    onSuccess: (id) => {
      invalidate(id);
      onCreated(id);
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      await updateForm(token, formId!, { name, fields });
      await setFormSubintents(token, formId!, shownFor);
    },
    onSuccess: () => invalidate(formId!),
  });

  const publishMutation = useMutation({
    mutationFn: () => publishForm(token, formId!),
    onSuccess: () => invalidate(formId!),
  });

  const archiveMutation = useMutation({
    mutationFn: () => archiveForm(token, formId!),
    onSuccess: () => {
      invalidate(formId!);
      setArchiveConfirmOpen(false);
    },
  });

  const addField = (type: (typeof BUILDER_FIELD_TYPES)[number]) => {
    const label = 'New question';
    const key = slugifyKey(
      label,
      fields.map((f) => f.key),
    );
    const next: FormField = {
      key,
      label,
      type,
      isRequired: false,
      position: nextPosition(fields),
      options: type === 'choice' ? ['Option 1', 'Option 2'] : undefined,
    };
    setFields([...fields, next]);
    setExpandedKey(key);
    setAddingField(false);
  };

  const removeField = (key: string) => {
    setFields(renumberPositions(fields.filter((f) => f.key !== key)));
    if (expandedKey === key) setExpandedKey(null);
  };

  const moveField = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= fields.length) return;
    const next = [...fields];
    const tmp = next[index]!;
    next[index] = next[target]!;
    next[target] = tmp;
    setFields(renumberPositions(next));
  };

  const updateFieldAt = (key: string, patch: Partial<FormField>) => {
    setFields(fields.map((f) => (f.key === key ? { ...f, ...patch } : f)));
  };

  const canSave = name.trim() !== '' && errors.length === 0 && !archived;
  const canPublishNow = admin && canPublish(form?.draft?.fields ?? []);

  return (
    <>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {archived && (
          <p className="rounded-md bg-amber-100 px-3 py-2 text-xs text-amber-900">
            This form is archived and can no longer be edited.
          </p>
        )}

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-muted">Name</label>
          <Input
            placeholder="Form name"
            value={name}
            disabled={archived}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-muted">Fields</label>
          </div>

          <div className="flex flex-col gap-2">
            {fields.map((field, index) => (
              <div key={field.key} className="rounded-card border border-slate-200 bg-surface p-2">
                <div className="flex items-center gap-2">
                  <Input
                    className="h-8"
                    value={field.label}
                    disabled={archived}
                    onChange={(e) => updateFieldAt(field.key, { label: e.target.value })}
                  />
                  <Badge variant="outline">
                    {FIELD_TYPE_LABELS[field.type as keyof typeof FIELD_TYPE_LABELS] ?? field.type}
                  </Badge>
                  <Button
                    type="button"
                    variant={field.isRequired ? 'secondary' : 'ghost'}
                    size="sm"
                    disabled={archived}
                    onClick={() => updateFieldAt(field.key, { isRequired: !field.isRequired })}
                  >
                    Required
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Move ${field.label} up`}
                    disabled={archived || index === 0}
                    onClick={() => moveField(index, -1)}
                  >
                    <ArrowUp className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Move ${field.label} down`}
                    disabled={archived || index === fields.length - 1}
                    onClick={() => moveField(index, 1)}
                  >
                    <ArrowDown className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${field.label}`}
                    disabled={archived}
                    onClick={() => removeField(field.key)}
                  >
                    <X className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    onClick={() => setExpandedKey(expandedKey === field.key ? null : field.key)}
                  >
                    {expandedKey === field.key ? 'Hide details' : 'Details'}
                  </Button>
                </div>

                {expandedKey === field.key && (
                  <div className="mt-2 flex flex-col gap-2 border-t border-slate-100 pt-2">
                    <Input
                      placeholder="Placeholder text"
                      value={field.placeholder ?? ''}
                      disabled={archived}
                      onChange={(e) =>
                        updateFieldAt(field.key, { placeholder: e.target.value || undefined })
                      }
                    />
                    <Input
                      placeholder="Helper text"
                      value={field.helperText ?? ''}
                      disabled={archived}
                      onChange={(e) =>
                        updateFieldAt(field.key, { helperText: e.target.value || undefined })
                      }
                    />
                    {field.type === 'choice' && (
                      <div className="flex flex-col gap-1.5">
                        <label className="text-xs font-medium text-muted">Options (min 2)</label>
                        {(field.options ?? []).map((option, optIndex) => (
                          <div key={optIndex} className="flex items-center gap-2">
                            <Input
                              className="h-8"
                              value={option}
                              disabled={archived}
                              onChange={(e) => {
                                const nextOptions = [...(field.options ?? [])];
                                nextOptions[optIndex] = e.target.value;
                                updateFieldAt(field.key, { options: nextOptions });
                              }}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={`Remove option ${optIndex + 1}`}
                              disabled={archived || (field.options?.length ?? 0) <= 2}
                              onClick={() => {
                                const nextOptions = (field.options ?? []).filter(
                                  (_, i) => i !== optIndex,
                                );
                                updateFieldAt(field.key, { options: nextOptions });
                              }}
                            >
                              <X className="size-4" />
                            </Button>
                          </div>
                        ))}
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={archived}
                          onClick={() =>
                            updateFieldAt(field.key, {
                              options: [
                                ...(field.options ?? []),
                                `Option ${(field.options?.length ?? 0) + 1}`,
                              ],
                            })
                          }
                        >
                          + Add option
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}

            <div className="rounded-card border border-dashed border-slate-200 p-2 opacity-60">
              <span className="text-sm">Skip and talk to an agent</span>
              <span className="ml-2 text-xs text-muted">(always present, cannot be removed)</span>
            </div>

            {addingField ? (
              <div className="flex flex-wrap gap-2">
                {BUILDER_FIELD_TYPES.map((type) => (
                  <Button
                    key={type}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => addField(type)}
                  >
                    {FIELD_TYPE_LABELS[type]}
                  </Button>
                ))}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setAddingField(false)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={archived}
                onClick={() => setAddingField(true)}
              >
                + Add a field
              </Button>
            )}
          </div>

          {errors.length > 0 && (
            <ul className="list-disc pl-4 text-xs text-red-700">
              {errors.map((error, i) => (
                <li key={i}>{error}</li>
              ))}
            </ul>
          )}
        </div>

        <ShownForPicker
          intents={intents}
          selected={shownFor}
          onChange={setShownFor}
          currentFormId={formId}
          disabled={archived}
        />
        </div>

        <div
          data-testid="form-live-preview-panel"
          className="w-[375px] shrink-0 overflow-y-auto border-l border-slate-200 p-4"
        >
          <FormLivePreview formName={name} fields={fields} />
        </div>
      </div>

      <SheetFooter className="flex-row justify-end gap-2 border-t border-slate-200">
        {formId === null ? (
          <Button
            type="button"
            onClick={() => createMutation.mutate()}
            disabled={!canSave || createMutation.isPending}
          >
            Create Form
          </Button>
        ) : (
          <>
            {admin && (
              <Button
                type="button"
                variant="outline"
                onClick={() => setArchiveConfirmOpen(true)}
                disabled={archived || archiveMutation.isPending}
              >
                Archive
              </Button>
            )}
            <Button
              type="button"
              variant="secondary"
              onClick={() => saveMutation.mutate()}
              disabled={!canSave || saveMutation.isPending}
            >
              Save
            </Button>
            {admin && (
              <Button
                type="button"
                onClick={() => publishMutation.mutate()}
                disabled={!canPublishNow || publishMutation.isPending}
              >
                Publish
              </Button>
            )}
          </>
        )}
      </SheetFooter>

      <Dialog open={archiveConfirmOpen} onOpenChange={setArchiveConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive this form?</DialogTitle>
            <DialogDescription>
              Subintents currently mapped to it will stop showing a form until re-mapped. This
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setArchiveConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                archiveMutation.mutate();
                onOpenChange(false);
              }}
              disabled={archiveMutation.isPending}
            >
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
