import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import { addMember, fetchMembers, updateMember } from '../../../api/adminApi.ts';
import { ApiError } from '../../../../../lib/httpClient.ts';
import { Badge } from '../../../components/ui/badge.tsx';
import { Button } from '../../../components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog.tsx';
import { Input } from '../../../components/ui/input.tsx';
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

function reportError(error: unknown) {
  toast.error(
    error instanceof ApiError ? error.message : 'Something went wrong. Please try again.',
  );
}

export function MembersTable({ token, workspaceId }: { token: string; workspaceId: string }) {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'agent' | 'team_lead'>('agent');
  const [removeTarget, setRemoveTarget] = useState<{ agentId: string; displayName: string } | null>(
    null,
  );

  const membersQuery = useQuery({
    queryKey: ['adminMembers', workspaceId],
    queryFn: () => fetchMembers(token, workspaceId),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['adminMembers', workspaceId] });

  const addMutation = useMutation({
    mutationFn: () => addMember(token, workspaceId, { email, role }),
    onSuccess: () => {
      invalidate();
      setAddOpen(false);
      setEmail('');
      setRole('agent');
    },
    onError: reportError,
  });

  const roleMutation = useMutation({
    mutationFn: (args: { agentId: string; role: 'agent' | 'team_lead' }) =>
      updateMember(token, workspaceId, args.agentId, { role: args.role }),
    onSuccess: invalidate,
    onError: reportError,
  });

  const removeMutation = useMutation({
    mutationFn: (agentId: string) => updateMember(token, workspaceId, agentId, { remove: true }),
    onSuccess: () => {
      invalidate();
      setRemoveTarget(null);
    },
    onError: reportError,
  });

  const members = membersQuery.data?.members ?? [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end">
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="size-4" />
          Add member
        </Button>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Status</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {membersQuery.isPending && (
            <TableRow>
              <TableCell colSpan={5} className="text-muted">
                Loading members…
              </TableCell>
            </TableRow>
          )}
          {membersQuery.isSuccess && members.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="text-muted">
                No members yet.
              </TableCell>
            </TableRow>
          )}
          {members.map((member) => (
            <TableRow key={member.agent_id}>
              <TableCell>{member.display_name}</TableCell>
              <TableCell className="text-muted">{member.email}</TableCell>
              <TableCell>
                <Select
                  value={member.role}
                  onValueChange={(value) =>
                    roleMutation.mutate({
                      agentId: member.agent_id,
                      role: value as 'agent' | 'team_lead',
                    })
                  }
                >
                  <SelectTrigger className="h-8 w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="agent">Agent</SelectItem>
                    <SelectItem value="team_lead">Team lead</SelectItem>
                  </SelectContent>
                </Select>
              </TableCell>
              <TableCell>
                {member.status === 'invited' ? (
                  <Badge variant="warning">Invited</Badge>
                ) : (
                  <Badge variant="secondary">{member.status}</Badge>
                )}
              </TableCell>
              <TableCell>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Remove access"
                  onClick={() =>
                    setRemoveTarget({ agentId: member.agent_id, displayName: member.display_name })
                  }
                >
                  <Trash2 className="size-4" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add member</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Input
              type="email"
              placeholder="agent@studio.test"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Select value={role} onValueChange={(value) => setRole(value as 'agent' | 'team_lead')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="agent">Agent</SelectItem>
                <SelectItem value="team_lead">Team lead</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!email.trim() || addMutation.isPending}
              onClick={() => addMutation.mutate()}
            >
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={removeTarget !== null} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove access?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted">
            {removeTarget?.displayName} will lose access to this workspace. This can be undone by
            adding them again.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={removeMutation.isPending}
              onClick={() => removeTarget && removeMutation.mutate(removeTarget.agentId)}
            >
              Remove access
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
