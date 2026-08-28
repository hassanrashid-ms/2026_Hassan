import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, RefreshCw } from 'lucide-react';
import { fetchSecrets, rotateSecret } from '../../../api/adminApi.ts';
import { ApiError } from '../../../../../lib/httpClient.ts';
import { Badge } from '../../../components/ui/badge.tsx';
import { Button } from '../../../components/ui/button.tsx';
import { ConfirmDialog } from '../../../components/ConfirmDialog.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog.tsx';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../components/ui/table.tsx';

function reportError(error: unknown) {
  toast.error(
    error instanceof ApiError ? error.message : 'Something went wrong. Please try again.',
  );
}

export function SecretPanel({ token, workspaceId }: { token: string; workspaceId: string }) {
  const queryClient = useQueryClient();
  const [revealed, setRevealed] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const secretsQuery = useQuery({
    queryKey: ['adminSecrets', workspaceId],
    queryFn: () => fetchSecrets(token, workspaceId),
  });

  const rotateMutation = useMutation({
    mutationFn: () => rotateSecret(token, workspaceId),
    onSuccess: (result) => {
      setConfirmOpen(false);
      setRevealed(result.secret);
      queryClient.invalidateQueries({ queryKey: ['adminSecrets', workspaceId] });
    },
    onError: reportError,
  });

  const secrets = secretsQuery.data?.secrets ?? [];

  const copy = async () => {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed);
      toast.success('Copied to clipboard.');
    } catch {
      toast.error('Could not copy — select and copy the secret manually.');
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">
          Rotating inserts a new secret immediately. The previous one keeps working for a 24-hour
          grace window so a game studio can redeploy without an outage.
        </p>
        <Button size="sm" disabled={rotateMutation.isPending} onClick={() => setConfirmOpen(true)}>
          <RefreshCw className="size-4" />
          Rotate secret
        </Button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        variant="destructive"
        title="Rotate this workspace's secret?"
        description="The old secret keeps working for a 24-hour grace window only. Every deployment of this game's backend using the old secret must be updated before it expires, or player-token minting will break."
        confirmLabel="Rotate secret"
        confirming={rotateMutation.isPending}
        onConfirm={() => rotateMutation.mutate()}
      />

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Created</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {secretsQuery.isPending && (
            <TableRow>
              <TableCell colSpan={2} className="text-muted">
                Loading…
              </TableCell>
            </TableRow>
          )}
          {secretsQuery.isSuccess && secrets.length === 0 && (
            <TableRow>
              <TableCell colSpan={2} className="text-muted">
                No secret yet — rotate to create one.
              </TableCell>
            </TableRow>
          )}
          {secrets.map((secret) => (
            <TableRow key={secret.created_at}>
              <TableCell>{new Date(secret.created_at).toLocaleString()}</TableCell>
              <TableCell>
                {secret.expires_at ? (
                  <Badge variant="warning">
                    Expires {new Date(secret.expires_at).toLocaleString()}
                  </Badge>
                ) : (
                  <Badge variant="success">Active</Badge>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Dialog open={revealed !== null} onOpenChange={(open) => !open && setRevealed(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New secret</DialogTitle>
            <DialogDescription>
              This is shown once. Lost secrets cannot be recovered — rotate again if this is lost.
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-w-0 items-center gap-2 rounded-md border border-zinc-200 bg-surface p-3">
            {/* min-w-0 on both this row and the code element itself: a flex item
                defaults to a min-width equal to its content's intrinsic width, so
                without it a long secret forces the row (and the dialog) wider
                instead of scrolling inside overflow-x-auto — the secret then
                visibly ran past the dialog's edge. */}
            <code className="min-w-0 flex-1 overflow-x-auto font-mono text-sm select-all">
              {revealed}
            </code>
            <Button variant="outline" size="icon" aria-label="Copy secret" onClick={copy}>
              <Copy className="size-4" />
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setRevealed(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
