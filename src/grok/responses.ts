import type { OpenAIToolCall } from "./toolCall";

const TOOL_OUTPUT_TYPES = new Set([
  "tool_output",
  "function_call_output",
  "tool_call_output",
  "input_tool_output",
]);

const BUILTIN_TOOL_TYPES = new Set([
  "web_search",
  "web_search_2025_08_26",
  "file_search",
  "code_interpreter",
]);

function nowTs(): number {
  return Math.floor(Date.now() / 1000);
}

function newResponseId(): string {
  return `resp_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function newMessageId(): string {
  return `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function newFunctionCallId(): string {
  return `fc_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function eventLine(eventType: string, payload: Record<string, unknown>): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function normalizeToolChoice(toolChoice: unknown): unknown {
  if (toolChoice && typeof toolChoice === "object" && !Array.isArray(toolChoice)) {
    const type = (toolChoice as Record<string, any>).type;
    if (type && type !== "function") {
      return { type: "function", function: { name: type } };
    }
  }
  return toolChoice;
}

export function normalizeToolsForChat(
  tools: Array<Record<string, any>> | null | undefined,
): Array<Record<string, any>> | null {
  if (!Array.isArray(tools) || !tools.length) return null;

  const normalized: Array<Record<string, any>> = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type === "function") {
      normalized.push(tool);
      continue;
    }

    if (!BUILTIN_TOOL_TYPES.has(String(tool.type ?? ""))) continue;
    if (tool.type === "code_interpreter") {
      normalized.push({
        type: "function",
        function: {
          name: "code_interpreter",
          description: "Execute code to solve tasks and return results.",
          parameters: {
            type: "object",
            properties: { code: { type: "string" } },
            required: ["code"],
          },
        },
      });
      continue;
    }

    normalized.push({
      type: "function",
      function: {
        name: String(tool.type),
        description:
          tool.type === "file_search"
            ? "Search provided files for relevant information."
            : "Search the web for information and return results.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    });
  }

  return normalized.length ? normalized : null;
}

type NormalizedInput =
  | { kind: "message"; message: Record<string, any> }
  | { kind: "tool"; message: Record<string, any> }
  | { kind: "block"; block: Record<string, any> };

function normalizeContent(content: unknown): unknown {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const blocks = content
      .map((item) => normalizeInputItem(item))
      .filter((item): item is { kind: "block"; block: Record<string, any> } => Boolean(item && item.kind === "block"))
      .map((item) => item.block);
    return blocks.length ? blocks : "";
  }
  if (typeof content === "object") {
    const normalized = normalizeInputItem(content);
    if (normalized?.kind === "block") return [normalized.block];
  }
  return String(content);
}

export function normalizeInputItem(item: unknown): NormalizedInput | null {
  if (item == null) return null;

  if (typeof item === "string") {
    return { kind: "block", block: { type: "text", text: item } };
  }

  if (typeof item !== "object" || Array.isArray(item)) {
    return null;
  }

  const record = item as Record<string, any>;
  const itemType = record.type;

  if (itemType === "message" || ("role" in record && "content" in record)) {
    return {
      kind: "message",
      message: {
        role: record.role || "user",
        content: normalizeContent(record.content),
      },
    };
  }

  if (TOOL_OUTPUT_TYPES.has(String(itemType ?? ""))) {
    const callId = record.call_id || record.tool_call_id || record.id || `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const output = record.output ?? record.content ?? "";
    return {
      kind: "tool",
      message: {
        role: "tool",
        tool_call_id: callId,
        content: output,
      },
    };
  }

  if (itemType === "input_text" || itemType === "text" || itemType === "output_text") {
    return {
      kind: "block",
      block: { type: "text", text: record.text ?? record.content ?? "" },
    };
  }

  if (itemType === "input_image" || itemType === "image" || itemType === "image_url" || itemType === "output_image") {
    let url = "";
    let detail: string | undefined;
    if (typeof record.image_url === "string") {
      url = record.image_url;
    } else if (record.image_url && typeof record.image_url === "object") {
      url = record.image_url.url ?? "";
      detail = record.image_url.detail;
    } else if (record.input_image && typeof record.input_image === "object") {
      url = record.input_image.image_url ?? record.input_image.url ?? "";
    } else {
      url = record.url ?? record.image ?? "";
    }
    if (!url) return null;
    const imagePayload: Record<string, any> = { url };
    if (detail) imagePayload.detail = detail;
    return {
      kind: "block",
      block: { type: "image_url", image_url: imagePayload },
    };
  }

  if (itemType === "input_file" || itemType === "file") {
    const nestedFile = record.file && typeof record.file === "object" ? record.file : {};
    const filePayload: Record<string, any> = {};
    const fileData = record.file_data ?? nestedFile.file_data;
    const fileId = record.file_id ?? nestedFile.file_id;
    if (fileData) filePayload.file_data = fileData;
    if (fileId) filePayload.file_id = fileId;
    if (!Object.keys(filePayload).length) return null;
    return {
      kind: "block",
      block: { type: "file", file: filePayload },
    };
  }

  if (itemType === "input_audio" || itemType === "audio") {
    const audio = record.audio && typeof record.audio === "object" ? record.audio : {};
    const data = audio.data ?? record.data ?? "";
    if (!data) return null;
    return {
      kind: "block",
      block: { type: "input_audio", input_audio: { data } },
    };
  }

  return null;
}

