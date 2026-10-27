import type { ChatMessage, LLMProvider, LLMReply, ToolDefinition } from './llm.js';

type OllamaChatResponse = {
  message?: {
    content?: string;
    tool_calls?: { function: { name: string; arguments: Record<string, unknown> | string } }[];
  };
  error?: string;
};

export class OllamaProvider implements LLMProvider {
  constructor(
    private baseUrl: string,
    private model: string,
  ) {}

  async chat(messages: ChatMessage[], tools?: ToolDefinition[]): Promise<LLMReply> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        tools,
        stream: false,
        think: false,
        keep_alive: '30m',
        options: { temperature: 0.1, num_ctx: 8192 },
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const data = (await res.json()) as OllamaChatResponse;
    if (!res.ok || data.error) throw new Error(`Ollama: ${data.error ?? res.statusText}`);
    return {
      content: data.message?.content?.trim() ?? '',
      toolCalls: (data.message?.tool_calls ?? []).map((c) => ({
        name: c.function.name,
        arguments:
          typeof c.function.arguments === 'string'
            ? safeJson(c.function.arguments)
            : (c.function.arguments ?? {}),
      })),
    };
  }

  async check(): Promise<{ ok: boolean; message: string }> {
    let names: string[];
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      names = ((await res.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? [];
    } catch {
      return {
        ok: false,
        message: `Ollama no responde en ${this.baseUrl}. Ábrelo desde el menú Inicio o ejecuta: ollama serve`,
      };
    }
    const wanted = this.model.includes(':') ? this.model : `${this.model}:latest`;
    if (!names.includes(wanted)) {
      return {
        ok: false,
        message: `Falta el modelo ${this.model}. Descárgalo con: ollama pull ${this.model}`,
      };
    }
    return { ok: true, message: `Ollama listo con ${this.model}` };
  }
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}
