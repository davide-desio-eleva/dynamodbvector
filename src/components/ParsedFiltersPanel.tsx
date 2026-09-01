import { useState } from "react";

interface ParsedFilters {
  semanticQuery: string;
  maxPrice: number | null;
  minPrice: number | null;
  availableOnly: boolean | null;
}

interface ParsedFiltersPanelProps {
  filters: ParsedFilters;
}

export function ParsedFiltersPanel({ filters }: ParsedFiltersPanelProps) {
  const [open, setOpen] = useState(false);

  const hasFilters =
    filters.maxPrice != null ||
    filters.minPrice != null ||
    filters.availableOnly === true;

  const activeCount = [
    filters.maxPrice != null,
    filters.minPrice != null,
    filters.availableOnly === true,
  ].filter(Boolean).length;

  return (
    <div className="filters-panel">
      <button
        type="button"
        className="filters-toggle"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="filters-toggle-icon" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span>How the AI parsed your query</span>
        {hasFilters && (
          <span className="filter-badge">
            {activeCount} filter{activeCount !== 1 ? "s" : ""} applied
          </span>
        )}
      </button>

      {open && (
        <div className="filters-content">
          <div className="filter-row">
            <span className="filter-label">Semantic query</span>
            <span className="filter-value semantic">
              "{filters.semanticQuery}"
            </span>
          </div>
          <div className="filter-row">
            <span className="filter-label">→ sent to</span>
            <span className="filter-value tech">
              Bedrock Titan Embeddings → DynamoDB SearchVectors
            </span>
          </div>

          {hasFilters && (
            <>
              <div className="filters-divider" />
              <div className="filter-row">
                <span className="filter-label">Structured filters</span>
                <span className="filter-value tech">
                  applied post-search on DynamoDB attributes
                </span>
              </div>
              {filters.maxPrice != null && (
                <div className="filter-row">
                  <span className="filter-label">
                    <code>Price</code> ≤
                  </span>
                  <span className="filter-value">€{filters.maxPrice}</span>
                </div>
              )}
              {filters.minPrice != null && (
                <div className="filter-row">
                  <span className="filter-label">
                    <code>Price</code> ≥
                  </span>
                  <span className="filter-value">€{filters.minPrice}</span>
                </div>
              )}
              {filters.availableOnly && (
                <div className="filter-row">
                  <span className="filter-label">
                    <code>Available</code> =
                  </span>
                  <span className="filter-value">true</span>
                </div>
              )}
            </>
          )}

          {!hasFilters && (
            <>
              <div className="filters-divider" />
              <div className="filter-row">
                <span className="filter-label">Structured filters</span>
                <span className="filter-value muted">none detected</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
