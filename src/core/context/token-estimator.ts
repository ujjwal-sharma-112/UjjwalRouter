import type { ChatMessage, ContentPart, NormalizedChatRequest, ToolDefinition } from '../../providers/base/types.js';

export interface TokenEstimateBreakdown {
  systemTokens: number;
  messageTokens: number;
  toolDefinitionTokens: number;
  toolResultTokens: number;
  imageTokens: number;
  estimatedInputTokens: number;
}

function estimateTextTokens(text: string): number {
  if (!text) return 0;
  // Conservative estimate: ~3.5 chars per token for mixed prose/code + ASCII punctuation
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3.4);
}

function estimateContentParts(content: string | ContentPart[] | null): { textTokens: number; imageTokens: number } {
  if (typeof content === 'string') {
    return { textTokens: estimateTextTokens(content), imageTokens: 0 };
  }
  if (!Array.isArray(content)) {
    return { textTokens: 0, imageTokens: 0 };
  }

  let textTokens = 0;
  let imageTokens = 0;
  for (const part of content) {
    if (part.type === 'text') {
      textTokens += estimateTextTokens(part.text);
    } else if (part.type === 'image_url') {
      const detail = part.image_url.detail ?? 'auto';
      imageTokens += detail === 'low' ? 258 : 1100;
    }
  }
  return { textTokens, imageTokens };
}

function estimateMessageTokens(msg: ChatMessage): {
  baseTokens: number;
  imageTokens: number;
  isSystem: boolean;
  isToolResult: boolean;
} {
  let baseTokens = 6; // role + framing overhead
  if (msg.name) {
    baseTokens += estimateTextTokens(msg.name) + 2;
  }
  if (msg.tool_call_id) {
    baseTokens += estimateTextTokens(msg.tool_call_id) + 2;
  }
  if (msg.reasoning_content) {
    baseTokens += estimateTextTokens(msg.reasoning_content);
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      baseTokens += 10;
      baseTokens += estimateTextTokens(tc.function.name);
      baseTokens += estimateTextTokens(tc.function.arguments);
    }
  }

  const { textTokens, imageTokens } = estimateContentParts(msg.content);
  baseTokens += textTokens;

  return {
    baseTokens,
    imageTokens,
    isSystem: msg.role === 'system' || msg.role === 'developer',
    isToolResult: msg.role === 'tool',
  };
}

function estimateToolDefinitionsTokens(tools: ToolDefinition[] | undefined): number {
  if (!tools || tools.length === 0) return 0;
  let total = 12;
  for (const tool of tools) {
    total += 16;
    total += estimateTextTokens(tool.function.name);
    if (tool.function.description) {
      total += estimateTextTokens(tool.function.description);
    }
    if (tool.function.parameters) {
      total += estimateTextTokens(JSON.stringify(tool.function.parameters));
    }
  }
  return total;
}

export function estimateRequestTokens(request: NormalizedChatRequest): TokenEstimateBreakdown {
  let systemTokens = 0;
  let messageTokens = 0;
  let toolResultTokens = 0;
  let imageTokens = 0;

  for (const msg of request.messages) {
    const est = estimateMessageTokens(msg);
    imageTokens += est.imageTokens;
    if (est.isSystem) {
      systemTokens += est.baseTokens;
    } else if (est.isToolResult) {
      toolResultTokens += est.baseTokens;
    } else {
      messageTokens += est.baseTokens;
    }
  }

  const toolDefinitionTokens = estimateToolDefinitionsTokens(request.tools);
  // 4 tokens priming overhead for assistant reply
  const estimatedInputTokens =
    systemTokens + messageTokens + toolResultTokens + toolDefinitionTokens + imageTokens + 4;

  return {
    systemTokens,
    messageTokens,
    toolDefinitionTokens,
    toolResultTokens,
    imageTokens,
    estimatedInputTokens,
  };
}
