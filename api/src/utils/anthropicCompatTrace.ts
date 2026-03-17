type TraceBlock = {
  position: number;
  type: string | null;
  text_chars?: number | null;
  tool_use_id?: string | null;
  tool_name?: string | null;
  content_kind?: 'string' | 'array' | 'other' | 'missing' | null;
  content_types?: string[];
  thinking_chars?: number | null;
  has_signature?: boolean | null;
};

type MessageTrace = {
  index: number;
  role: string | null;
  content_kind: 'string' | 'array' | 'other' | 'missing';
  string_chars: number | null;
  block_count: number;
  block_types: string[];
  text_block_count: number;
  text_chars: number;
  tool_use_ids: string[];
  tool_result_ids: string[];
  thinking_block_count: number;
  thinking_signature_count: number;
  thinking_signature_missing_count: number;
  leading_tool_result_ids: string[];
  has_tool_result_after_non_tool_result: boolean;
  missing_tool_use_id: boolean;
  missing_tool_result_id: boolean;
  blocks: TraceBlock[];
};

type HistoryAnalysis = {
  missing_tool_use_id_message_indexes: number[];
  missing_tool_result_id_message_indexes: number[];
  tool_result_after_non_tool_result_message_indexes: number[];
  orphan_tool_result_message_indexes: number[];
  tool_result_adjacency_violations: Array<{
    assistant_message_index: number | null;
    user_message_index: number | null;
    actual_role: string | null;
    expected_tool_use_ids: string[];
    leading_tool_result_ids: string[];
  }>;
  tool_result_id_mismatch_violations: Array<{
    assistant_message_index: number;
    user_message_index: number;
    expected_tool_use_ids: string[];
    leading_tool_result_ids: string[];
    missing_tool_use_ids: string[];
    unexpected_tool_use_ids: string[];
  }>;
  unsigned_thinking_with_tool_use_message_indexes: number[];
  pending_tool_use_message_index: number | null;
  pending_tool_use_ids: string[] | null;
};

function summarizeNestedContentTypes(content: unknown): string[] {
  if (typeof content === 'string') return ['text'];
  if (!Array.isArray(content)) return [];
  return content.flatMap((rawBlock) => {
    if (!rawBlock || typeof rawBlock !== 'object' || Array.isArray(rawBlock)) return [];
    return typeof (rawBlock as Record<string, unknown>).type === 'string'
      ? [String((rawBlock as Record<string, unknown>).type)]
      : [];
  });
}

