export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

function stripCodeFences(text: string): string {
  let cleaned = String(text ?? "").trim();
  if (!cleaned.startsWith("```")) return cleaned;
  cleaned = cleaned.replace(/^```[a-zA-Z0-9_-]*\s*/, "");
  cleaned = cleaned.replace(/\s*```$/, "");
  return cleaned.trim();
}

function extractJsonObject(text: string): string {
  const cleaned = String(text ?? "");
  const start = cleaned.indexOf("{");
  if (start === -1) return cleaned;
  const end = cleaned.lastIndexOf("}");
  if (end === -1 || end < start) return cleaned.slice(start);
  return cleaned.slice(start, end + 1);
}

function removeTrailingCommas(text: string): string {
  return String(text ?? "").replace(/,\s*([}\]])/g, "$1");
}

function balanceBraces(text: string): string {
  const input = String(text ?? "");
  let openCount = 0;
  let closeCount = 0;
  let inString = false;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === "\\" && inString) {
      escaping = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") openCount += 1;
    if (char === "}") closeCount += 1;
  }

  if (openCount > closeCount) {
    return input + "}".repeat(openCount - closeCount);
  }
  return input;
}

function repairJson(text: string): unknown | null {
  const cleaned = balanceBraces(
    removeTrailingCommas(
      extractJsonObject(stripCodeFences(String(text ?? "")).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, " ")),
    ),
  );
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function validToolNames(tools?: Array<Record<string, any>> | null): Set<string> {
  const names = new Set<string>();
  if (!Array.isArray(tools)) return names;
  for (const tool of tools) {
    const name = tool?.function?.name;
    if (typeof name === "string" && name.trim()) {
      names.add(name.trim());
    }
  }
  return names;
}

export function buildToolPrompt(
  tools: Array<Record<string, any>>,
  toolChoice?: unknown,
  parallelToolCalls = true,
): string {
  if (!Array.isArray(tools) || !tools.length || toolChoice === "none") {
    return "";
  }

  const lines: string[] = [
    "# Available Tools",
    "",
    'You have access to the following tools. To call a tool, output a <tool_call> block with a JSON object containing "name" and "arguments".',
    "",
    "Format:",
    "<tool_call>",
    '{"name": "function_name", "arguments": {"param": "value"}}',
    "</tool_call>",
    "",
  ];

  if (parallelToolCalls) {
    lines.push("You may make multiple tool calls in a single response by using multiple <tool_call> blocks.");
    lines.push("");
  }

  lines.push("## Tool Definitions");
  lines.push("");

  for (const tool of tools) {
    if (tool?.type !== "function") continue;
    const func = tool.function ?? {};
    const name = typeof func.name === "string" ? func.name : "";
    const description = typeof func.description === "string" ? func.description : "";
    const parameters = func.parameters;
    if (!name) continue;

    lines.push(`### ${name}`);
    if (description) lines.push(description);
    if (parameters) {
      lines.push(`Parameters: ${JSON.stringify(parameters)}`);
    }
    lines.push("");
  }

  if (toolChoice === "required") {
    lines.push("IMPORTANT: You MUST call at least one tool in your response. Do not respond with only text.");
  } else if (toolChoice && typeof toolChoice === "object") {
    const forcedName = (toolChoice as Record<string, any>)?.function?.name;
    if (typeof forcedName === "string" && forcedName.trim()) {
      lines.push(`IMPORTANT: You MUST call the tool "${forcedName.trim()}" in your response.`);
    }
  } else {
    lines.push("Decide whether to call a tool based on the user's request. If you don't need a tool, respond normally with text only.");
  }

  lines.push("");
  lines.push("When you call a tool, you may include text before or after the <tool_call> blocks, but the tool call blocks must be valid JSON.");

  return lines.join("\n");
}

export function parseToolCallBlock(
  rawJson: string,
  tools?: Array<Record<string, any>> | null,
): OpenAIToolCall | null {
  if (!rawJson) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    parsed = repairJson(rawJson);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const name = typeof (parsed as Record<string, any>).name === "string"
    ? (parsed as Record<string, any>).name.trim()
    : "";
  if (!name) return null;

  const allowedNames = validToolNames(tools);
  if (allowedNames.size && !allowedNames.has(name)) {
    return null;
  }

  const argumentsValue = (parsed as Record<string, any>).arguments ?? {};
  const argumentsString = typeof argumentsValue === "string"
    ? argumentsValue
    : JSON.stringify(argumentsValue);

  return {
    id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "function",
    function: {
      name,
      arguments: argumentsString,
    },
  };
}

export function parseToolCalls(
  content: string,
  tools?: Array<Record<string, any>> | null,
): { textContent: string | null; toolCalls: OpenAIToolCall[] | null } {
  const input = String(content ?? "");
  if (!input) {
    return { textContent: input, toolCalls: null };
  }

  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  const matches = Array.from(input.matchAll(regex));
  if (!matches.length) {
    return { textContent: input, toolCalls: null };
  }

  const toolCalls: OpenAIToolCall[] = [];
  for (const match of matches) {
    const parsed = parseToolCallBlock(match[1] ?? "", tools);
    if (parsed) toolCalls.push(parsed);
  }

  if (!toolCalls.length) {
    return { textContent: input, toolCalls: null };
  }

  const textParts: string[] = [];
  let lastEnd = 0;
  for (const match of matches) {
    const start = match.index ?? 0;
    const before = input.slice(lastEnd, start).trim();
    if (before) textParts.push(before);
    lastEnd = start + match[0].length;
  }
  const trailing = input.slice(lastEnd).trim();
  if (trailing) textParts.push(trailing);

  return {
    textContent: textParts.length ? textParts.join("\n") : null,
    toolCalls,
  };
}

export function formatToolHistory<T extends Record<string, any>>(messages: T[]): T[] {
  const result: T[] = [];
  for (const message of messages) {
    const role = message?.role ?? "";
    const content = message?.content;
    const toolCalls = message?.tool_calls;
    const toolCallId = message?.tool_call_id ?? "";
    const name = message?.name ?? "";

    if (role === "assistant" && Array.isArray(toolCalls) && toolCalls.length) {
      const parts: string[] = [];
      if (typeof content === "string" && content.trim()) {
        parts.push(content);
      }
      for (const toolCall of toolCalls) {
        const func = toolCall?.function ?? {};
        const toolName = typeof func.name === "string" ? func.name : "";
        const args = typeof func.arguments === "string"
          ? func.arguments
          : JSON.stringify(func.arguments ?? {});
        parts.push(`<tool_call>{"name":"${toolName}","arguments":${args}}</tool_call>`);
      }
      result.push({ ...message, content: parts.join("\n") });
      continue;
    }

    if (role === "tool") {
      const toolName = typeof name === "string" && name.trim() ? name.trim() : "unknown";
      const contentString = typeof content === "string"
        ? content
        : content == null
          ? ""
          : JSON.stringify(content);
      result.push({
        ...message,
        role: "user",
        content: `tool (${toolName}, ${toolCallId}): ${contentString}`,
      });
      continue;
    }

    result.push(message);
  }

  return result;
}
