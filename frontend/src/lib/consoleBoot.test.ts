import { describe, expect, it } from 'vitest';
import { readConsoleBoot } from './consoleBoot.ts';

describe('readConsoleBoot', () => {
  it('reads workspace/agent/name from the query and the token from the fragment', () => {
    const boot = readConsoleBoot({
      search: '?workspace=ws-1&agentId=agent-1&name=Ada%20Lovelace',
      hash: '#t=jwt.value.here',
    });
    expect(boot).toEqual({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      displayName: 'Ada Lovelace',
      token: 'jwt.value.here',
    });
  });

  it('returns null when any required field is missing', () => {
    expect(readConsoleBoot({ search: '?agentId=a&name=Ada', hash: '#t=jwt' })).toBeNull();
    expect(readConsoleBoot({ search: '?workspace=w&name=Ada', hash: '#t=jwt' })).toBeNull();
    expect(readConsoleBoot({ search: '?workspace=w&agentId=a', hash: '#t=jwt' })).toBeNull();
    expect(readConsoleBoot({ search: '?workspace=w&agentId=a&name=Ada', hash: '' })).toBeNull();
  });

  it('tolerates extra fragment and query parameters', () => {
    const boot = readConsoleBoot({
      search: '?workspace=w&agentId=a&name=Ada&debug=1',
      hash: '#t=jwt&other=1',
    });
    expect(boot?.token).toBe('jwt');
    expect(boot?.workspaceId).toBe('w');
  });
});
