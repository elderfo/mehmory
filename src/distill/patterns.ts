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
 * `isMeta` records are hook-injected text (session-start context) that the user never
 * typed; distilling them would file the harness's own output as the user's memory.
 * Slash-command records are NOT flagged `isMeta` — `extractMessageText` unwraps those.
 */
function isUserMessage(record: Record<string, unknown>): boolean {
  if (record.isMeta === true) return false;
  if (record.type === 'user') return true;
  return record.type === 'message' && record.role === 'user';
}

/** Blocks the harness writes into a user turn: tag and content are both machine text. */
const NOISE_BLOCKS =
  /<(command-name|command-message|local-command-stdout|local-command-caveat|bash-input|bash-stdout|bash-stderr)>[\s\S]*?<\/\1>/g;

/** `<command-args>` is the exception — the arguments are what the user actually typed. */
const COMMAND_ARGS_TAGS = /<\/?command-args>/g;

/**
 * Strip the harness's slash-command envelope from a user turn.
 *
 * `/reload-plugins` echoes, `<local-command-stdout>` and `!`-mode bash blocks are the
 * harness talking to itself; filing them as memory produces wiki pages built from
 * command transcripts. The arguments are the exception — `/orchestrate <a whole project
 * brief>` puts real user intent inside `<command-args>`.
 *
 * Blocks are removed in place rather than the whole turn being discarded, because a
 * single record routinely carries both: a `/clear` echo followed by real prose the user
 * typed after it. Discarding on any envelope match would silently eat that prose — and
 * every turn merely quoting one of these tag names while discussing them.
 *
 * @returns the user-authored text, or null when nothing but harness text remains
 */
function stripCommandEnvelope(text: string): string | null {
  const stripped = text.replace(NOISE_BLOCKS, '').replace(COMMAND_ARGS_TAGS, '').trim();
  return stripped === '' ? null : stripped;
}

/**
 * Extract user-authored text content from a message record.
 *
 * Looks for common message text fields, then descends into the nested `message`
 * envelope Claude Code wraps real turns in, then strips slash-command wrappers.
 */
function extractMessageText(record: Record<string, unknown>): string | null {
  const text = extractRawText(record);
  return text === null ? null : stripCommandEnvelope(text);
}

/** The field-walking half of `extractMessageText`, before command unwrapping. */
function extractRawText(record: Record<string, unknown>): string | null {
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
    return extractRawText(record.message as Record<string, unknown>);
  }
  return null;
}
