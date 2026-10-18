import { useEffect, useState } from 'react';
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

export function Sidebar({ version, onAdd }: Props) {
  const tabs = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const runtime = useAppStore((s) => s.runtime);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const removeTab = useAppStore((s) => s.removeTab);
  const reorderTabs = useAppStore((s) => s.reorderTabs);
  const renameTab = useAppStore((s) => s.renameTab);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

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
    <aside className="sidebar">
      <div className="sidebar-brand" title="ALLAI-CHAT">
        <span className="brand-allai">ALLAI</span>
        <span className="brand-chat">CHAT</span>
      </div>

      <div className="tab-list">
        {tabs.map((tab) => {
          const info = runtime[tab.id];
          const isActive = tab.id === activeTabId;
          const title = info?.title || tab.url;
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
        <span>Add service</span>
      </button>

      <div className="sidebar-footer">v{version}</div>
    </aside>
  );
}
