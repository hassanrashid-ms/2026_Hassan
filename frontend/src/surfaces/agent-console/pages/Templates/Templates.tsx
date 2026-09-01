import { useRef, useState } from 'react';
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
import { Textarea } from '../../components/ui/textarea.tsx';
import { Card, CardContent, CardFooter, CardHeader } from '../../components/ui/card.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.tsx';

const SYSTEM_LABELS: Record<SystemMessageKey, string> = {
  no_agents_online: 'No agents online',
  handoff: 'Handoff',
  form_summary_completed: 'Form completed',
  form_summary_partial: 'Form partially answered',
  form_summary_skipped: 'Form skipped',
};

/** Same {{...}} syntax as the bot prompt's placeholders (PromptTab.tsx) — the
 * only one canned replies resolve today, client-side at insert time. */
const CANNED_PLACEHOLDERS = [{ tag: '{{agent_name}}', desc: "the sending agent's display name" }];

function insertAtCursor(
  el: HTMLTextAreaElement | null,
  value: string,
  setValue: (next: string) => void,
  insert: string,
) {
  if (!el) {
    setValue(value + insert);
    return;
  }
  const start = el.selectionStart ?? value.length;
  const end = el.selectionEnd ?? value.length;
  setValue(value.slice(0, start) + insert + value.slice(end));
  requestAnimationFrame(() => {
    el.focus();
    const pos = start + insert.length;
    el.setSelectionRange(pos, pos);
  });
}

function PlaceholderChips({
  onInsert,
  disabled,
}: {
  onInsert: (tag: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {CANNED_PLACEHOLDERS.map((p) => (
        <button
          key={p.tag}
          type="button"
          disabled={disabled}
          onClick={() => onInsert(p.tag)}
          title={p.desc}
          className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-slate-700 hover:bg-slate-200 disabled:pointer-events-none disabled:opacity-50"
        >
          {p.tag}
        </button>
      ))}
      <span className="text-[10px] text-muted">click to insert</span>
    </div>
  );
}

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

  const addSystemVariant = useMutation({
    mutationFn: ({ key, body }: { key: SystemMessageKey; body: string }) =>
      createTemplate(session!.token, { kind: 'system', key, body }),
    onSuccess: invalidate,
  });

  const updateSystemVariant = useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) =>
      updateTemplate(session!.token, id, { body }),
    onSuccess: invalidate,
  });

  const removeSystemVariant = useMutation({
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
      <Tabs defaultValue="system" className="min-h-0 min-w-0 flex-1 gap-0 p-3">
        <TabsList>
          <TabsTrigger value="system">System Messages</TabsTrigger>
          <TabsTrigger value="canned">Canned Replies</TabsTrigger>
        </TabsList>

        <TabsContent value="system" className="min-h-0 overflow-auto pt-3">
          <div className="flex flex-col gap-4">
            {(Object.keys(SYSTEM_LABELS) as SystemMessageKey[]).map((key) => (
              <VariantListEditor
                key={key}
                label={SYSTEM_LABELS[key]}
                hint={
                  key === 'handoff'
                    ? 'Picked at random — leave empty to use the built-in defaults'
                    : undefined
                }
                variants={data.system[key]}
                readOnly={readOnly}
                onAdd={(body) => addSystemVariant.mutate({ key, body })}
                onUpdate={(id, body) => updateSystemVariant.mutate({ id, body })}
                onRemove={(id) => removeSystemVariant.mutate(id)}
              />
            ))}
          </div>
        </TabsContent>

        <TabsContent value="canned" className="min-h-0 overflow-auto pt-3">
          <div className="flex flex-col gap-3">
            {data.canned.map((reply) => (
              <CannedReplyCard
                key={reply.id}
                reply={reply}
                readOnly={readOnly}
                onUpdate={(label, body) => updateCannedReply.mutate({ id: reply.id, label, body })}
                onRemove={() => removeCannedReply.mutate(reply.id)}
              />
            ))}
            {!readOnly && (
              <NewCannedReplyCard onAdd={(label, body) => addCannedReply.mutate({ label, body })} />
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function VariantListEditor({
  label,
  hint,
  variants,
  readOnly,
  onAdd,
  onUpdate,
  onRemove,
}: {
  label: string;
  hint?: string;
  variants: { id: string | null; body: string }[];
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
        {label}
        {hint ? ` (${hint})` : ''}
      </label>
      {/* Indented under the label so the variant list reads as a sub-list,
          distinguishable from the other message rows around it. */}
      <div className="flex flex-col gap-2 pl-4">
        {variants.map((variant, index) => {
          const draftKey = variant.id ?? `default-${index}`;
          const value = drafts[draftKey] ?? variant.body;
          const dirty = value !== variant.body;
          return (
            <div key={draftKey} className="flex gap-2">
              <Input
                value={value}
                disabled={readOnly}
                onChange={(e) => setDrafts({ ...drafts, [draftKey]: e.target.value })}
              />
              <Button
                type="button"
                size="sm"
                disabled={readOnly || !dirty}
                onClick={() => (variant.id ? onUpdate(variant.id, value) : onAdd(value))}
              >
                Save
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={readOnly || variant.id === null}
                title={variant.id === null ? 'Built-in default — nothing to remove yet' : undefined}
                onClick={() => variant.id && onRemove(variant.id)}
              >
                Remove
              </Button>
            </div>
          );
        })}
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
    </div>
  );
}

function CannedReplyCard({
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
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const dirty = label !== reply.label || body !== reply.body;
  return (
    <Card>
      <CardHeader className="pb-2">
        <Input
          className="max-w-64 border-none px-0 text-sm font-semibold shadow-none focus-visible:ring-0"
          value={label}
          disabled={readOnly}
          placeholder="Label, e.g. Intro"
          onChange={(e) => setLabel(e.target.value)}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-2 pt-0">
        <PlaceholderChips
          disabled={readOnly}
          onInsert={(tag) => insertAtCursor(bodyRef.current, body, setBody, tag)}
        />
        <Textarea
          ref={bodyRef}
          value={body}
          disabled={readOnly}
          onChange={(e) => setBody(e.target.value)}
          className="min-h-20 text-sm"
        />
      </CardContent>
      <CardFooter className="justify-end gap-2 pt-0">
        <Button type="button" size="sm" variant="outline" disabled={readOnly} onClick={onRemove}>
          Remove
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={readOnly || !dirty || !label.trim() || !body.trim()}
          onClick={() => onUpdate(label.trim(), body.trim())}
        >
          Save
        </Button>
      </CardFooter>
    </Card>
  );
}

function NewCannedReplyCard({ onAdd }: { onAdd: (label: string, body: string) => void }) {
  const [label, setLabel] = useState('');
  const [body, setBody] = useState('');
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  return (
    <Card className="border-dashed">
      <CardHeader className="pb-2">
        <Input
          className="max-w-64 border-none px-0 text-sm font-semibold shadow-none focus-visible:ring-0"
          placeholder="Label, e.g. Intro"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-2 pt-0">
        <PlaceholderChips
          disabled={false}
          onInsert={(tag) => insertAtCursor(bodyRef.current, body, setBody, tag)}
        />
        <Textarea
          ref={bodyRef}
          placeholder="Hi, this is {{agent_name}}! How can I help?"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="min-h-20 text-sm"
        />
      </CardContent>
      <CardFooter className="justify-end pt-0">
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
      </CardFooter>
    </Card>
  );
}
