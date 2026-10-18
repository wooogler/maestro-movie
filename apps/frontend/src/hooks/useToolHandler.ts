import { useEffect, useCallback } from 'react';
import { useDevTools } from '../components/devToolsContextShared';
import { isModificationTool } from '../agent/tools';
import type { ToolApplyContext } from '../components/devToolsContextShared';
import {
  selectItem,
  selectItems,
  toggleItem,
  applyFilter,
  applySort,
  applyHighlight,
  applyAugment,
  clearModification,
  type UISpec,
  type DataItem,
  type FilterState,
  type SortState,
  type HighlightState,
} from '../spec';

interface SetSpecOptions {
  appendAsSystemMessage?: boolean;
  modificationMeta?: {
    toolName: string;
    reason: string;
    source: 'agent' | 'devtools';
    preferenceIds?: string[];
  };
  interactionMeta?: {
    action: string;
    source: 'agent' | 'devtools';
    itemId?: string;
    itemIds?: string[];
  };
}

interface UseToolHandlerOptions<T extends DataItem> {
  spec: UISpec<T> | null;
  setSpec: (spec: UISpec<T>, options?: SetSpecOptions) => void;
  onNext?: (context?: ToolApplyContext) => void;
  onBack?: (context?: ToolApplyContext) => void;
  onPostMessage?: (text: string) => void;
  multiSelect?: boolean;
}

export function useToolHandler<T extends DataItem>({
  spec,
  setSpec,
  onNext,
  onBack,
  onPostMessage,
  multiSelect = false,
}: UseToolHandlerOptions<T>) {
  const { setUiSpec, setOnToolApply } = useDevTools();

  const handleToolApply = useCallback(
    (toolName: string, params: Record<string, unknown>, context?: ToolApplyContext) => {
      if (!spec) return;

      try {
        let newSpec = spec;

        switch (toolName) {
          case 'filter': {
            const filteredSpec = applyFilter(spec, params as unknown as FilterState);
            if (context?.source !== 'devtools' && filteredSpec.visibleItems.length === 0) {
              throw new Error('filter would leave no visible items');
            }
            newSpec = filteredSpec;
            break;
          }
          case 'sort':
            newSpec = applySort(spec, params as unknown as SortState);
            break;
          case 'highlight':
            newSpec = applyHighlight(spec, params as unknown as HighlightState);
            break;
          case 'augment': {
            const { items } = params as {
              items: { itemId: string; value: string }[];
            };

            // Validate items format
            if (!Array.isArray(items) || items.length === 0) {
              throw new Error('augment requires a non-empty array of items');
            }

            for (const item of items) {
              if (!item || typeof item !== 'object') {
                throw new Error('Each item must be an object with itemId and value');
              }
              if (typeof item.itemId !== 'string' || !item.itemId) {
                throw new Error('Each item must have a non-empty "itemId" string property');
              }
              if (typeof item.value !== 'string') {
                throw new Error('Each item must have a "value" string property');
              }
            }

            newSpec = applyAugment(spec, items);
            break;
          }
          case 'clearModification': {
            const type = params.type as 'filter' | 'sort' | 'highlight' | 'augment' | 'all' | undefined;
            newSpec = clearModification(spec, type);
            break;
          }
          case 'select': {
            const itemId = params.itemId as string;
            if (multiSelect) {
              newSpec = toggleItem(spec, itemId);
            } else {
              newSpec = selectItem(spec, itemId);
            }
            // Clear selectionRestored so a new agent selection renders as 'active' (bright), not 'visited' (dim)
            if (newSpec.meta?.selectionRestored) {
              const { selectionRestored: _, ...restMeta } = newSpec.meta;
              newSpec = { ...newSpec, meta: Object.keys(restMeta).length > 0 ? restMeta : undefined };
            }
            break;
          }
          case 'selectMultiple': {
            if (!multiSelect) {
              throw new Error('selectMultiple is only supported in multi-select stages');
            }
            const rawItemIds = params.itemIds;
            if (!Array.isArray(rawItemIds)) {
              throw new Error('selectMultiple requires an "itemIds" array');
            }

            const itemIds = Array.from(
              new Set(
                rawItemIds
                  .filter((value): value is string => typeof value === 'string')
                  .map((value) => value.trim())
                  .filter(Boolean)
              )
            );

            if (itemIds.length === 0) {
              throw new Error('selectMultiple requires at least one non-empty item ID');
            }

            const selectable = new Set(
              spec.visibleItems
                .filter((item) => !item.isDisabled)
                .map((item) => item.id)
            );
            for (const itemId of itemIds) {
              if (!selectable.has(itemId)) {
                throw new Error(`selectMultiple received unavailable item ID "${itemId}"`);
              }
            }

            newSpec = selectItems(spec, itemIds);
            // Clear selectionRestored so a new agent selection renders as 'active' (bright), not 'visited' (dim)
            if (newSpec.meta?.selectionRestored) {
              const { selectionRestored: _, ...restMeta } = newSpec.meta;
              newSpec = { ...newSpec, meta: Object.keys(restMeta).length > 0 ? restMeta : undefined };
            }
            break;
          }
          case 'next':
            onNext?.(context);
            return null;
          case 'prev':
            onBack?.(context);
            return null;
          case 'postMessage': {
            const text = params.text as string;
            if (typeof text !== 'string' || !text.trim()) {
              throw new Error('postMessage requires a non-empty "text" string');
            }
            onPostMessage?.(text.trim());
            return null;
          }
          default:
            console.warn(`Unknown tool: ${toolName}`);
            return null;
        }

        const isModification = isModificationTool(toolName);
        const shouldAppendSystemSnapshot =
          isModification || toolName === 'select' || toolName === 'selectMultiple';
        const source = context?.source === 'devtools' ? 'devtools' : 'agent';
        const reason = typeof context?.reason === 'string' && context.reason.trim()
          ? context.reason.trim()
          : source === 'devtools'
          ? 'Manual GUI modification from DevTools.'
          : `Apply ${toolName} to reflect user intent in the current UI.`;

        setSpec(newSpec as UISpec<T>, {
          appendAsSystemMessage: shouldAppendSystemSnapshot,
          modificationMeta: shouldAppendSystemSnapshot
            ? {
                toolName,
                reason,
                source,
                // Spread only when present, so a snapshot that was never
                // preference-driven carries no field for it.
                ...(source === 'agent' && context?.preferenceIds && context.preferenceIds.length > 0
                  ? { preferenceIds: context.preferenceIds.slice() }
                  : {}),
              }
            : undefined,
          interactionMeta:
            toolName === 'select'
              ? {
                  action: multiSelect ? 'toggle' : 'select',
                  source,
                  itemId: typeof params.itemId === 'string' ? params.itemId : undefined,
                }
              : toolName === 'selectMultiple'
              ? {
                  action: 'selectMultiple',
                  source,
                  itemIds: Array.isArray(params.itemIds)
                    ? params.itemIds.filter((value): value is string => typeof value === 'string')
                    : undefined,
                }
              : undefined,
        });
        setUiSpec(newSpec);
        return newSpec as UISpec<T>;
      } catch (error) {
        console.error(`Tool application failed for ${toolName}:`, error);
        throw error; // Re-throw to let DevTools display the error
      }
    },
    [spec, setSpec, setUiSpec, onNext, onBack, onPostMessage, multiSelect]
  );

  // Register tool handler
  useEffect(() => {
    setOnToolApply(handleToolApply);
    return () => setOnToolApply(null);
  }, [handleToolApply, setOnToolApply]);

  return { handleToolApply };
}
