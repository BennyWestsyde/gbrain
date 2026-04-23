/**
 * Shared tool result helpers. OpenClaw's AgentToolResult requires
 * both `content` (text/image blocks) and `details` (structured data).
 */

export function textResult(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'text' as const, text }],
    details,
  };
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max).replace(/\s\S*$/, '') + '…';
}
