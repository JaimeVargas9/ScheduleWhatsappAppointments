import type { ToolCall } from '../db/schema.js';

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: { function: ToolCall }[] }
  | { role: 'tool'; content: string; tool_name: string };

export type ToolDefinition = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type LLMReply = { content: string; toolCalls: ToolCall[] };

export interface LLMProvider {
  chat(messages: ChatMessage[], tools?: ToolDefinition[]): Promise<LLMReply>;
  check(): Promise<{ ok: boolean; message: string }>;
}
