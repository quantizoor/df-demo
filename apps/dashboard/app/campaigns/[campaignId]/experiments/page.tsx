"use client";

import { Beaker, Filter, Search } from "lucide-react";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { ExperimentsTable } from "../../../../components/experiments-table";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Section,
} from "../../../../components/ui";
import { useExperiments } from "../../../../lib/client/api";

export default function ExperimentsPage() {
  const { campaignId: encodedId } = useParams<{ campaignId: string }>();
  const campaignId = decodeURIComponent(encodedId);
  const { data, error, hasMore, isLoading, isLoadingMore, loadMore, mutate } =
    useExperiments(campaignId);
  const [query, setQuery] = useState("");
  const [decision, setDecision] = useState("all");
  const filtered = useMemo(
    () =>
      (data || []).filter((experiment) => {
        const matchesQuery =
          !query ||
          experiment.experimentId.toLowerCase().includes(query.toLowerCase()) ||
          experiment.hypothesisSummary?.toLowerCase().includes(query.toLowerCase());
        return matchesQuery && (decision === "all" || experiment.disposition === decision);
      }),
    [data, decision, query],
  );

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Evidence journal"
        title="Experiments"
        description="Every hypothesis, candidate, matched trial, and champion decision in durable order."
      />
      <Section>
        <div className="table-controls">
          <label className="search-field">
            <Search size={16} />
            <input
              placeholder="Search experiment or hypothesis…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label className="select-field">
            <Filter size={15} />
            <select value={decision} onChange={(event) => setDecision(event.target.value)}>
              <option value="all">All decisions</option>
              <option value="promote">Promoted</option>
              <option value="reject">Rejected</option>
              <option value="inconclusive">Inconclusive</option>
            </select>
          </label>
          <span className="result-count">{filtered.length} experiments</span>
        </div>
        {isLoading ? <LoadingState label="Loading experiment journal" /> : null}
        {error ? <ErrorState error={error} retry={() => void mutate()} /> : null}
        {!isLoading && !error && !data?.length ? (
          <EmptyState
            icon={Beaker}
            title="No experiments yet"
            description="Start this campaign to create its first hypothesis and matched evaluation."
          />
        ) : null}
        {filtered.length ? (
          <ExperimentsTable campaignId={campaignId} experiments={filtered} />
        ) : null}
        {data?.length && !filtered.length ? (
          <div className="inline-empty">
            <Search size={21} />
            <div>
              <strong>No matching experiments</strong>
              <p>Adjust the search or decision filter.</p>
            </div>
          </div>
        ) : null}
        {data?.length && hasMore ? (
          <div className="pagination-actions">
            <span>{data.length} experiments loaded</span>
            <button
              className="button button-secondary"
              type="button"
              disabled={isLoadingMore}
              onClick={() => void loadMore()}
            >
              {isLoadingMore ? "Loading older…" : "Load older experiments"}
            </button>
          </div>
        ) : null}
      </Section>
    </div>
  );
}