function summarizeMessageTrace(rawMessage: unknown, index: number): MessageTrace {
  const message = rawMessage && typeof rawMessage === 'object' && !Array.isArray(rawMessage)
    ? rawMessage as Record<string, unknown>
    : null;
  const role = typeof message?.role === 'string' ? message.role.trim().toLowerCase() : null;
  const content = message?.content;

  if (typeof content === 'string') {
    return {
      index,
      role,
      content_kind: 'string',
      string_chars: content.length,
      block_count: 0,
      block_types: [],
      text_block_count: 0,
      text_chars: content.length,
      tool_use_ids: [],
      tool_result_ids: [],
      thinking_block_count: 0,
      thinking_signature_count: 0,
      thinking_signature_missing_count: 0,
      leading_tool_result_ids: [],
      has_tool_result_after_non_tool_result: false,
      missing_tool_use_id: false,
      missing_tool_result_id: false,
      blocks: []
    };
  }

  if (!Array.isArray(content)) {
    return {
      index,
      role,
      content_kind: content == null ? 'missing' : 'other',
      string_chars: null,
      block_count: 0,
      block_types: [],
      text_block_count: 0,
      text_chars: 0,
      tool_use_ids: [],
      tool_result_ids: [],
      thinking_block_count: 0,
      thinking_signature_count: 0,
      thinking_signature_missing_count: 0,
      leading_tool_result_ids: [],
      has_tool_result_after_non_tool_result: false,
      missing_tool_use_id: false,
      missing_tool_result_id: false,
      blocks: []
    };
  }

  let textBlockCount = 0;
  let textChars = 0;
  let thinkingBlockCount = 0;
  let thinkingSignatureCount = 0;
  let thinkingSignatureMissingCount = 0;
  let missingToolUseId = false;
  let missingToolResultId = false;
  let sawNonToolResultBlock = false;
  let hasToolResultAfterNonToolResult = false;
  const toolUseIds: string[] = [];
  const toolResultIds: string[] = [];
  const leadingToolResultIds: string[] = [];

  const blocks: TraceBlock[] = content.map((rawBlock, position) => {
    if (!rawBlock || typeof rawBlock !== 'object' || Array.isArray(rawBlock)) {
      if (role === 'user') sawNonToolResultBlock = true;
      return { position, type: null };
    }

    const block = rawBlock as Record<string, unknown>;
    const type = typeof block.type === 'string' ? String(block.type) : null;
    const trace: TraceBlock = { position, type };

    if (type === 'text') {
      const text = typeof block.text === 'string' ? block.text : '';
      textBlockCount += 1;
      textChars += text.length;
      trace.text_chars = text.length;
    }

    if (role === 'assistant' && type === 'thinking') {
      const thinking = typeof block.thinking === 'string' ? block.thinking : '';
      const hasSignature = typeof block.signature === 'string' && block.signature.trim().length > 0;
      thinkingBlockCount += 1;
      textChars += thinking.length;
      if (hasSignature) thinkingSignatureCount += 1;
      else thinkingSignatureMissingCount += 1;
      trace.thinking_chars = thinking.length;
      trace.has_signature = hasSignature;
    }

    if (role === 'assistant' && type === 'tool_use') {
      const toolUseId = typeof block.id === 'string' && block.id.trim().length > 0 ? block.id.trim() : null;
      if (toolUseId) toolUseIds.push(toolUseId);
      else missingToolUseId = true;
      trace.tool_use_id = toolUseId;
      trace.tool_name = typeof block.name === 'string' && block.name.trim().length > 0 ? block.name.trim() : null;
    }

    if (role === 'user' && type === 'tool_result') {
      const toolUseId = typeof block.tool_use_id === 'string' && block.tool_use_id.trim().length > 0
        ? block.tool_use_id.trim()
        : null;
      if (sawNonToolResultBlock) {
        hasToolResultAfterNonToolResult = true;
      }
      if (toolUseId) {
        toolResultIds.push(toolUseId);
        if (!sawNonToolResultBlock) leadingToolResultIds.push(toolUseId);
      } else {
        missingToolResultId = true;
      }
      trace.tool_use_id = toolUseId;
      trace.content_kind = typeof block.content === 'string'
        ? 'string'
        : Array.isArray(block.content)
          ? 'array'
          : block.content == null
            ? 'missing'
            : 'other';
      trace.content_types = summarizeNestedContentTypes(block.content);
      if (typeof block.content === 'string') {
        trace.text_chars = block.content.length;
      } else if (Array.isArray(block.content)) {
        const nestedTextChars = block.content.reduce((total, nestedBlock) => {
          if (!nestedBlock || typeof nestedBlock !== 'object' || Array.isArray(nestedBlock)) return total;
          if ((nestedBlock as Record<string, unknown>).type !== 'text') return total;
          const text = typeof (nestedBlock as Record<string, unknown>).text === 'string'
            ? String((nestedBlock as Record<string, unknown>).text)
            : '';
          return total + text.length;
        }, 0);
        trace.text_chars = nestedTextChars;
      }
    } else if (role === 'user') {
      sawNonToolResultBlock = true;
    }

    return trace;
  });

  return {
    index,
    role,
    content_kind: 'array',
    string_chars: null,
    block_count: content.length,
    block_types: blocks.flatMap((block) => block.type ? [block.type] : []),
    text_block_count: textBlockCount,
    text_chars: textChars,
    tool_use_ids: toolUseIds,
    tool_result_ids: toolResultIds,
    thinking_block_count: thinkingBlockCount,
    thinking_signature_count: thinkingSignatureCount,
    thinking_signature_missing_count: thinkingSignatureMissingCount,
    leading_tool_result_ids: leadingToolResultIds,
    has_tool_result_after_non_tool_result: hasToolResultAfterNonToolResult,
    missing_tool_use_id: missingToolUseId,
    missing_tool_result_id: missingToolResultId,
    blocks
  };
}

function analyzeHistory(messageTrace: MessageTrace[]): HistoryAnalysis {
  const analysis: HistoryAnalysis = {
    missing_tool_use_id_message_indexes: [],
    missing_tool_result_id_message_indexes: [],
    tool_result_after_non_tool_result_message_indexes: [],
    orphan_tool_result_message_indexes: [],
    tool_result_adjacency_violations: [],
    tool_result_id_mismatch_violations: [],
    unsigned_thinking_with_tool_use_message_indexes: [],
    pending_tool_use_message_index: null,
    pending_tool_use_ids: null
  };

  let pendingToolUseIds: string[] | null = null;
  let pendingToolUseMessageIndex: number | null = null;

  for (const message of messageTrace) {
    if (message.missing_tool_use_id) analysis.missing_tool_use_id_message_indexes.push(message.index);
    if (message.missing_tool_result_id) analysis.missing_tool_result_id_message_indexes.push(message.index);
    if (message.has_tool_result_after_non_tool_result) {
      analysis.tool_result_after_non_tool_result_message_indexes.push(message.index);
    }
    if (message.tool_use_ids.length > 0 && message.thinking_signature_missing_count > 0) {
      analysis.unsigned_thinking_with_tool_use_message_indexes.push(message.index);
    }

    if (pendingToolUseIds) {
      const expectedToolUseIds = pendingToolUseIds;
      if (message.role !== 'user') {
        analysis.tool_result_adjacency_violations.push({
          assistant_message_index: pendingToolUseMessageIndex,
          user_message_index: message.index,
          actual_role: message.role,
          expected_tool_use_ids: expectedToolUseIds,
          leading_tool_result_ids: []
        });
      } else if (message.leading_tool_result_ids.length === 0) {
        analysis.tool_result_adjacency_violations.push({
          assistant_message_index: pendingToolUseMessageIndex,
          user_message_index: message.index,
          actual_role: message.role,
          expected_tool_use_ids: expectedToolUseIds,
          leading_tool_result_ids: []
        });
      } else {
        const missingToolUseIds = expectedToolUseIds.filter((id) => !message.leading_tool_result_ids.includes(id));
        const unexpectedToolUseIds = message.leading_tool_result_ids.filter((id) => !expectedToolUseIds.includes(id));
        if (missingToolUseIds.length > 0 || unexpectedToolUseIds.length > 0) {
          analysis.tool_result_id_mismatch_violations.push({
            assistant_message_index: pendingToolUseMessageIndex ?? message.index,
            user_message_index: message.index,
            expected_tool_use_ids: expectedToolUseIds,
            leading_tool_result_ids: message.leading_tool_result_ids,
            missing_tool_use_ids: missingToolUseIds,
            unexpected_tool_use_ids: unexpectedToolUseIds
          });
        }
      }
      pendingToolUseIds = null;
      pendingToolUseMessageIndex = null;
    } else if (message.role === 'user' && message.leading_tool_result_ids.length > 0) {
      analysis.orphan_tool_result_message_indexes.push(message.index);
    }

    if (message.role === 'assistant' && message.tool_use_ids.length > 0) {
      pendingToolUseIds = message.tool_use_ids;
      pendingToolUseMessageIndex = message.index;
    }
  }

  if (pendingToolUseIds) {
    analysis.tool_result_adjacency_violations.push({
      assistant_message_index: pendingToolUseMessageIndex,
      user_message_index: null,
      actual_role: null,
      expected_tool_use_ids: pendingToolUseIds,
      leading_tool_result_ids: []
    });
    analysis.pending_tool_use_ids = pendingToolUseIds;
    analysis.pending_tool_use_message_index = pendingToolUseMessageIndex;
  }

  return analysis;
}

