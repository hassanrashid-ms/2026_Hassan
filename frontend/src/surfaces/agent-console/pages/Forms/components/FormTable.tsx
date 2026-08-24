import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { EllipsisVertical } from 'lucide-react';
import { archiveForm, fetchForms } from '../../../api/agentApi.ts';
import { isAdmin, type StoredAgentSession } from '../../../lib/agentSession.ts';
import { formStatusLabel, formStatusVariant } from '../formForm.ts';
import { Badge } from '../../../components/ui/badge.tsx';
import { Button } from '../../../components/ui/button.tsx';
import { ConfirmDialog } from '../../../components/ConfirmDialog.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../components/ui/dropdown-menu.tsx';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../components/ui/table.tsx';
import { cn } from '../../../lib/cn.ts';

export function FormTable({
  token,
  session,
  selectedId,
  onSelect,
  onNew,
}: {
  token: string;
  session: StoredAgentSession;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const queryClient = useQueryClient();
  const forms = useQuery({ queryKey: ['admin-forms'], queryFn: () => fetchForms(token) });
  const canArchive = isAdmin(session);
  const [archiveTarget, setArchiveTarget] = useState<{ id: string; name: string } | null>(null);
  const [archiving, setArchiving] = useState(false);

  const onArchive = async (id: string) => {
    setArchiving(true);
    try {
      await archiveForm(token, id);
      void queryClient.invalidateQueries({ queryKey: ['admin-forms'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-form', id] });
      setArchiveTarget(null);
    } finally {
      setArchiving(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 p-3">
        <span className="text-sm font-semibold">Forms</span>
        <Button type="button" size="sm" onClick={onNew}>
          + New
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Shown for</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {forms.data?.forms.map((form) => (
              <TableRow
                key={form.id}
                onClick={() => onSelect(form.id)}
                className={cn('cursor-pointer', selectedId === form.id && 'bg-accent-soft')}
              >
                <TableCell className="font-medium">{form.name}</TableCell>
                <TableCell>
                  {form.mappedSubintentCount > 0 ? (
                    <Badge variant="secondary">
                      {form.mappedSubintentCount} subintent
                      {form.mappedSubintentCount === 1 ? '' : 's'}
                    </Badge>
                  ) : (
                    <span className="text-xs text-muted">Not shown</span>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={formStatusVariant(form)}>{formStatusLabel(form)}</Badge>
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  {canArchive && form.archivedAt === null && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Actions for ${form.name}`}
                        >
                          <EllipsisVertical className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => setArchiveTarget({ id: form.id, name: form.name })}
                        >
                          Archive
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ConfirmDialog
        open={archiveTarget !== null}
        onOpenChange={(open) => !open && setArchiveTarget(null)}
        title="Archive this form?"
        description={
          archiveTarget
            ? `"${archiveTarget.name}" will be archived and stop being usable in new conversations.`
            : undefined
        }
        confirmLabel="Archive"
        variant="destructive"
        confirming={archiving}
        onConfirm={() => archiveTarget && void onArchive(archiveTarget.id)}
      />
    </div>
  );
}
