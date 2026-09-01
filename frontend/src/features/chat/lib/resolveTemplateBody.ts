/**
 * The only placeholder canned replies support today, matching the {{...}}
 * syntax backend/src/domain/bot/defaultPrompt.ts already uses for bot-prompt
 * placeholders ({{subintents}}, {{articles}}, etc.) — kept consistent rather
 * than introducing a second syntax. Resolved client-side, never stored
 * resolved: the stored template body always keeps the literal placeholder.
 */
export function resolveTemplateBody(body: string, agentName: string): string {
  return body.replaceAll('{{agent_name}}', agentName);
}
