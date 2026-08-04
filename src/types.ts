/** Unified intermediate format. Everything downstream of adapters
 * (indexing, search, distill, export) depends ONLY on these types. */

export interface UnifiedMessage {
  role: 'user' | 'assistant';
  text: string;
  /** ISO 8601, null when the source line carries no timestamp */
  timestamp: string | null;
}

export interface UnifiedSession {
  /** adapter id, e.g. 'claude-code' | 'codex' */
  tool: string;
  /** tool-native session id */
  sessionId: string;
  /** absolute path of the source file */
  sourcePath: string;
  cwd: string | null;
  title: string | null;
  startedAt: string | null;
  endedAt: string | null;
  messages: UnifiedMessage[];
  /** count of lines skipped due to parse errors */
  warnings: number;
}

export interface SourceFile {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface Adapter {
  /** stable id used in db + CLI filters */
  tool: string;
  /** human-readable name for logs */
  displayName: string;
  /** list candidate session files on this machine (missing dirs => []) */
  discover(): SourceFile[];
  /** parse one file into the unified format; null = not a usable session */
  parse(filePath: string): UnifiedSession | null;
}
