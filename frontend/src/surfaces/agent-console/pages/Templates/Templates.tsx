import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createTemplate,
  fetchTemplates,
  updateTemplate,
  type SystemMessageKey,
  type TemplatesAdminView,
} from '../../api/agentApi.ts';
import { isAdmin, loadAgentSession } from '../../lib/agentSession.ts';
import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';

const SYSTEM_LABELS: Record<SystemMessageKey, string> = {
  no_agents_online: 'No agents online',
  form_summary_completed: 'Form completed',
  form_summary_partial: 'Form partially answered',
  form_summary_skipped: 'Form skipped',
};

export function Templates() {
  const session = loadAgentSession();
  const queryClient = useQueryClient();
  const readOnly = !isAdmin(session);

  const templatesQuery = useQuery({
    queryKey: ['templates'],
    queryFn: () => fetchTemplates(session!.token),
    enabled: session !== null,
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['templates'] });

  const saveSystem = useMutation({
    mutationFn: ({ id, key, body }: { id: string | null; key: SystemMessageKey; body: string }) =>
      id
        ? updateTemplate(session!.token, id, { body })
        : createTemplate(session!.token, { kind: 'system', key, body }),
    onSuccess: invalidate,
  });

  const addHandoffVariant = useMutation({
    mutationFn: (body: string) =>
      createTemplate(session!.token, { kind: 'system', key: 'handoff', body }),
    onSuccess: invalidate,
  });

  const updateHandoffVariant = useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) =>
      updateTemplate(session!.token, id, { body }),
    onSuccess: invalidate,
  });

  const removeHandoffVariant = useMutation({
    mutationFn: (id: string) => updateTemplate(session!.token, id, { isActive: false }),
    onSuccess: invalidate,
  });

  const addCannedReply = useMutation({
    mutationFn: ({ label, body }: { label: string; body: string }) =>
      createTemplate(session!.token, { kind: 'canned', label, body }),
    onSuccess: invalidate,
  });

  const updateCannedReply = useMutation({
    mutationFn: ({ id, label, body }: { id: string; label: string; body: string }) =>
      updateTemplate(session!.token, id, { label, body }),
    onSuccess: invalidate,
  });

  const removeCannedReply = useMutation({
    mutationFn: (id: string) => updateTemplate(session!.token, id, { isActive: false }),
    onSuccess: invalidate,
  });

  if (!session) return null;
  if (!templatesQuery.data) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted">
        {templatesQuery.isError ? 'Could not load templates.' : 'Loading…'}
      </div>
    );
  }

  const data: TemplatesAdminView = templatesQuery.data;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 p-3">
        <span className="text-sm font-semibold">Templates</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-3">
        <section className="flex flex-col gap-3">
          <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
            System Messages
          </h3>
          {(Object.keys(SYSTEM_LABELS) as SystemMessageKey[]).map((key) => (
            <SystemMessageEditor
              key={key}
              label={SYSTEM_LABELS[key]}
              row={data.system[key]}
              readOnly={readOnly}
              onSave={(body) => saveSystem.mutate({ id: data.system[key].id, key, body })}
            />
          ))}
          <HandoffEditor
            variants={data.system.handoff}
            readOnly={readOnly}
            onAdd={(body) => addHandoffVariant.mutate(body)}
            onUpdate={(id, body) => updateHandoffVariant.mutate({ id, body })}
            onRemove={(id) => removeHandoffVariant.mutate(id)}
          />
        </section>
        <section className="flex flex-col gap-3">
          <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
            Canned Replies
          </h3>
          {data.canned.map((reply) => (
            <CannedReplyEditor
              key={reply.id}
              reply={reply}
              readOnly={readOnly}
              onUpdate={(label, body) => updateCannedReply.mutate({ id: reply.id, label, body })}
              onRemove={() => removeCannedReply.mutate(reply.id)}
            />
          ))}
          {!readOnly && (
            <NewCannedReplyForm
              onAdd={(label, body) => addCannedReply.mutate({ label, body })}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function SystemMessageEditor({
  label,
  row,
  readOnly,
  onSave,
}: {
  label: string;
  row: { id: string | null; body: string };
  readOnly: boolean;
  onSave: (body: string) => void;
}) {
  const [value, setValue] = useState(row.body);
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-muted">{label}</label>
      <div className="flex gap-2">
        <Input value={value} disabled={readOnly} onChange={(e) => setValue(e.target.value)} />
        <Button
          type="button"
          size="sm"
          disabled={readOnly || value === row.body}
          onClick={() => onSave(value)}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

function HandoffEditor({
  variants,
  readOnly,
  onAdd,
  onUpdate,
  onRemove,
}: {
  variants: { id: string; body: string }[];
  readOnly: boolean;
  onAdd: (body: string) => void;
  onUpdate: (id: string, body: string) => void;
  onRemove: (id: string) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newVariant, setNewVariant] = useState('');
  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-medium text-muted">
        Handoff (picked at random — leave empty to use the built-in defaults)
      </label>
      {variants.map((variant) => (
        <div key={variant.id} className="flex gap-2">
          <Input
            value={drafts[variant.id] ?? variant.body}
            disabled={readOnly}
            onChange={(e) => setDrafts({ ...drafts, [variant.id]: e.target.value })}
          />
          <Button
            type="button"
            size="sm"
            disabled={readOnly || (drafts[variant.id] ?? variant.body) === variant.body}
            onClick={() => onUpdate(variant.id, drafts[variant.id] ?? variant.body)}
          >
            Save
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={readOnly} onClick={() => onRemove(variant.id)}>
            Remove
          </Button>
        </div>
      ))}
      {!readOnly && (
        <div className="flex gap-2">
          <Input
            placeholder="Add a variant…"
            value={newVariant}
            onChange={(e) => setNewVariant(e.target.value)}
          />
          <Button
            type="button"
            size="sm"
            disabled={newVariant.trim().length === 0}
            onClick={() => {
              onAdd(newVariant.trim());
              setNewVariant('');
            }}
          >
            Add
          </Button>
        </div>
      )}
    </div>
  );
}

function CannedReplyEditor({
  reply,
  readOnly,
  onUpdate,
  onRemove,
}: {
  reply: { id: string; label: string; body: string };
  readOnly: boolean;
  onUpdate: (label: string, body: string) => void;
  onRemove: () => void;
}) {
  const [label, setLabel] = useState(reply.label);
  const [body, setBody] = useState(reply.body);
  const dirty = label !== reply.label || body !== reply.body;
  return (
    <div className="flex flex-col gap-1 rounded-md border border-muted/20 p-2">
      <div className="flex gap-2">
        <Input
          className="max-w-48"
          value={label}
          disabled={readOnly}
          onChange={(e) => setLabel(e.target.value)}
        />
        <Input value={body} disabled={readOnly} onChange={(e) => setBody(e.target.value)} />
      </div>
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={readOnly || !dirty} onClick={() => onUpdate(label, body)}>
          Save
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={readOnly} onClick={onRemove}>
          Remove
        </Button>
      </div>
    </div>
  );
}

function NewCannedReplyForm({ onAdd }: { onAdd: (label: string, body: string) => void }) {
  const [label, setLabel] = useState('');
  const [body, setBody] = useState('');
  return (
    <div className="flex flex-col gap-1 rounded-md border border-dashed border-muted/40 p-2">
      <div className="flex gap-2">
        <Input
          className="max-w-48"
          placeholder="Label, e.g. Intro"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <Input
          placeholder="Body — use {{agent_name}} for the agent's name"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>
      <Button
        type="button"
        size="sm"
        disabled={label.trim().length === 0 || body.trim().length === 0}
        onClick={() => {
          onAdd(label.trim(), body.trim());
          setLabel('');
          setBody('');
        }}
      >
        Add canned reply
      </Button>
    </div>
  );
}
