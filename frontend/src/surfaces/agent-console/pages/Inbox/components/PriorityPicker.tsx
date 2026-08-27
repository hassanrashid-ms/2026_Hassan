import { useState } from 'react';
import type { ConversationPriorityValue } from '@support/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { setConversationPriority } from '../../../api/agentApi.ts';
import { Badge } from '../../../components/ui/badge.tsx';
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from '../../../components/ui/command.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover.tsx';
import { PRIORITY_BADGE_VARIANT } from './ConversationRow.tsx';

const PRIORITIES: ConversationPriorityValue[] = ['p1', 'p2', 'p3', 'p4'];

export function PriorityPicker({
  token,
  conversationId,
  currentPriority,
}: {
  token: string;
  conversationId: string;
  currentPriority: ConversationPriorityValue;
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const setPriority = useMutation({
    mutationFn: (priority: ConversationPriorityValue) =>
      setConversationPriority(token, conversationId, priority),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'detail'] });
      void queryClient.invalidateQueries({ queryKey: ['tickets'] });
      void queryClient.invalidateQueries({ queryKey: ['tickets-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['inbox'] });
      void queryClient.invalidateQueries({ queryKey: ['global-inbox'] });
      setOpen(false);
    },
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Badge variant={PRIORITY_BADGE_VARIANT[currentPriority]} className="cursor-pointer">
          {currentPriority.toUpperCase()}
        </Badge>
      </PopoverTrigger>
      <PopoverContent className="p-0">
        <Command shouldFilter={false}>
          <CommandList>
            <CommandGroup>
              {PRIORITIES.map((p) => (
                <CommandItem key={p} value={p} onSelect={() => setPriority.mutate(p)}>
                  {p.toUpperCase()}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
