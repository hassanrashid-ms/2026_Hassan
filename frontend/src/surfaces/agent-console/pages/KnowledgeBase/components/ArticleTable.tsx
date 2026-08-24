import { useQuery } from '@tanstack/react-query';
import type { ArticleStateValue } from '@support/types';
import { fetchArticles } from '../../../api/agentApi.ts';
import { Badge } from '../../../components/ui/badge.tsx';
import { Button } from '../../../components/ui/button.tsx';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../components/ui/table.tsx';
import { cn } from '../../../lib/cn.ts';

const STATE_BADGE_VARIANT: Record<ArticleStateValue, 'secondary' | 'success' | 'outline'> = {
  draft: 'secondary',
  published: 'success',
  archived: 'outline',
};

export function ArticleTable({
  token,
  selectedId,
  onSelect,
  onNew,
}: {
  token: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const articles = useQuery({ queryKey: ['admin-articles'], queryFn: () => fetchArticles(token) });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 p-3">
        <span className="text-sm font-semibold">Articles</span>
        <Button type="button" size="sm" onClick={onNew}>
          + New
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {articles.data?.articles.map((a) => (
              <TableRow
                key={a.id}
                onClick={() => onSelect(a.id)}
                className={cn('cursor-pointer', selectedId === a.id && 'bg-accent-soft')}
              >
                {/* max-w-0 + w-full lets the cell shrink below its content's natural
                    width in an auto-layout table — without it, `truncate` alone has no
                    bound to clip against, and a long title wraps character-by-character
                    once the sheet next to it eats most of the available width. */}
                <TableCell className="max-w-0 w-full truncate font-medium" title={a.title}>
                  {a.title}
                </TableCell>
                <TableCell>
                  <Badge variant={STATE_BADGE_VARIANT[a.state]}>{a.state}</Badge>
                </TableCell>
                <TableCell className="text-muted">
                  {new Date(a.published_at ?? a.created_at).toLocaleDateString()}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
