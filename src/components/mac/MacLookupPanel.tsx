import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  getMacRegistryInfo, lookupMacAddress, updateMacRegistry,
  type MacLookupResult, type RegistryInfo,
} from '../../lib/macLookup';
import { CopyButton } from '../subnet/shared/CopyButton';
import { ResultCard } from '../subnet/shared/ResultCard';
import './MacLookupPanel.css';

const ieeeSources: Record<string, string> = {
  'MA-L': 'https://standards-oui.ieee.org/oui/oui.csv',
  'MA-M': 'https://standards-oui.ieee.org/oui28/mam.csv',
  'MA-S': 'https://standards-oui.ieee.org/oui36/oui36.csv',
  CID: 'https://standards-oui.ieee.org/cid/cid.csv',
  IAB: 'https://standards-oui.ieee.org/iab/iab.csv',
};
const formatLabels = { colon: 'Colon', hyphen: 'Hyphen', dotted: 'Cisco dotted', plain: 'Plain' };

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'An unexpected backend error occurred. Please try again.';
}

export function MacLookupPanel() {
  const [address, setAddress] = useState('');
  const [result, setResult] = useState<MacLookupResult | null>(null);
  const [registry, setRegistry] = useState<RegistryInfo | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [updating, setUpdating] = useState(false);
  const generation = useRef(0);
  const metadataGeneration = useRef(0);

  useEffect(() => {
    let active = true;
    const version = metadataGeneration.current;
    getMacRegistryInfo().then((info) => {
      if (active && version === metadataGeneration.current) setRegistry(info);
    }).catch((error: unknown) => {
      if (active && version === metadataGeneration.current) {
        setRegistryError(`Registry information unavailable: ${errorMessage(error)}`);
      }
    });
    return () => {
      active = false;
      generation.current++;
      metadataGeneration.current++;
    };
  }, []);

  const handleLookup = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!address.trim() || updating) return;
    const request = ++generation.current;
    setLookingUp(true);
    setLookupError(null);
    try {
      const next = await lookupMacAddress(address.trim());
      if (request !== generation.current) return;
      metadataGeneration.current++;
      setResult(next);
      setRegistry(next.registry);
      setRegistryError(null);
    } catch (error: unknown) {
      if (request === generation.current) {
        setLookupError(errorMessage(error));
        setResult(null);
      }
    } finally {
      if (request === generation.current) setLookingUp(false);
    }
  };

  const handleUpdate = async () => {
    if (updating) return;
    const request = ++generation.current;
    metadataGeneration.current++;
    const displayedAddress = result?.normalized;
    let downloaded = false;
    setLookingUp(false);
    setUpdating(true);
    setRegistryError(null);
    try {
      const info = await updateMacRegistry();
      if (request !== generation.current) return;
      downloaded = true;
      setRegistry(info);
      if (displayedAddress) {
        const refreshed = await lookupMacAddress(displayedAddress);
        if (request !== generation.current) return;
        setResult(refreshed);
        setRegistry(refreshed.registry);
      }
    } catch (error: unknown) {
      if (request !== generation.current) return;
      setRegistryError(downloaded
        ? `Registry updated, but the displayed lookup could not be refreshed: ${errorMessage(error)} Previous lookup result is still shown; look up again to retry.`
        : `Registry update failed: ${errorMessage(error)} The previous dataset stays active.`);
    } finally {
      if (request === generation.current) setUpdating(false);
    }
  };

  return (
    <section className="mac-lookup" aria-label="MAC address lookup">
      <header className="mac-lookup-header">
        <div>
          <h2>Lookup a MAC address</h2>
          <p>Look up IEEE assignments locally. No network request is needed for a lookup.</p>
        </div>
        <button type="button" onClick={handleUpdate} disabled={updating}>Update Registry</button>
      </header>

      <form onSubmit={handleLookup} className="mac-lookup-form">
        <label htmlFor="mac-lookup-address">MAC address</label>
        <div className="mac-lookup-input-row">
          <input
            id="mac-lookup-address"
            value={address}
            onChange={(event) => {
              generation.current++;
              setAddress(event.target.value);
              setResult(null);
              setLookingUp(false);
              setLookupError(null);
            }}
            placeholder="00:11:22:33:44:55 · 0011.2233.4455 · 001122334455"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            disabled={updating}
            aria-invalid={Boolean(lookupError)}
            aria-describedby={lookupError ? 'mac-lookup-help mac-lookup-error' : 'mac-lookup-help'}
          />
          <button type="submit" disabled={!address.trim() || lookingUp || updating}>Look up</button>
        </div>
        <p id="mac-lookup-help" className="mac-lookup-muted">Accepts colon, hyphen, Cisco dotted, or bare hexadecimal notation.</p>
        {lookupError && <p id="mac-lookup-error" className="mac-lookup-error" role="alert">{lookupError}</p>}
      </form>

      <p className="mac-lookup-status" role="status" aria-live="polite">
        {updating ? 'Downloading and validating IEEE registries…' : lookingUp ? 'Looking up MAC address…' : ''}
      </p>
      {registryError && <p className="mac-lookup-error" role="alert">{registryError}</p>}

      {result && (
        <div className="mac-lookup-results">
          <ResultCard title="Address identity">
            <dl>
              <div><dt>Normalized MAC</dt><dd><code>{result.normalized}</code></dd></div>
              <div><dt>OUI (first 24 bits)</dt><dd><code>{result.oui}</code></dd></div>
              <div><dt>Binary</dt><dd className="mac-lookup-value"><code>{result.binary}</code><CopyButton text={result.binary} /></dd></div>
            </dl>
          </ResultCard>

          <ResultCard title="IEEE assignment">
            {result.assignment ? (
              <>
                <h4 className="mac-lookup-organization">{result.assignment.organization}</h4>
                <p className="mac-lookup-muted">
                  {result.assignment.registry === 'CID'
                    ? 'CID identifies a registered local assignee, not a device manufacturer.'
                    : 'Registered organization for this address block; this does not identify a device model.'}
                </p>
                <dl>
                  <div><dt>Registry / prefix</dt><dd><code>{result.assignment.registry} · {result.assignment.prefix}/{result.assignment.prefix_length}</code></dd></div>
                  <div><dt>Postal address</dt><dd className="mac-lookup-postal">{result.assignment.organization_address || 'Not provided in the registry'}</dd></div>
                  <div><dt>Block start</dt><dd><code>{result.assignment.block_start}</code></dd></div>
                  <div><dt>Block end</dt><dd><code>{result.assignment.block_end}</code></dd></div>
                  <div><dt>Block size</dt><dd>{result.assignment.address_count.toLocaleString('en-US')} addresses</dd></div>
                </dl>
              </>
            ) : (
              <p>No IEEE assignment found in the active dataset. This does not identify a device model or establish a manufacturer.</p>
            )}
            {result.is_locally_administered && (
              <p className="mac-lookup-notice">Locally administered addresses may be randomized or manually assigned; a matching prefix is not reliable evidence of the device manufacturer.</p>
            )}
          </ResultCard>

          <ResultCard title="Address flags">
            <ul className="mac-lookup-flags">
              <li>{result.is_multicast ? 'Multicast' : 'Unicast'}</li>
              <li>{result.is_locally_administered ? 'Locally administered' : 'Universally administered'}</li>
              {result.is_broadcast && <li>Broadcast</li>}
              {result.is_zero && <li>All-zero address</li>}
            </ul>
            {result.warnings.length > 0 && (
              <ul className="mac-lookup-warnings">{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
            )}
          </ResultCard>

          <ResultCard title="Address formats">
            <dl>{(Object.keys(formatLabels) as (keyof typeof formatLabels)[]).map((format) => (
              <div key={format}>
                <dt>{formatLabels[format]}</dt>
                <dd className="mac-lookup-value"><code>{result.formats[format]}</code><CopyButton text={result.formats[format]} /></dd>
              </div>
            ))}</dl>
          </ResultCard>
        </div>
      )}

      <footer className="mac-lookup-registry">
        <h3>Registry data</h3>
        {registry ? (
          <>
            <p>{registry.loaded_from === 'updated' ? 'Updated snapshot' : 'Bundled snapshot'} · <time dateTime={registry.snapshot_at}>{registry.snapshot_at}</time> · {registry.record_count.toLocaleString('en-US')} records</p>
            <ul className="mac-lookup-sources">{registry.sources.map((source) => (
              <li key={source.registry}>
                {ieeeSources[source.registry] === source.url
                  ? <a href={ieeeSources[source.registry]} target="_blank" rel="noopener noreferrer">IEEE {source.registry}</a>
                  : <span>{source.registry}: {source.url}</span>}
              </li>
            ))}</ul>
            {registry.cache_warning && <p className="mac-lookup-notice">{registry.cache_warning}</p>}
          </>
        ) : <p className="mac-lookup-muted">Registry metadata is not yet available.</p>}
        <p className="mac-lookup-muted">Update Registry downloads and validates the IEEE datasets. Failed updates leave the previous dataset active.</p>
      </footer>
    </section>
  );
}
