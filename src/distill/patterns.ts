/**
 * Enumerated distill patterns for extracting actionable content from transcripts.
 *
 * Each pattern identifies a message or exchange type from the transcript that should
 * be captured into the inbox. Patterns are matched against the transcript records.
 *
 * A7 (ADR): These patterns are normative — they define what "decision marker" and
 * "correction pattern" mean in executable terms. Prose descriptions are secondary.
 */

/** Distilled entry extracted from a transcript pattern. */
export interface DistilledEntry {
  /** Stable ID: sha256(sessionId + record.uuid). */
  id: string;
  /** Pattern name (e.g., 'user_message', 'decision_marker'). */
  pattern: string;
  /** The extracted content. */
  content: string;
  /** Source record reference: sessionId, record uuid, record type, line number. */
  source: {
    sessionId: string;
    recordUuid?: string;
    recordType?: string;
    lineNumber?: number;
  };
}

/** Pattern matcher: identifies records matching this pattern. */
export interface Pattern {
  /** Stable pattern identifier. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Test whether this record matches the pattern. */
  matches: (record: Record<string, unknown>) => boolean;
  /** Extract content from a matching record. */
  extract: (record: Record<string, unknown>) => string | null;
}

/**
 * Enumerated distill patterns.
 *
 * Order matters for precedence: patterns are tested in order, and the first match wins.
 * A record can only produce one distilled entry (most specific pattern first).
 */
export const DISTILL_PATTERNS: Pattern[] = [
  {
    name: 'decision_marker',
    description: 'A user message containing explicit decision language',
    matches: (rec: Record<string, unknown>) => {
      // A decision marker is a user message that contains decision keywords.
      if (!isUserMessage(rec)) {
        return false;
      }
      const text = extractMessageText(rec);
      if (!text) return false;
      // ponytail: simple keyword matching; ceiling: misses implicit decisions, catches false positives. Upgrade: domain-specific classifier or probabilistic model.
      return /\b(decide|decision|chosen|choosing|will|let's)\b/i.test(text);
    },
    extract: (record: Record<string, unknown>) => {
      const text = extractMessageText(record);
      return text
        ? `Decision: ${text.slice(0, 500)}${text.length > 500 ? '...' : ''}`
        : null;
    },
  },

  {
    name: 'error_resolution',
    description: 'A user message addressing or resolving an error',
    matches: (record: Record<string, unknown>) => {
      if (!isUserMessage(record)) {
        return false;
      }
      const text = extractMessageText(record);
      if (!text) return false;
      // Error-related keywords; more specific than correction_pattern.
      return /\b(error|failed|broken|issue|problem|bug|crash)\b/i.test(text);
    },
    extract: (record: Record<string, unknown>) => {
      const text = extractMessageText(record);
      return text
        ? `Error resolution: ${text.slice(0, 500)}${text.length > 500 ? '...' : ''}`
        : null;
    },
  },

  {
    name: 'correction_pattern',
    description: 'A user correction or clarification of a previous assistant output',
    matches: (record: Record<string, unknown>) => {
      if (!isUserMessage(record)) {
        return false;
      }
      const text = extractMessageText(record);
      if (!text) return false;
      // Matches words indicating contradiction or revision (not, wrong, fix, undo, revert, etc.).
      return /\b(not|wrong|incorrect|should|didn't|fix|undo|revert|actually|rather|instead)\b/i.test(
        text
      );
    },
    extract: (record: Record<string, unknown>) => {
      const text = extractMessageText(record);
      return text
        ? `Correction: ${text.slice(0, 500)}${text.length > 500 ? '...' : ''}`
        : null;
    },
  },

  {
    name: 'user_message',
    description: 'A direct user message to capture',
    matches: (record: Record<string, unknown>) => isUserMessage(record),
    extract: (record: Record<string, unknown>) => {
      const text = extractMessageText(record);
      return text ? text.slice(0, 500) + (text.length > 500 ? '...' : '') : null;
    },
  },
];

/**
 * Is this record a user turn?
 *
 * Claude Code writes `{type: 'user', message: {role: 'user', content}}` — the record
 * type IS the role and the payload is nested. The flat `{type: 'message', role: 'user'}`
 * shape is also accepted because the fixtures and the hook-side callers use it.
 *
 * `isMeta` records are hook- and command-injected text (session-start context, slash
 * command stdout) that the user never typed; distilling them would file the harness's
 * own output as the user's memory.
 */
function isUserMessage(record: Record<string, unknown>): boolean {
  if (record.isMeta === true) return false;
  if (record.type === 'user') return true;
  return record.type === 'message' && record.role === 'user';
}

/**
 * Extract text content from a message record.
 *
 * Looks for common message text fields, then descends into the nested `message`
 * envelope Claude Code wraps real turns in.
 */
function extractMessageText(record: Record<string, unknown>): string | null {
  if (typeof record.text === 'string') {
    return record.text;
  }
  if (typeof record.content === 'string') {
    return record.content;
  }
  if (typeof record.message === 'string') {
    return record.message;
  }
  // Check for content array (standard ChatML structure).
  if (Array.isArray(record.content)) {
    const textBlocks: string[] = [];
    for (const block of record.content as unknown[]) {
      if (typeof block === 'object' && block !== null) {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') {
          textBlocks.push(b.text);
        }
      }
    }
    return textBlocks.length > 0 ? textBlocks.join('\n') : null;
  }
  // Claude Code's real shape: the turn lives one level down under `message`.
  if (typeof record.message === 'object' && record.message !== null) {
    return extractMessageText(record.message as Record<string, unknown>);
  }
  return null;
}
