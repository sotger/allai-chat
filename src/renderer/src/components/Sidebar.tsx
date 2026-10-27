import { useCallback, useEffect, useRef, useState } from 'react';
import type { ServiceTab } from '@shared/types';
import { useAppStore } from '../store';

function TabIcon({ tab, favicon }: { tab: ServiceTab; favicon?: string }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [favicon]);

  if (favicon && !failed) {
    return (
      <img
        key={favicon}
        className="tab-favicon"
        src={favicon}
        alt=""
        draggable={false}
        onError={() => setFailed(true)}
      />
    );
  }

  return <span className="tab-badge" style={{ background: tab.color }}>{tab.icon}</span>;
}

interface Props {
  version: string;
  onAdd: () => void;
}

type SidebarMode = 'compact' | 'rail';

const SIDEBAR_MODE_KEY = 'allai.sidebar-mode';
const SIDEBAR_WIDTH_KEY = 'allai.sidebar-width';

const DEFAULT_WIDTH = 152;
const MIN_WIDTH = 140;
const MAX_WIDTH = 420;

function readSidebarMode(): SidebarMode {
  return localStorage.getItem(SIDEBAR_MODE_KEY) === 'rail' ? 'rail' : 'compact';
}

function clampWidth(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));
}

function readSidebarWidth(): number {
  const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(stored) && stored > 0 ? clampWidth(stored) : DEFAULT_WIDTH;
}

export function Sidebar({ version, onAdd }: Props) {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const runtime = useAppStore((s) => s.runtime);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const removeTab = useAppStore((s) => s.removeTab);
  const reorderTabs = useAppStore((s) => s.reorderTabs);
  const renameTab = useAppStore((s) => s.renameTab);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);

  const [mode, setMode] = useState<SidebarMode>(readSidebarMode);
  const [width, setWidth] = useState(readSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const widthRef = useRef(width);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const toggleMode = (): void => {
    setMode((previous) => {
      const next: SidebarMode = previous === 'rail' ? 'compact' : 'rail';
      localStorage.setItem(SIDEBAR_MODE_KEY, next);
      return next;
    });
  };

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  const persistWidth = useCallback((next: number) => {
    setWidth(next);
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
  }, []);

  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    setResizing(true);

    const onMove = (moveEvent: PointerEvent): void => {
      const next = clampWidth(moveEvent.clientX);
      widthRef.current = next;
      setWidth(next);
    };

    const onUp = (): void => {
      target.releasePointerCapture(event.pointerId);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      setResizing(false);
      persistWidth(widthRef.current);
    };

    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  };

  const resetWidth = (): void => persistWidth(DEFAULT_WIDTH);

  const startRename = (tab: ServiceTab): void => {
    setEditingId(tab.id);
    setDraft(tab.label);
  };

  const commitRename = (): void => {
    if (editingId) void renameTab(editingId, draft);
    setEditingId(null);
  };

  const handleDrop = (targetId: string): void => {
    if (!draggingId || draggingId === targetId) {
      setDraggingId(null);
      return;
    }
    const ids = tabs.map((tab) => tab.id);
    const from = ids.indexOf(draggingId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) {
      setDraggingId(null);
      return;
    }
    ids.splice(from, 1);
    ids.splice(to, 0, draggingId);
    setDraggingId(null);
    void reorderTabs(ids);
  };

  return (
    <aside
      className={`sidebar ${mode} ${resizing ? 'resizing' : ''}`}
      style={mode === 'compact' ? { width, flexBasis: width } : undefined}
    >
      <div className="sidebar-brand">
        <span className="brand-mark">
          {mode === 'rail' ? (
            <span className="brand-allai">A</span>
          ) : (
            <>
              <span className="brand-allai">ALLAI</span>
              <span className="brand-chat">CHAT</span>
            </>
          )}
        </span>
        <button
          className="sidebar-toggle"
          onClick={toggleMode}
          title={mode === 'rail' ? 'Expand sidebar' : 'Collapse to icons'}
        >
          {mode === 'rail' ? '\u00BB' : '\u00AB'}
        </button>
      </div>

      <div className="tab-list">
        {tabs.map((tab) => {
          const info = runtime[tab.id];
          const isActive = tab.id === activeTabId;
          const title = info?.title ? `${tab.label} — ${info.title}` : `${tab.label} — ${tab.url}`;
          return (
            <div
              key={tab.id}
              className={`service-tab ${isActive ? 'active' : ''} ${draggingId === tab.id ? 'dragging' : ''}`}
              title={title}
              draggable={editingId !== tab.id}
              onDragStart={() => setDraggingId(tab.id)}
              onDragEnd={() => setDraggingId(null)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => handleDrop(tab.id)}
              onClick={() => void setActiveTab(tab.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                void window.allai.showTabContextMenu(tab.id);
              }}
              onDoubleClick={() => startRename(tab)}
            >
              <span className="tab-accent" style={{ background: tab.color }} />
              <TabIcon tab={tab} favicon={info?.favicon} />

              {editingId === tab.id ? (
                <input
                  className="tab-rename"
                  autoFocus
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitRename();
                    if (event.key === 'Escape') setEditingId(null);
                  }}
                  onClick={(event) => event.stopPropagation()}
                />
              ) : (
                <span className="tab-label">{tab.label}</span>
              )}

              {info?.loading && <span className="tab-spinner" />}

              <button
                className="tab-close"
                title="Close service"
                onClick={(event) => {
                  event.stopPropagation();
                  void removeTab(tab.id);
                }}
              >
                {'\u00D7'}
              </button>
            </div>
          );
        })}
      </div>

      <button className="add-service" onClick={onAdd} title="Add service (Cmd/Ctrl+T)">
        <span className="add-plus">+</span>
        <span className="add-label">Add service</span>
      </button>

      {mode === 'compact' && (
        <div
          className="sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          title="Drag to resize · double-click to reset"
          onPointerDown={startResize}
          onDoubleClick={resetWidth}
        />
      )}

      <div className="sidebar-footer">
        <button className="sidebar-settings" onClick={() => setSettingsOpen(true)} title="Settings (Cmd/Ctrl+,)">
          {'\u2699'}
        </button>
        <span>v{version}</span>
      </div>
    </aside>
  );
}
