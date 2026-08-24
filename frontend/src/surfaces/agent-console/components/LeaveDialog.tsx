import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.tsx';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';

type LeaveDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentName: string;
  mode: 'set' | 'clear';
  onConfirm: (days?: number) => void;
};

/**
 * Shared confirm step for both setting and clearing leave — a status this
 * consequential (it overrides live presence workspace-wide) shouldn't change
 * on a single stray click.
 */
export function LeaveDialog({ open, onOpenChange, agentName, mode, onConfirm }: LeaveDialogProps) {
  const [days, setDays] = useState('');

  function handleConfirm() {
    const parsed = Number(days);
    onConfirm(mode === 'set' && days.trim() !== '' && parsed > 0 ? parsed : undefined);
    setDays('');
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode === 'set' ? `Set ${agentName} on leave?` : `Clear leave for ${agentName}?`}
          </DialogTitle>
          <DialogDescription>
            {mode === 'set'
              ? 'This overrides their live presence everywhere in the console until leave is cleared.'
              : 'They will show their live presence again instead of On Leave.'}
          </DialogDescription>
        </DialogHeader>
        {mode === 'set' && (
          <label className="flex flex-col gap-1 text-sm">
            Number of days (optional — leave blank for indefinite)
            <Input
              type="number"
              min={1}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              placeholder="Indefinite"
            />
          </label>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleConfirm}>{mode === 'set' ? 'Set on leave' : 'Clear leave'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
