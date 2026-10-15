export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * Chat Completions wire data for explicit upstream compatibility adapters
 * and generic escrow-builder inputs. Content is a string, including "" for
 * a tool-only assistant message. Marketplace LLM requests and session
 * transcripts use Responses Items instead.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
