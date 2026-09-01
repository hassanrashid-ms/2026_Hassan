import { describe, expect, it } from 'vitest';
import { resolveTemplateBody } from './resolveTemplateBody.ts';

describe('resolveTemplateBody', () => {
  it('replaces {{agent_name}} with the given name', () => {
    expect(resolveTemplateBody('Hi, this is {{agent_name}}.', 'Sam')).toBe('Hi, this is Sam.');
  });

  it('replaces every occurrence', () => {
    expect(resolveTemplateBody('{{agent_name}} here. — {{agent_name}}', 'Sam')).toBe(
      'Sam here. — Sam',
    );
  });

  it('leaves text with no placeholder untouched', () => {
    expect(resolveTemplateBody('Thanks for reaching out!', 'Sam')).toBe('Thanks for reaching out!');
  });
});
