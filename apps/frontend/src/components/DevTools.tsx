import { useState } from 'react';
import type { ReactNode } from 'react';
import { useDevTools } from './devToolsContextShared';
import type { ToolApplyContext } from './devToolsContextShared';
import { agentTools, toolCategories } from '../agent/tools';
import type { ToolDefinition } from '../agent/tools';
import type { UISpec } from '../spec';

type Tab = 'workflow' | 'backend' | 'spec';

export function DevTools() {
  const { backendData, uiSpec, onToolApply } = useDevTools();
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('spec');
  const [isExpanded, setIsExpanded] = useState(false);

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="fixed right-4 top-1/2 -translate-y-1/2 bg-dark-lighter text-fg-strong px-2 py-4 rounded-lg shadow-lg hover:bg-dark-border transition-colors z-50"
        title="Open Agent Console"
      >
        &lt;
      </button>
    );
  }

  const width = isExpanded ? 'w-[60vw]' : 'w-96';

  return (
    <div
      className={`h-screen ${width} bg-dark-lighter border-l border-dark-border shadow-2xl flex flex-col transition-all duration-300`}
    >
      {/* Header */}
      <div className="bg-dark border-b border-dark-border p-3 flex items-center justify-between">
        <h2 className="text-fg-strong font-semibold">Agent Console</h2>
        <div className="flex gap-2">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="text-fg-muted hover:text-fg-strong transition-colors px-2"
            title={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded ? '←' : '→'}
          </button>
          <button
            onClick={() => setIsOpen(false)}
            className="text-fg-muted hover:text-fg-strong transition-colors px-2"
            title="Close"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex bg-dark-border overflow-x-auto">
        <TabButton
          active={activeTab === 'workflow'}
          onClick={() => setActiveTab('workflow')}
        >
          Workflow
        </TabButton>
        <TabButton
          active={activeTab === 'backend'}
          onClick={() => setActiveTab('backend')}
        >
          Backend
        </TabButton>
        <TabButton active={activeTab === 'spec'} onClick={() => setActiveTab('spec')}>
          UI Spec
        </TabButton>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-auto p-4 min-h-0">
        {activeTab === 'workflow' && (
          <JsonViewer
            data={
              uiSpec?.state.workflow
                ? { stage: uiSpec.stage, workflow: uiSpec.state.workflow }
                : uiSpec?.state.booking
                ? { stage: uiSpec.stage, workflow: uiSpec.state.booking }
                : { message: 'No workflow context' }
            }
          />
        )}
        {activeTab === 'backend' && (
          <JsonViewer data={backendData || { message: 'No backend data' }} />
        )}
        {activeTab === 'spec' && (
          <JsonViewer data={uiSpec || { message: 'No UI spec' }} />
        )}
      </div>

      {/* Agent Tools - Always visible at bottom */}
      <div className="border-t border-dark-border bg-dark">
        <div className="p-3 border-b border-dark-border">
          <h3 className="text-fg-strong font-semibold text-sm">Agent Actions</h3>
        </div>
        <div className="p-4 max-h-80 overflow-auto">
          <AgentToolsPanel
            tools={agentTools}
            onApply={onToolApply}
            hasSpec={!!uiSpec}
            uiSpec={uiSpec}
          />
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium transition-colors whitespace-nowrap ${
        active
          ? 'bg-dark-lighter text-fg-strong border-b-2 border-primary'
          : 'text-fg-muted hover:text-fg-strong hover:bg-dark-lighter/50'
      }`}
    >
      {children}
    </button>
  );
}

function JsonViewer({ data }: { data: unknown }) {
  const [editMode, setEditMode] = useState(false);
  const [jsonText, setJsonText] = useState('');

  const formattedJson = JSON.stringify(data, null, 2);

  if (!editMode) {
    return (
      <div className="space-y-2">
        <button
          onClick={() => {
            setJsonText(formattedJson);
            setEditMode(true);
          }}
          className="px-3 py-1 bg-primary text-primary-fg text-xs rounded hover:bg-primary-hover transition-colors"
        >
          Edit Mode
        </button>
        <pre className="bg-dark p-4 rounded-lg text-xs text-fg overflow-auto font-mono whitespace-pre-wrap break-words">
          {formattedJson}
        </pre>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <button
          onClick={() => setEditMode(false)}
          className="px-3 py-1 bg-dark-border text-fg-strong text-xs rounded hover:bg-dark transition-colors"
        >
          View Mode
        </button>
        <button
          onClick={() => {
            try {
              JSON.parse(jsonText);
              alert('Valid JSON ✓');
            } catch (e) {
              alert(`Invalid JSON: ${(e as Error).message}`);
            }
          }}
          className="px-3 py-1 bg-accent text-accent-fg text-xs rounded hover:bg-accent-hover transition-colors"
        >
          Validate
        </button>
        <button
          onClick={() => {
            navigator.clipboard.writeText(jsonText);
            alert('Copied to clipboard!');
          }}
          className="px-3 py-1 bg-primary text-primary-fg text-xs rounded hover:bg-primary-hover transition-colors"
        >
          Copy
        </button>
      </div>
      <textarea
        value={jsonText}
        onChange={(e) => setJsonText(e.target.value)}
        className="w-full h-[calc(100vh-200px)] bg-dark p-4 rounded-lg text-xs text-fg font-mono resize-none focus:outline-none focus:ring-2 focus:ring-primary"
        spellCheck={false}
      />
    </div>
  );
}

// Agent Tools Panel
interface AgentToolsPanelProps {
  tools: ToolDefinition[];
  onApply: (toolName: string, params: Record<string, unknown>, context?: ToolApplyContext) => void;
  hasSpec: boolean;
  uiSpec: UISpec | null;
}

function parseArrayInput(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      throw new Error('Value must be an array');
    }
    return parsed;
  } catch {
    const fallback = value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (fallback.length === 0) {
      throw new Error('Value must be a JSON array or comma-separated list');
    }
    return fallback;
  }
}

function AgentToolsPanel({ tools, onApply, hasSpec, uiSpec }: AgentToolsPanelProps) {
  const [selectedTool, setSelectedTool] = useState<string>(tools[0]?.name || '');
  const [params, setParams] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [lastResult, setLastResult] = useState<string | null>(null);

  const currentTool = tools.find((t) => t.name === selectedTool);
  const isModificationSelected = toolCategories[selectedTool] === 'modification';
  const exampleIds = (uiSpec?.visibleItems ?? []).slice(0, 2).map((item) => item.id);

  const handleToolChange = (toolName: string) => {
    setSelectedTool(toolName);
    setParams({});
    setReason('');
    setLastResult(null);
  };

  const handleParamChange = (paramName: string, value: string) => {
    setParams((prev) => ({ ...prev, [paramName]: value }));
  };

  const handleApply = () => {
    if (!currentTool) return;

    // Convert params to proper types
    const typedParams: Record<string, unknown> = {};
    for (const [key, paramDef] of Object.entries(currentTool.parameters)) {
      const value = params[key];
      if (value === undefined || value === '') {
        if (!paramDef.optional) {
          setLastResult(`Error: Missing required parameter "${key}"`);
          return;
        }
        continue;
      }

      // Type conversion
      if (paramDef.type === 'array') {
        try {
          typedParams[key] = parseArrayInput(value);
        } catch {
          setLastResult(`Error: "${key}" must be JSON array or comma-separated list`);
          return;
        }
      } else if (paramDef.type === 'object') {
        try {
          typedParams[key] = JSON.parse(value);
        } catch {
          setLastResult(`Error: Invalid JSON for "${key}"`);
          return;
        }
      } else if (paramDef.type === 'number') {
        typedParams[key] = Number(value);
      } else {
        typedParams[key] = value;
      }
    }

    try {
      const trimmedReason = reason.trim();
      onApply(selectedTool, typedParams, {
        source: 'devtools',
        reason: trimmedReason || undefined,
      });
      setLastResult(`✓ Applied ${selectedTool}`);
    } catch (e) {
      setLastResult(`Error: ${(e as Error).message}`);
    }
  };

  if (!hasSpec) {
    return (
      <div className="text-fg-faint text-center py-4 text-sm">
        No UI Spec available
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Tool Selector */}
      <div>
        <select
          value={selectedTool}
          onChange={(e) => handleToolChange(e.target.value)}
          className="w-full bg-dark border border-dark-border rounded px-3 py-2 text-fg-strong text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <optgroup label="Modification Tools">
            {tools
              .filter((t) => toolCategories[t.name] === 'modification')
              .map((tool) => (
                <option key={tool.name} value={tool.name}>
                  {tool.name}
                </option>
              ))}
          </optgroup>
          <optgroup label="Interaction Tools">
            {tools
              .filter((t) => toolCategories[t.name] === 'interaction' && t.name !== 'postMessage')
              .map((tool) => (
                <option key={tool.name} value={tool.name}>
                  {tool.name}
                </option>
              ))}
          </optgroup>
          <optgroup label="Message Actions">
            {tools
              .filter((t) => t.name === 'postMessage')
              .map((tool) => (
                <option key={tool.name} value={tool.name}>
                  {tool.name}
                </option>
              ))}
          </optgroup>
        </select>
      </div>

      {/* Parameters */}
      {currentTool && Object.keys(currentTool.parameters).length > 0 && (
        <div className="space-y-2">
          {Object.entries(currentTool.parameters).map(([paramName, paramDef]) => (
            <div key={paramName}>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-fg-strong text-xs">{paramName}</span>
                {paramDef.optional && (
                  <span className="text-fg-faint text-xs">(opt)</span>
                )}
              </div>
              {paramDef.enum ? (
                <select
                  value={params[paramName] || ''}
                  onChange={(e) => handleParamChange(paramName, e.target.value)}
                  className="w-full bg-dark-lighter border border-dark-border rounded px-2 py-1.5 text-fg-strong text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="">Select...</option>
                  {paramDef.enum.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              ) : paramDef.type === 'array' || paramDef.type === 'object' ? (
                <textarea
                  value={params[paramName] || ''}
                  onChange={(e) => handleParamChange(paramName, e.target.value)}
                  placeholder={
                    currentTool.name === 'augment' && paramName === 'items'
                      ? `[{"itemId": "${exampleIds[0] || 'id1'}", "value": "New Text"}]`
                      : currentTool.name === 'highlight' && paramName === 'itemIds'
                      ? exampleIds.length > 0
                        ? JSON.stringify(exampleIds)
                        : '["id1", "id2"]'
                      : currentTool.name === 'postMessage' && paramName === 'text'
                      ? 'I will select a date next to narrow the options.'
                      : paramDef.type === 'array'
                      ? '["id1", "id2"]'
                      : '{ "key": "value" }'
                  }
                  className="w-full bg-dark-lighter border border-dark-border rounded px-2 py-1.5 text-fg-strong text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary h-14 resize-none"
                />
              ) : (
                <input
                  type="text"
                  value={params[paramName] || ''}
                  onChange={(e) => handleParamChange(paramName, e.target.value)}
                  placeholder={paramDef.description}
                  className="w-full bg-dark-lighter border border-dark-border rounded px-2 py-1.5 text-fg-strong text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Reason (for modification tools) */}
      {isModificationSelected && (
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-fg-strong text-xs">reason</span>
            <span className="text-fg-faint text-xs">(optional)</span>
          </div>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder='e.g. Filter to evening-friendly options as requested by user.'
            className="w-full bg-dark-lighter border border-dark-border rounded px-2 py-1.5 text-fg-strong text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary h-14 resize-none"
          />
        </div>
      )}

      {/* Apply Button & Result */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleApply}
          disabled={!hasSpec}
          className="px-4 py-1.5 bg-primary text-primary-fg text-sm rounded hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Apply
        </button>
        {lastResult && (
          <span
            className={`text-xs ${
              lastResult.startsWith('Error') ? 'text-danger-text' : 'text-green-400'
            }`}
          >
            {lastResult}
          </span>
        )}
        {!hasSpec && (
          <span className="text-accent-text text-xs">No spec loaded</span>
        )}
      </div>
    </div>
  );
}