export function coerceInputToMessages(inputValue: unknown): Array<Record<string, any>> {
  if (inputValue == null) return [];
  if (typeof inputValue === "string") {
    return [{ role: "user", content: inputValue }];
  }

  if (!Array.isArray(inputValue)) {
    const normalized = normalizeInputItem(inputValue);
    if (!normalized) return [];
    if (normalized.kind === "message" || normalized.kind === "tool") {
      return [normalized.message];
    }
    return [{ role: "user", content: [normalized.block] }];
  }

  const messages: Array<Record<string, any>> = [];
  let pendingBlocks: Array<Record<string, any>> = [];

  const flushPending = (): void => {
    if (!pendingBlocks.length) return;
    messages.push({ role: "user", content: pendingBlocks });
    pendingBlocks = [];
  };

  for (const item of inputValue) {
    const normalized = normalizeInputItem(item);
    if (!normalized) continue;
    if (normalized.kind === "message" || normalized.kind === "tool") {
      flushPending();
      messages.push(normalized.message);
      continue;
    }
    pendingBlocks.push(normalized.block);
  }

  flushPending();
  return messages;
}

function buildOutputMessage(text: string, messageId = newMessageId(), status = "completed"): Record<string, any> {
  return {
    id: messageId,
    type: "message",
    role: "assistant",
    status,
    content: [
      {
        type: "output_text",
        text,
        annotations: [],
      },
    ],
  };
}

function buildOutputToolCall(toolCall: OpenAIToolCall, itemId = newFunctionCallId(), status = "completed"): Record<string, any> {
  return {
    id: itemId,
    type: "function_call",
    status,
    call_id: toolCall.id,
    name: toolCall.function.name,
    arguments: toolCall.function.arguments,
  };
}

export function buildResponseObject(args: {
  model: string;
  outputText?: string | null | undefined;
  toolCalls?: OpenAIToolCall[] | null | undefined;
  responseId?: string;
  usage?: Record<string, any> | null | undefined;
  createdAt?: number;
  completedAt?: number;
  status?: string;
  instructions?: string | null | undefined;
  maxOutputTokens?: number | null | undefined;
  parallelToolCalls?: boolean | null | undefined;
  previousResponseId?: string | null | undefined;
  reasoningEffort?: string | null | undefined;
  store?: boolean | null | undefined;
  temperature?: number | null | undefined;
  toolChoice?: unknown;
  tools?: Array<Record<string, any>> | null | undefined;
  topP?: number | null | undefined;
  truncation?: string | null | undefined;
  user?: string | null | undefined;
  metadata?: Record<string, any> | null | undefined;
}): Record<string, any> {
  const responseId = args.responseId ?? newResponseId();
  const createdAt = args.createdAt ?? nowTs();
  const completedAt = args.status === "completed" || !args.status
    ? args.completedAt ?? nowTs()
    : args.completedAt ?? null;

  const output: Array<Record<string, any>> = [];
  if (args.outputText != null) {
    output.push(buildOutputMessage(args.outputText));
  }
  if (Array.isArray(args.toolCalls)) {
    for (const toolCall of args.toolCalls) {
      output.push(buildOutputToolCall(toolCall));
    }
  }

  return {
    id: responseId,
    object: "response",
    created_at: createdAt,
    completed_at: completedAt,
    status: args.status ?? "completed",
    error: null,
    incomplete_details: null,
    instructions: args.instructions ?? null,
    max_output_tokens: args.maxOutputTokens ?? null,
    model: args.model,
    output,
    parallel_tool_calls: args.parallelToolCalls ?? true,
    previous_response_id: args.previousResponseId ?? null,
    reasoning: { effort: args.reasoningEffort ?? null, summary: null },
    store: args.store ?? true,
    temperature: args.temperature ?? 1,
    text: { format: { type: "text" } },
    tool_choice: args.toolChoice ?? "auto",
    tools: args.tools ?? [],
    top_p: args.topP ?? 1,
    truncation: args.truncation ?? "disabled",
    usage: args.usage ?? null,
    user: args.user ?? null,
    metadata: args.metadata ?? {},
  };
}

