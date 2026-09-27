/**
 * Plan 13 Phase 4 Task 4.2 — Topology filter sidebar.
 *
 * Four collapsible groups (Site / Vendor / Platform / Protocol). The
 * filter state uses an "empty Set === show all" model so the default
 * (no filter applied) is cheap to express. The first time a user
 * unchecks an item we materialize the set with all OTHER options to
 * make the toggle behavior intuitive; once every option is re-checked
 * we collapse back to the empty Set.
 *
 * Site is intentionally disabled in Phase 4 — there is no site
 * dimension on TopologyNode yet (lands in Plan 13.5).
 */
import { useMemo } from "react";
import "./TopologyFilterTree.css";

export interface TopologyFilterState {
  /** Phase 4: always empty (no site dimension yet). */
  sites: Set<string>;
  /** When non-empty, only nodes whose vendor key is in this set are kept. */
  vendors: Set<string>;
  /** When non-empty, only nodes whose platform is in this set are kept. */
  platforms: Set<string>;
  /** When non-empty, only edges with these protocols are kept. */
  protocols: Set<string>;
}

export interface TopologyFilterOptions {
  vendors: Set<string>;
  platforms: Set<string>;
  protocols: Set<string>;
}

export interface TopologyFilterTreeProps {
  options: TopologyFilterOptions;
  state: TopologyFilterState;
  onChange: (next: TopologyFilterState) => void;
}

type FilterKey = "vendors" | "platforms" | "protocols";

function toggle(
  current: Set<string>,
  all: Set<string>,
  value: string,
  checked: boolean,
): Set<string> {
  // Materialize the empty-Set "all" representation before mutating so
  // toggle behaviour is consistent regardless of starting state.
  const next = current.size === 0 ? new Set(all) : new Set(current);
  if (checked) next.add(value);
  else next.delete(value);
  // If the user re-checks every option, collapse back to "empty === all".
  if (next.size === all.size) return new Set();
  return next;
}

export function TopologyFilterTree({
  options,
  state,
  onChange,
}: TopologyFilterTreeProps) {
  const sortedVendors = useMemo(
    () => Array.from(options.vendors).sort(),
    [options.vendors],
  );
  const sortedPlatforms = useMemo(
    () => Array.from(options.platforms).sort(),
    [options.platforms],
  );
  const sortedProtocols = useMemo(
    () => Array.from(options.protocols).sort(),
    [options.protocols],
  );

  const isChecked = (key: FilterKey, value: string): boolean => {
    const set = state[key];
    return set.size === 0 || set.has(value);
  };

  const handleToggle = (key: FilterKey, value: string, checked: boolean) => {
    const all =
      key === "vendors"
        ? options.vendors
        : key === "platforms"
          ? options.platforms
          : options.protocols;
    onChange({ ...state, [key]: toggle(state[key], all, value, checked) });
  };

  return (
    <aside
      className="topology-filter-tree"
      data-testid="topology-filter-tree"
      aria-label="Topology filter tree"
    >
      <details
        className="topology-filter-tree__group topology-filter-tree__group--disabled"
        open={false}
      >
        <summary className="topology-filter-tree__summary">
          Site <span className="topology-filter-tree__hint">(coming soon)</span>
        </summary>
      </details>

      <details className="topology-filter-tree__group" open>
        <summary className="topology-filter-tree__summary">Vendor</summary>
        {sortedVendors.length === 0 ? (
          <div className="topology-filter-tree__empty">— none —</div>
        ) : (
          sortedVendors.map((vendor) => (
            <label
              key={vendor}
              className="topology-filter-tree__leaf"
              data-vendor={vendor}
            >
              <input
                type="checkbox"
                className="topology-filter-tree__checkbox"
                checked={isChecked("vendors", vendor)}
                onChange={(e) =>
                  handleToggle("vendors", vendor, e.target.checked)
                }
                data-testid={`topology-filter-vendor-${vendor}`}
              />
              {vendor}
            </label>
          ))
        )}
      </details>

      <details className="topology-filter-tree__group" open>
        <summary className="topology-filter-tree__summary">Platform</summary>
        {sortedPlatforms.length === 0 ? (
          <div className="topology-filter-tree__empty">— none —</div>
        ) : (
          sortedPlatforms.map((platform) => (
            <label
              key={platform}
              className="topology-filter-tree__leaf"
              data-platform={platform}
            >
              <input
                type="checkbox"
                className="topology-filter-tree__checkbox"
                checked={isChecked("platforms", platform)}
                onChange={(e) =>
                  handleToggle("platforms", platform, e.target.checked)
                }
                data-testid={`topology-filter-platform-${platform}`}
              />
              {platform}
            </label>
          ))
        )}
      </details>

      <details className="topology-filter-tree__group" open>
        <summary className="topology-filter-tree__summary">Protocol</summary>
        {sortedProtocols.length === 0 ? (
          <div className="topology-filter-tree__empty">— none —</div>
        ) : (
          sortedProtocols.map((protocol) => (
            <label
              key={protocol}
              className="topology-filter-tree__leaf"
              data-protocol={protocol}
            >
              <input
                type="checkbox"
                className="topology-filter-tree__checkbox"
                checked={isChecked("protocols", protocol)}
                onChange={(e) =>
                  handleToggle("protocols", protocol, e.target.checked)
                }
                data-testid={`topology-filter-protocol-${protocol}`}
              />
              {protocol}
            </label>
          ))
        )}
      </details>
    </aside>
  );
}
