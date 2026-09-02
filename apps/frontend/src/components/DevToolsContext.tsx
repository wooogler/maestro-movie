import { useState, useRef, useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { UISpec } from '../spec';
import { DevToolsContext, type ToolApplyContext, type ToolApplyHandler } from './devToolsContextShared';

export function DevToolsProvider({ children }: { children: ReactNode }) {
  const [backendData, setBackendData] = useState<Record<string, unknown>>({});
  const [uiSpec, setUiSpec] = useState<UISpec | null>(null);
  const onToolApplyRef = useRef<ToolApplyHandler | null>(null);

  const setOnToolApply = useCallback((handler: ToolApplyHandler | null) => {
    onToolApplyRef.current = handler;
  }, []);

  // Stable wrapper that reads the ref at call time, not at render time
  const onToolApply = useCallback(
    (toolName: string, params: Record<string, unknown>, context?: ToolApplyContext) => {
      return onToolApplyRef.current?.(toolName, params, context);
    },
    []
  );

  // The value has to be memoised, not built inline. Every consumer re-renders
  // when this object's identity changes, and ChatPage is one of them: an inline
  // object meant that ChatPage calling `setUiSpec`/`setBackendData` re-rendered
  // ChatPage once for the state change and again for the new context value,
  // dragging the whole booking GUI through both — including mid-slide.
  const value = useMemo(
    () => ({
      backendData,
      uiSpec,
      setBackendData,
      setUiSpec,
      onToolApply,
      setOnToolApply,
    }),
    [backendData, uiSpec, onToolApply, setOnToolApply]
  );

  return <DevToolsContext.Provider value={value}>{children}</DevToolsContext.Provider>;
}
