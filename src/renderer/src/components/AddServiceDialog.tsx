import { useEffect, useMemo, useState } from 'react';
import { PROVIDER_CONFIGS, PROVIDER_LIST } from '@shared/providers';
import { normalizeServiceUrl } from '@shared/tabs';
import { useAppStore } from '../store';

export function AddServiceDialog() {
  const open = useAppStore((s) => s.addOpen);
  const isBusy = useAppStore((s) => s.isBusy);
  const setAddOpen = useAppStore((s) => s.setAddOpen);
  const addTab = useAppStore((s) => s.addTab);

  const [query, setQuery] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [customLabel, setCustomLabel] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (open) return;
    setQuery('');
    setCustomUrl('');
    setCustomLabel('');
    setLocalError(null);
  }, [open]);

  const providers = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return PROVIDER_LIST
      .filter((id) => id !== 'custom')
      .map((id) => PROVIDER_CONFIGS[id])
      .filter((provider) => !needle || provider.displayName.toLowerCase().includes(needle));
  }, [query]);

  if (!open) return null;

  const close = (): void => {
    setAddOpen(false);
    setQuery('');
    setCustomUrl('');
    setCustomLabel('');
    setLocalError(null);
  };

  const addCustom = (): void => {
    if (!customUrl.trim()) {
      setLocalError('Enter the service URL');
      return;
    }
    setLocalError(null);
    void addTab({
      providerId: 'custom',
      customUrl: normalizeServiceUrl(customUrl),
      label: customLabel
    });
  };

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>Add a service</h2>
          <button className="icon-button" onClick={close} title="Close">{'\u00D7'}</button>
        </div>

        <input
          className="modal-search"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') close();
            if (event.key === 'Enter' && providers.length === 1) {
              void addTab({ providerId: providers[0].id });
            }
          }}
          placeholder="Search services…"
        />

        <div className="provider-grid">
          {providers.map((provider) => (
            <button
              key={provider.id}
              className="provider-card"
              disabled={isBusy}
              onClick={() => void addTab({ providerId: provider.id })}
            >
              <span className="provider-icon" style={{ background: provider.color }}>{provider.icon}</span>
              <span className="provider-name">{provider.displayName}</span>
            </button>
          ))}
          {providers.length === 0 && <p className="muted">No services match “{query}”.</p>}
        </div>

        <div className="custom-service">
          <h3>Custom service</h3>
          <p className="muted">Any web app works — it gets its own isolated session.</p>
          <div className="custom-row">
            <input
              value={customUrl}
              onChange={(event) => setCustomUrl(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') addCustom(); }}
              placeholder="https://example.com/chat"
            />
            <input
              className="label-input"
              value={customLabel}
              onChange={(event) => setCustomLabel(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') addCustom(); }}
              placeholder="Label (optional)"
            />
            <button className="primary-button" onClick={addCustom} disabled={isBusy}>Add</button>
          </div>
          {localError && <p className="form-error">{localError}</p>}
        </div>

        <p className="modal-hint">
          Tip: add the same service twice to use two different accounts — each tab
          keeps its own cookies.
        </p>
      </div>
    </div>
  );
}
