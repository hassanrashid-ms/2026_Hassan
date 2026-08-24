import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createWorkspace } from '../../../api/adminApi.ts'
import { loadAdminSession } from '../../../lib/adminSession.ts'
import { Button } from '../../../components/ui/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../../../components/ui/dialog.tsx'
import { Input } from '../../../components/ui/input.tsx'

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
}

export function CreateWorkspaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const session = loadAdminSession()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)

  const reset = () => {
    setName('')
    setSlug('')
    setSlugTouched(false)
  }

  const create = useMutation({
    mutationFn: () => createWorkspace(session!.token, { name, slug }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['adminWorkspaces'] })
      reset()
      onOpenChange(false)
    },
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create workspace</DialogTitle>
          <DialogDescription>The slug is used in SDK requests and is immutable once created.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="workspace-name" className="text-sm font-medium">
              Name
            </label>
            <Input
              id="workspace-name"
              value={name}
              onChange={(e) => {
                const next = e.target.value
                setName(next)
                if (!slugTouched) setSlug(slugify(next))
              }}
              placeholder="Demo Game"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="workspace-slug" className="text-sm font-medium">
              Slug
            </label>
            <Input
              id="workspace-slug"
              value={slug}
              onChange={(e) => {
                setSlugTouched(true)
                setSlug(e.target.value)
              }}
              placeholder="demo-game"
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => create.mutate()}
            disabled={create.isPending || !name.trim() || !slug.trim()}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