export function summarizeAnthropicCompatRequestShape(
  payload: unknown,
  stream: boolean,
  options?: { includeMessageTrace?: boolean; tailMessages?: number }
): Record<string, unknown> {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const messages = Array.isArray(record.messages) ? record.messages : [];
  const tools = Array.isArray(record.tools) ? record.tools : [];
  const messageTrace = messages.map((message, index) => summarizeMessageTrace(message, index));
  const historyAnalysis = analyzeHistory(messageTrace);
  const tailMessages = options?.tailMessages ?? 8;

  const assistantMessageCount = messageTrace.filter((message) => message.role === 'assistant').length;
  const assistantThinkingBlockCount = messageTrace.reduce((total, message) => total + message.thinking_block_count, 0);
  const assistantToolUseBlockCount = messageTrace.reduce((total, message) => total + message.tool_use_ids.length, 0);
  const toolResultBlockCount = messageTrace.reduce((total, message) => total + message.tool_result_ids.length, 0);

  const lastMessage = messageTrace.length > 0 ? messageTrace[messageTrace.length - 1] : null;
  const toolChoice = record.tool_choice;
  const thinking = record.thinking && typeof record.thinking === 'object' && !Array.isArray(record.thinking)
    ? record.thinking as Record<string, unknown>
    : null;
  const toolChoiceType = typeof toolChoice === 'string'
    ? toolChoice
    : (toolChoice && typeof toolChoice === 'object' && typeof (toolChoice as Record<string, unknown>).type === 'string'
        ? String((toolChoice as Record<string, unknown>).type)
        : null);
  const thinkingType = typeof thinking?.type === 'string' ? String(thinking.type) : null;
  const thinkingBudgetTokens = typeof thinking?.budget_tokens === 'number' && Number.isFinite(thinking.budget_tokens)
    ? thinking.budget_tokens
    : null;
  const maxTokens = typeof record.max_tokens === 'number' && Number.isFinite(record.max_tokens)
    ? record.max_tokens
    : null;
  const maxOutputTokens = typeof record.max_output_tokens === 'number' && Number.isFinite(record.max_output_tokens)
    ? record.max_output_tokens
    : null;

  return {
    stream,
    message_count: messageTrace.length,
    assistant_message_count: assistantMessageCount,
    last_message_role: lastMessage?.role ?? null,
    last_message_content_types: lastMessage?.block_types ?? (lastMessage?.content_kind === 'string' ? ['text'] : []),
    assistant_prefill_suspected: lastMessage?.role === 'assistant',
    system_present: record.system != null,
    tool_count: tools.length,
    tool_result_block_count: toolResultBlockCount,
    tool_choice_present: toolChoice != null,
    tool_choice_type: toolChoiceType,
    thinking_present: thinking != null,
    thinking_type: thinkingType,
    thinking_budget_tokens: thinkingBudgetTokens,
    assistant_thinking_block_count: assistantThinkingBlockCount,
    assistant_tool_use_block_count: assistantToolUseBlockCount,
    max_tokens: maxTokens,
    max_output_tokens: maxOutputTokens,
    metadata_present: record.metadata != null,
    message_trace_tail: messageTrace.slice(-tailMessages),
    history_analysis: historyAnalysis,
    ...(options?.includeMessageTrace ? { message_trace: messageTrace } : {})
  };
}