class ResponseStreamAdapter {
  readonly responseId: string;

  readonly createdAt: number;

  readonly model: string;

  readonly instructions: string | null | undefined;

  readonly maxOutputTokens: number | null | undefined;

  readonly parallelToolCalls: boolean | null | undefined;

  readonly previousResponseId: string | null | undefined;

  readonly reasoningEffort: string | null | undefined;

  readonly store: boolean | null | undefined;

  readonly temperature: number | null | undefined;

  readonly toolChoice: unknown;

  readonly tools: Array<Record<string, any>> | null | undefined;

  readonly topP: number | null | undefined;

  readonly truncation: string | null | undefined;

  readonly user: string | null | undefined;

  readonly metadata: Record<string, any> | null | undefined;

  readonly outputTextParts: string[] = [];

  readonly toolCallsByIndex = new Map<number, OpenAIToolCall>();

  readonly toolItems = new Map<number, { itemId: string; outputIndex: number; toolCall: OpenAIToolCall }>();

  readonly messageId = newMessageId();

  private nextOutputIndex = 0;

  private messageStarted = false;

  private messageOutputIndex: number | null = null;

  constructor(args: {
    model: string;
    responseId?: string;
    createdAt?: number;
    instructions?: string | null;
    maxOutputTokens?: number | null;
    parallelToolCalls?: boolean | null;
    previousResponseId?: string | null;
    reasoningEffort?: string | null;
    store?: boolean | null;
    temperature?: number | null;
    toolChoice?: unknown;
    tools?: Array<Record<string, any>> | null;
    topP?: number | null;
    truncation?: string | null;
    user?: string | null;
    metadata?: Record<string, any> | null;
  }) {
    this.model = args.model;
    this.responseId = args.responseId ?? newResponseId();
    this.createdAt = args.createdAt ?? nowTs();
    this.instructions = args.instructions;
    this.maxOutputTokens = args.maxOutputTokens;
    this.parallelToolCalls = args.parallelToolCalls;
    this.previousResponseId = args.previousResponseId;
    this.reasoningEffort = args.reasoningEffort;
    this.store = args.store;
    this.temperature = args.temperature;
    this.toolChoice = args.toolChoice;
    this.tools = args.tools;
    this.topP = args.topP;
    this.truncation = args.truncation;
    this.user = args.user;
    this.metadata = args.metadata;
  }

  createdEvent(): string {
    return eventLine("response.created", {
      type: "response.created",
      response: buildResponseObject({
        model: this.model,
        responseId: this.responseId,
        createdAt: this.createdAt,
        status: "in_progress",
        instructions: this.instructions,
        maxOutputTokens: this.maxOutputTokens,
        parallelToolCalls: this.parallelToolCalls,
        previousResponseId: this.previousResponseId,
        reasoningEffort: this.reasoningEffort,
        store: this.store,
        temperature: this.temperature,
        toolChoice: this.toolChoice,
        tools: this.tools,
        topP: this.topP,
        truncation: this.truncation,
        user: this.user,
        metadata: this.metadata,
      }),
    });
  }

