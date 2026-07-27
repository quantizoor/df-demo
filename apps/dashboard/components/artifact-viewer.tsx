"use client";

import { Download, FileCode2, LoaderCircle, Pause, Radio, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getArtifactChunk } from "../lib/client/api";
import type { ArtifactDescriptor } from "../lib/client/types";

const MAXIMUM_VISIBLE_ARTIFACT_CHARACTERS = 2 * 1024 * 1024;

export function ArtifactViewer({
  campaignId,
  experimentId,
  artifacts,
  preferredCategory,
  initiallyFollow = false,
}: {
  campaignId: string;
  experimentId: string;
  artifacts: ArtifactDescriptor[];
  preferredCategory?: string;
  initiallyFollow?: boolean;
}) {
  const eligibleArtifacts = useMemo(
    () =>
      preferredCategory
        ? artifacts.filter((artifact) => artifact.category === preferredCategory)
        : artifacts,
    [artifacts, preferredCategory],
  );
  const preferred = eligibleArtifacts[0];
  const [selected, setSelected] = useState(preferred?.id || "");
  const [content, setContent] = useState("");
  const [nextOffset, setNextOffset] = useState(0);
  const [eof, setEof] = useState(false);
  const [loading, setLoading] = useState(false);
  const [following, setFollowing] = useState(initiallyFollow);
  const [query, setQuery] = useState("");
  const [retryVersion, setRetryVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [contentWindowed, setContentWindowed] = useState(false);
  const contentRef = useRef("");
  const nextOffsetRef = useRef(0);
  const pollingRef = useRef(false);

  const replaceVisibleContent = useCallback((value: string) => {
    const windowed = value.length > MAXIMUM_VISIBLE_ARTIFACT_CHARACTERS;
    const visible = windowed ? value.slice(-MAXIMUM_VISIBLE_ARTIFACT_CHARACTERS) : value;
    contentRef.current = visible;
    setContent(visible);
    setContentWindowed(windowed);
  }, []);

  const appendVisibleContent = useCallback((value: string) => {
    if (value.length === 0) return;
    const combined = contentRef.current + value;
    const windowed = combined.length > MAXIMUM_VISIBLE_ARTIFACT_CHARACTERS;
    const visible = windowed ? combined.slice(-MAXIMUM_VISIBLE_ARTIFACT_CHARACTERS) : combined;
    contentRef.current = visible;
    setContent(visible);
    if (windowed) setContentWindowed(true);
  }, []);

  useEffect(() => {
    nextOffsetRef.current = nextOffset;
  }, [nextOffset]);

  useEffect(() => {
    if (selected && eligibleArtifacts.some((artifact) => artifact.id === selected)) return;
    setSelected(preferred?.id || "");
  }, [eligibleArtifacts, preferred?.id, selected]);

  useEffect(() => {
    if (!selected) return;
    // This generation is intentionally read only to make the Retry action
    // restart the initial chunk request without changing the artifact ID.
    void retryVersion;
    contentRef.current = "";
    setContent("");
    setContentWindowed(false);
    setNextOffset(0);
    setEof(false);
    setError(null);
    nextOffsetRef.current = 0;
    let cancelled = false;
    setLoading(true);
    getArtifactChunk(campaignId, experimentId, selected)
      .then((chunk) => {
        if (cancelled) return;
        const updatedOffset = chunk.nextOffset ?? chunk.content.length;
        replaceVisibleContent(chunk.content);
        nextOffsetRef.current = updatedOffset;
        setNextOffset(updatedOffset);
        setEof(Boolean(chunk.eof));
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Could not read artifact.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [campaignId, experimentId, replaceVisibleContent, retryVersion, selected]);

  const descriptor = eligibleArtifacts.find((artifact) => artifact.id === selected);
  useEffect(() => {
    if (descriptor?.sizeBytes === undefined || descriptor.sizeBytes >= nextOffsetRef.current) {
      return;
    }
    nextOffsetRef.current = 0;
    contentRef.current = "";
    setContent("");
    setContentWindowed(false);
    setNextOffset(0);
    setEof(false);
    setRetryVersion((value) => value + 1);
  }, [descriptor?.sizeBytes]);

  useEffect(() => {
    if (!following || !selected) return;
    let cancelled = false;
    const poll = async () => {
      if (pollingRef.current) return;
      pollingRef.current = true;
      try {
        const chunk = await getArtifactChunk(
          campaignId,
          experimentId,
          selected,
          nextOffsetRef.current,
        );
        if (cancelled) return;
        appendVisibleContent(chunk.content);
        const updatedOffset = chunk.nextOffset ?? nextOffsetRef.current;
        nextOffsetRef.current = updatedOffset;
        setNextOffset(updatedOffset);
        setEof(Boolean(chunk.eof));
        setError(null);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Could not follow this artifact.");
        }
      } finally {
        pollingRef.current = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [appendVisibleContent, campaignId, experimentId, following, selected]);

  const loadMore = async () => {
    if (loading || eof) return;
    setLoading(true);
    try {
      const chunk = await getArtifactChunk(campaignId, experimentId, selected, nextOffset);
      appendVisibleContent(chunk.content);
      const updatedOffset = chunk.nextOffset ?? nextOffset + chunk.content.length;
      nextOffsetRef.current = updatedOffset;
      setNextOffset(updatedOffset);
      setEof(Boolean(chunk.eof));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not continue reading.");
    } finally {
      setLoading(false);
    }
  };

  const displayedContent = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (normalized.length === 0) return content;
    return content
      .split(/\r?\n/u)
      .filter((line) => line.toLowerCase().includes(normalized))
      .join("\n");
  }, [content, query]);
  const renderedDiffLines = useMemo(() => {
    const occurrences = new Map<string, number>();
    return displayedContent.split(/\r?\n/u).map((line) => {
      const occurrence = (occurrences.get(line) ?? 0) + 1;
      occurrences.set(line, occurrence);
      return { key: `${line}\u0000${occurrence}`, line };
    });
  }, [displayedContent]);

  if (!eligibleArtifacts.length) {
    return (
      <div className="inline-empty">
        <FileCode2 size={22} />
        <div>
          <strong>
            {preferredCategory
              ? `No ${preferredCategory} artifact available`
              : "No safe artifacts available"}
          </strong>
          <p>
            {preferredCategory
              ? `This experiment has not produced a sanitized ${preferredCategory} artifact.`
              : "Artifacts appear after their producing phase completes and passes sanitization."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="artifact-viewer">
      <div className="artifact-toolbar">
        <select
          aria-label="Artifact"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
        >
          {eligibleArtifacts.map((artifact) => (
            <option key={artifact.id} value={artifact.id}>
              {artifact.label}
            </option>
          ))}
        </select>
        <label className="artifact-search">
          <Search size={14} />
          <input
            aria-label="Filter loaded artifact lines"
            placeholder="Filter loaded lines"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          className={`artifact-follow ${following ? "active" : ""}`}
          type="button"
          aria-pressed={following}
          onClick={() => setFollowing((value) => !value)}
        >
          {following ? <Radio size={14} /> : <Pause size={14} />}
          {following ? "Following" : "Follow"}
        </button>
        <span>
          {descriptor?.sizeBytes !== undefined
            ? `${(descriptor.sizeBytes / 1024).toFixed(1)} KB`
            : "Protected local artifact"}
        </span>
        <a
          className="button-icon"
          aria-label="Download artifact"
          href={`/api/v1/campaigns/${encodeURIComponent(campaignId)}/experiments/${encodeURIComponent(experimentId)}/artifacts/${encodeURIComponent(selected)}?download=1`}
        >
          <Download size={16} />
        </a>
      </div>
      {contentWindowed ? (
        <div className="artifact-window-note" role="status">
          Showing the latest two million characters in this browser. Download the artifact for its
          complete contents.
        </div>
      ) : null}
      {error ? (
        <div className="artifact-error">
          <span>{error}</span>
          <button type="button" onClick={() => setRetryVersion((value) => value + 1)}>
            <RefreshCw size={15} />
            Retry
          </button>
        </div>
      ) : descriptor?.contentType === "text/x-diff" && displayedContent ? (
        <section className="code-surface diff-surface" aria-label="Unified code diff">
          {renderedDiffLines.map(({ key, line }, index) => (
            <div
              className={
                line.startsWith("+") && !line.startsWith("+++")
                  ? "diff-line diff-add"
                  : line.startsWith("-") && !line.startsWith("---")
                    ? "diff-line diff-remove"
                    : line.startsWith("@@")
                      ? "diff-line diff-hunk"
                      : line.startsWith("diff ") ||
                          line.startsWith("index ") ||
                          line.startsWith("---") ||
                          line.startsWith("+++")
                        ? "diff-line diff-meta"
                        : "diff-line"
              }
              key={key}
            >
              <i>{index + 1}</i>
              <code>{line || " "}</code>
            </div>
          ))}
        </section>
      ) : (
        <pre className="code-surface">
          {loading && !content ? (
            <span className="code-loading">
              <LoaderCircle className="spin" size={17} />
              Loading sanitized artifact…
            </span>
          ) : (
            displayedContent ||
            (query ? "No loaded lines match this filter." : "This artifact is empty.")
          )}
        </pre>
      )}
      {!eof && content ? (
        <button
          className="load-more"
          type="button"
          onClick={() => void loadMore()}
          disabled={loading}
        >
          {loading ? "Loading…" : "Load next 256 KiB"}
        </button>
      ) : null}
    </div>
  );
}
