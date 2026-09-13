import { CONFIG, type ConfigDict } from "../config";
import type { ChatMessage } from "./scenario/parser";

// config.yaml's explanation.llm can hold either one flat provider config, or
// a set of named provider profiles ("providers") plus which one is "active".
// The LLM_PROVIDER environment variable overrides "active" without editing
// the file -- e.g. keep "ollama" as the checked-in default for local dev and
// set LLM_PROVIDER=groq wherever there's no local model server to talk to.
function resolveLlmConfig(section: ConfigDict): ConfigDict {
  if (!section.providers) return section;
  const name = process.env.LLM_PROVIDER || section.active;
  const profile = section.providers[name];
  if (!profile) {
    const source = process.env.LLM_PROVIDER ? "LLM_PROVIDER environment variable" : "explanation.llm.active in config.yaml";
    throw new Error(`Unknown LLM provider "${name}" (from ${source}). Available: ${Object.keys(section.providers).join(", ")}`);
  }
  return profile;
}

const LLM_CONFIG = resolveLlmConfig(CONFIG.explanation.llm);
const PROCESS_CONFIG = CONFIG.explanation.process_display ?? {};

export function processPrint(message: string): void {
  if (PROCESS_CONFIG.enabled ?? true) console.log(message);
}

export interface ChatOptions {
  responseSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
}

export class LLMClient {
  provider: string;
  model: string;
  baseUrl: string;
  temperature: number;
  timeoutSeconds: number;
  maxOutputTokens: number;
  apiKey: string;

  constructor() {
    this.provider = String(LLM_CONFIG.provider).toLowerCase();
    this.model = String(LLM_CONFIG.model);
    this.baseUrl = String(LLM_CONFIG.base_url).replace(/\/+$/, "");
    this.temperature = Number(LLM_CONFIG.temperature);
    this.timeoutSeconds = Number(LLM_CONFIG.timeout_seconds);
    this.maxOutputTokens = Number(LLM_CONFIG.max_output_tokens ?? 250);
    const apiKeyEnv = String(LLM_CONFIG.api_key_env ?? "LLM_API_KEY");
    this.apiKey = process.env[apiKeyEnv] ?? "";
    processPrint(`[INIT] LLM ready | provider=${this.provider} | model=${this.model}`);
  }

  private async postJson(url: string, payload: unknown, headers: Record<string, string> = {}): Promise<any> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutSeconds * 1000);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`LLM request failed (${response.status}): ${body}`);
      }

      return await response.json();
    } catch (exc: any) {
      if (exc.name === "AbortError") throw new Error(`LLM request to ${url} timed out`);
      throw new Error(`Could not connect to LLM at ${url}: ${exc}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async ollama(messages: ChatMessage[], responseSchema?: Record<string, unknown>, maxOutputTokens?: number): Promise<string> {
    const payload: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: false,
      options: {
        temperature: this.temperature,
        num_predict: maxOutputTokens ?? this.maxOutputTokens,
      },
    };
    if (responseSchema !== undefined) payload.format = responseSchema;
    const result = await this.postJson(`${this.baseUrl}/api/chat`, payload);
    return String(result.message.content).trim();
  }

  private async openaiCompatible(messages: ChatMessage[], responseSchema?: Record<string, unknown>, maxOutputTokens?: number): Promise<string> {
    const url = this.baseUrl.endsWith("/v1") ? `${this.baseUrl}/chat/completions` : `${this.baseUrl}/v1/chat/completions`;
    const headers: Record<string, string> = this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
    const payload: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: this.temperature,
      max_tokens: maxOutputTokens ?? this.maxOutputTokens,
    };
    if (responseSchema !== undefined) {
      payload.response_format = {
        type: "json_schema",
        json_schema: { name: "farmopti_structured_response", strict: true, schema: responseSchema },
      };
    }
    const result = await this.postJson(url, payload, headers);
    return String(result.choices[0].message.content).trim();
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    if (this.provider === "ollama") return this.ollama(messages, options.responseSchema, options.maxOutputTokens);
    if (["openai", "openai_compatible", "compatible"].includes(this.provider)) {
      return this.openaiCompatible(messages, options.responseSchema, options.maxOutputTokens);
    }
    throw new Error(`Unsupported LLM provider: ${this.provider}`);
  }
}