  inProgressEvent(): string {
    return eventLine("response.in_progress", {
      type: "response.in_progress",
      response: buildResponseObject({
        model: this.model,
        responseId: this.responseId,
        createdAt: this.createdAt,
        status: "in_progress",
        instructions: this.instructions,
        maxOutputTokens: this.maxOutputTokens,
        parallelToolCalls: this.parallelToolCalls,
        previousResponseId: this.previousResponseId,
        reasoningEffort: this.reasoningEffort,
        store: this.store,
        temperature: this.temperature,
        toolChoice: this.toolChoice,
        tools: this.tools,
        topP: this.topP,
        truncation: this.truncation,
        user: this.user,
        metadata: this.metadata,
      }),
    });
  }

  ensureMessageStarted(): string[] {
    if (this.messageStarted) return [];
    this.messageStarted = true;
    this.messageOutputIndex = this.nextOutputIndex;
    this.nextOutputIndex += 1;

    return [
      eventLine("response.output_item.added", {
        type: "response.output_item.added",
        response_id: this.responseId,
        output_index: this.messageOutputIndex,
        item: { ...buildOutputMessage("", this.messageId, "in_progress"), content: [] },
      }),
      eventLine("response.content_part.added", {
        type: "response.content_part.added",
        response_id: this.responseId,
        item_id: this.messageId,
        output_index: this.messageOutputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      }),
    ];
  }

  outputDeltaEvent(delta: string): string {
    return eventLine("response.output_text.delta", {
      type: "response.output_text.delta",
      response_id: this.responseId,
      item_id: this.messageId,
      output_index: this.messageOutputIndex,
      content_index: 0,
      delta,
    });
  }

  outputDoneEvents(): string[] {
    if (!this.messageStarted || this.messageOutputIndex == null) return [];
    const text = this.outputTextParts.join("");
    return [
      eventLine("response.output_text.done", {
        type: "response.output_text.done",
        response_id: this.responseId,
        item_id: this.messageId,
        output_index: this.messageOutputIndex,
        content_index: 0,
        text,
      }),
      eventLine("response.content_part.done", {
        type: "response.content_part.done",
        response_id: this.responseId,
        item_id: this.messageId,
        output_index: this.messageOutputIndex,
        content_index: 0,
        part: { type: "output_text", text, annotations: [] },
      }),
      eventLine("response.output_item.done", {
        type: "response.output_item.done",
        response_id: this.responseId,
        output_index: this.messageOutputIndex,
        item: buildOutputMessage(text, this.messageId, "completed"),
      }),
    ];
  }

  ensureToolItem(toolIndex: number, toolCall: OpenAIToolCall): string[] {
    const existing = this.toolItems.get(toolIndex);
    if (existing) return [];

    const outputIndex = this.nextOutputIndex;
    this.nextOutputIndex += 1;
    const itemId = newFunctionCallId();
    this.toolItems.set(toolIndex, { itemId, outputIndex, toolCall });
    return [
      eventLine("response.output_item.added", {
        type: "response.output_item.added",
        response_id: this.responseId,
        output_index: outputIndex,
        item: buildOutputToolCall(toolCall, itemId, "in_progress"),
      }),
    ];
  }

  recordToolCall(toolIndex: number, toolCall: OpenAIToolCall): void {
    this.toolCallsByIndex.set(toolIndex, toolCall);
    const existing = this.toolItems.get(toolIndex);
    if (existing) {
      existing.toolCall = toolCall;
    }
  }

