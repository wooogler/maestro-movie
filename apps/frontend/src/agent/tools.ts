/**
 * Agent Tool Definitions
 *
 * LLM Agent가 호출할 수 있는 Tool 정의
 * Python Agent에서 이 정의를 참조하여 Tool Call을 수행
 */

export interface ToolParameter {
  type: string;
  description: string;
  enum?: string[];
  optional?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
}

/**
 * Modification Tools
 *
 * UI 데이터를 변환하는 Tool들
 * 호출 시 Frontend의 modifier 함수를 실행
 */
export const modificationTools: ToolDefinition[] = [
  {
    name: "filter",
    description:
      "Add a filter condition on the raw item data (not augmented display text). Repeated calls accumulate with AND semantics. Operates on items, not visibleItems — augmented display values are unaffected.",
    parameters: {
      field: {
        type: "string",
        description:
          'Raw item field name to filter by (e.g., "genre", "time", "format"). Use "value" only when matching the visible label text itself. Do not invent field names that do not exist on the items.',
      },
      operator: {
        type: "string",
        description: "Comparison operator",
        enum: ["eq", "neq", "contains", "gt", "lt", "gte", "lte", "in"],
      },
      value: {
        type: "any",
        description: "Value to compare against",
      },
    },
  },
  {
    name: "sort",
    description:
      "Reorder items by a field. Only meaningful for ordinal fields (e.g., rating, time, distance, price). Does not hide any items.",
    parameters: {
      field: {
        type: "string",
        description:
          'Ordinal item field to sort by (e.g., "time", "distanceMiles", "rating"). Use "value" only when sorting the visible label text itself.',
      },
      order: {
        type: "string",
        description: "Sort order",
        enum: ["asc", "desc"],
      },
    },
  },
  {
    name: "highlight",
    description:
      "Visually mark a few items without hiding others or committing to a selection. Does not change the item set or order. A highlight is read by contrast, so its value falls as the marked set grows: marking most of what is on screen distinguishes nothing, and marking all of it is inert. Use it to point at one or two choices, not as a substitute for filter. Do NOT call this tool when more than three distinct choices qualify, or when every option still on screen qualifies — call respond instead and ask one question that narrows the set. At the seat stage a choice is a whole adjacent block, not a seat: four qualifying pairs are four choices.",
    parameters: {
      itemIds: {
        type: "array",
        description:
          "Array of item IDs to highlight. Keep this to the smallest set that answers the user's question — at most three distinct choices, and never every visible item.",
      },
    },
  },
  {
    name: "augment",
    description:
      "Replace the display text (visibleItems value) of specific items to surface only the minimum missing information needed for the user's current request. This updates, not appends to, the existing display text. Does not alter the underlying raw item data.",
    parameters: {
      items: {
        type: "array",
        description:
          "Array of { itemId: string, value: string }. The value replaces the current display text. Keep the original label recognizable while adding only the fact(s) tied to the user's request.",
      },
    },
  },
  {
    name: "clearModification",
    description:
      "Clear applied modifications, including all accumulated filter conditions",
    parameters: {
      type: {
        type: "string",
        description: "Type of modification to clear",
        enum: ["filter", "sort", "highlight", "augment", "all"],
        optional: true,
      },
    },
  },
];

/**
 * Interaction Tools
 *
 * UI 상호작용을 수행하는 Tool들
 * Python Agent에서 직접 처리
 */
export const interactionTools: ToolDefinition[] = [
  {
    name: "select",
    description: "Select an item in the current stage to proceed.",
    parameters: {
      itemId: {
        type: "string",
        description: "Item ID to select",
      },
    },
  },
  {
    name: "selectMultiple",
    description:
      "Seat-stage only: replace the current selected seat set with the provided item IDs",
    parameters: {
      itemIds: {
        type: "array",
        description:
          "Array of seat item IDs that should become the full selected seat set",
      },
    },
  },
  {
    name: "next",
    description:
      "Proceed to next stage with current state (selected item is passed to next stage)",
    parameters: {},
  },
  {
    name: "prev",
    description:
      "Go back to previous stage while restoring the last compatible snapshot for that stage when available",
    parameters: {},
  },
  {
    name: "postMessage",
    description:
      "Post a very short agent message to the chat timeline. Assume it may be spoken aloud.",
    parameters: {
      text: {
        type: "string",
        description: "Very short message content to display.",
      },
    },
  },
];

/**
 * All available tools
 */
export const agentTools: ToolDefinition[] = [
  ...modificationTools,
  ...interactionTools,
];

/**
 * Tool name to category mapping
 */
export const toolCategories: Record<string, "modification" | "interaction"> = {
  filter: "modification",
  sort: "modification",
  highlight: "modification",
  augment: "modification",
  clearModification: "modification",
  select: "interaction",
  selectMultiple: "interaction",
  next: "interaction",
  prev: "interaction",
  postMessage: "interaction",
};

/**
 * Check if a tool is a modification tool
 */
export function isModificationTool(toolName: string): boolean {
  return toolCategories[toolName] === "modification";
}

/**
 * Check if a tool is an interaction tool
 */
export function isInteractionTool(toolName: string): boolean {
  return toolCategories[toolName] === "interaction";
}
