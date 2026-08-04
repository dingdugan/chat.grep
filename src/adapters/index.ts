import type { Adapter } from '../types.js';
import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';

/** Adding a new tool = add one file here that implements Adapter, then register it.
 * Nothing outside src/adapters/ knows about tool-specific formats. */
export const adapters: Adapter[] = [claudeCodeAdapter, codexAdapter];

export function getAdapter(tool: string): Adapter | undefined {
  return adapters.find((a) => a.tool === tool);
}