  toolArgumentsDeltaEvent(toolIndex: number, delta: string): string | null {
    if (!delta) return null;
    const item = this.toolItems.get(toolIndex);
    if (!item) return null;
    return eventLine("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      response_id: this.responseId,
      item_id: item.itemId,
      output_index: item.outputIndex,
      delta,
    });
  }

  toolDoneEvents(): string[] {
    const events: string[] = [];
    const items = Array.from(this.toolItems.entries()).sort((left, right) => left[1].outputIndex - right[1].outputIndex);
    for (const [, item] of items) {
      events.push(
        eventLine("response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          response_id: this.responseId,
          item_id: item.itemId,
          output_index: item.outputIndex,
          arguments: item.toolCall.function.arguments,
        }),
      );
      events.push(
        eventLine("response.output_item.done", {
          type: "response.output_item.done",
          response_id: this.responseId,
          output_index: item.outputIndex,
          item: buildOutputToolCall(item.toolCall, item.itemId, "completed"),
        }),
      );
    }
    return events;
  }

  completedEvent(): string {
    return eventLine("response.completed", {
      type: "response.completed",
      response: buildResponseObject({
        model: this.model,
        outputText: this.messageStarted ? this.outputTextParts.join("") : null,
        toolCalls: Array.from(this.toolCallsByIndex.entries())
          .sort((left, right) => left[0] - right[0])
          .map((entry) => entry[1]),
        responseId: this.responseId,
        createdAt: this.createdAt,
        usage: { total_tokens: 0, input_tokens: 0, output_tokens: 0 },
        status: "completed",
        instructions: this.instructions,
        maxOutputTokens: this.maxOutputTokens,
        parallelToolCalls: this.parallelToolCalls,
        previousResponseId: this.previousResponseId,
        reasoningEffort: this.reasoningEffort,
        store: this.store,
        temperature: this.temperature,
        toolChoice: this.toolChoice,
        tools: this.tools,
        topP: this.topP,
        truncation: this.truncation,
        user: this.user,
        metadata: this.metadata,
      }),
    });
  }
}

export function createResponsesStreamFromOpenAiStream(
  openAiStream: ReadableStream<Uint8Array>,
  args: {
    model: string;
    instructions?: string | null;
    maxOutputTokens?: number | null;
    parallelToolCalls?: boolean | null;
    previousResponseId?: string | null;
    reasoningEffort?: string | null;
    store?: boolean | null;
    temperature?: number | null;
    toolChoice?: unknown;
    tools?: Array<Record<string, any>> | null;
    topP?: number | null;
    truncation?: string | null;
    user?: string | null;
    metadata?: Record<string, any> | null;
  },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const adapter = new ResponseStreamAdapter(args);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = openAiStream.getReader();
      let buffer = "";

      const push = (line: string): void => {
        controller.enqueue(encoder.encode(line));
      };

      push(adapter.createdEvent());
      push(adapter.inProgressEvent());

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const rawEvent = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf("\n\n");

            const dataLine = rawEvent
              .split("\n")
              .map((line) => line.trim())
              .find((line) => line.startsWith("data: "));
            if (!dataLine) continue;

            const payload = dataLine.slice(6).trim();
            if (!payload || payload === "[DONE]") continue;

            let parsed: Record<string, any>;
            try {
              parsed = JSON.parse(payload);
            } catch {
              continue;
            }

            if (parsed.object !== "chat.completion.chunk") continue;
            const choice = Array.isArray(parsed.choices) ? parsed.choices[0] ?? {} : {};
            const delta = choice.delta ?? {};

            if (typeof delta.content === "string" && delta.content) {
              for (const event of adapter.ensureMessageStarted()) {
                push(event);
              }
              adapter.outputTextParts.push(delta.content);
              push(adapter.outputDeltaEvent(delta.content));
            }

            if (Array.isArray(delta.tool_calls)) {
              for (const tool of delta.tool_calls) {
                if (!tool || typeof tool !== "object") continue;
                const toolIndex = Number.isFinite(Number(tool.index)) ? Number(tool.index) : 0;
                const fn = tool.function ?? {};
                const toolCall: OpenAIToolCall = {
                  id: typeof tool.id === "string" && tool.id ? tool.id : `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
                  type: "function",
                  function: {
                    name: typeof fn.name === "string" ? fn.name : "",
                    arguments: typeof fn.arguments === "string" ? fn.arguments : "",
                  },
                };
                adapter.recordToolCall(toolIndex, toolCall);
                for (const event of adapter.ensureToolItem(toolIndex, toolCall)) {
                  push(event);
                }
                const deltaEvent = adapter.toolArgumentsDeltaEvent(toolIndex, toolCall.function.arguments);
                if (deltaEvent) push(deltaEvent);
              }
            }
          }
        }

        for (const event of adapter.outputDoneEvents()) {
          push(event);
        }
        for (const event of adapter.toolDoneEvents()) {
          push(event);
        }
        push(adapter.completedEvent());
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // ignore release failure
        }
      }
    },
  });
}
