import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { renameWorkspace, type WorkspaceSummary } from '../../../api/adminApi.ts'
import { loadAdminSession } from '../../../lib/adminSession.ts'
import { Button } from '../../../components/ui/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog.tsx'
import { Input } from '../../../components/ui/input.tsx'

export function RenameWorkspaceDialog({
  workspace,
  onOpenChange,
}: {
  workspace: WorkspaceSummary | null
  onOpenChange: (open: boolean) => void
}) {
  const session = loadAdminSession()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')

  useEffect(() => {
    if (workspace) setName(workspace.name)
  }, [workspace])

  const rename = useMutation({
    mutationFn: () => renameWorkspace(session!.token, workspace!.id, name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['adminWorkspaces'] })
      onOpenChange(false)
    },
  })

  return (
    <Dialog open={workspace !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename workspace</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="rename-workspace-name" className="text-sm font-medium">
            Name
          </label>
          <Input id="rename-workspace-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => rename.mutate()} disabled={rename.isPending || !name.trim()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
