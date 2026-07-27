"use client";

import { LoaderCircle, Pause, Radio, RefreshCw, Search, Terminal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getTaskLogChunk } from "../lib/client/api";
import type { TaskLogDescriptor } from "../lib/client/types";

const MAXIMUM_VISIBLE_CHARACTERS = 2 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function TaskLogViewer({
  campaignId,
  logs,
  selectedId,
  onSelect,
}: {
  campaignId: string;
  logs: TaskLogDescriptor[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const descriptor = logs.find((log) => log.id === selectedId);
  const [content, setContent] = useState("");
  const [nextOffset, setNextOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [following, setFollowing] = useState(true);
  const [query, setQuery] = useState("");
  const [retryVersion, setRetryVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [contentWindowed, setContentWindowed] = useState(false);
  const contentRef = useRef("");
  const nextOffsetRef = useRef(0);
  const initialRequestRef = useRef(false);
  const pollingRef = useRef(false);
  const surfaceRef = useRef<HTMLPreElement>(null);

  const replaceVisibleContent = useCallback((value: string, beganAfterStart: boolean) => {
    const windowed = beganAfterStart || value.length > MAXIMUM_VISIBLE_CHARACTERS;
    const visible =
      value.length > MAXIMUM_VISIBLE_CHARACTERS ? value.slice(-MAXIMUM_VISIBLE_CHARACTERS) : value;
    contentRef.current = visible;
    setContent(visible);
    setContentWindowed(windowed);
  }, []);

  const appendVisibleContent = useCallback((value: string) => {
    if (value.length === 0) return;
    const combined = contentRef.current + value;
    const windowed = combined.length > MAXIMUM_VISIBLE_CHARACTERS;
    const visible = windowed ? combined.slice(-MAXIMUM_VISIBLE_CHARACTERS) : combined;
    contentRef.current = visible;
    setContent(visible);
    if (windowed) setContentWindowed(true);
  }, []);

  useEffect(() => {
    nextOffsetRef.current = nextOffset;
  }, [nextOffset]);

  useEffect(() => {
    if (!selectedId) return;
    void retryVersion;
    let cancelled = false;
    contentRef.current = "";
    nextOffsetRef.current = 0;
    setContent("");
    setNextOffset(0);
    setContentWindowed(false);
    setError(null);
    setLoading(true);
    initialRequestRef.current = true;
    getTaskLogChunk(campaignId, selectedId, { tail: true })
      .then((chunk) => {
        if (cancelled) return;
        replaceVisibleContent(chunk.content, chunk.offset > 0);
        nextOffsetRef.current = chunk.nextOffset;
        setNextOffset(chunk.nextOffset);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Could not read this task log.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          initialRequestRef.current = false;
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [campaignId, replaceVisibleContent, retryVersion, selectedId]);

  useEffect(() => {
    if (descriptor?.sizeBytes === undefined || descriptor.sizeBytes >= nextOffsetRef.current) {
      return;
    }
    setRetryVersion((value) => value + 1);
  }, [descriptor?.sizeBytes]);

  useEffect(() => {
    if (!following || !selectedId) return;
    let cancelled = false;
    const poll = async () => {
      if (initialRequestRef.current || pollingRef.current) return;
      pollingRef.current = true;
      try {
        const chunk = await getTaskLogChunk(campaignId, selectedId, {
          offset: nextOffsetRef.current,
        });
        if (cancelled) return;
        appendVisibleContent(chunk.content);
        nextOffsetRef.current = chunk.nextOffset;
        setNextOffset(chunk.nextOffset);
        setError(null);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Could not follow this task log.");
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
  }, [appendVisibleContent, campaignId, following, selectedId]);

  const displayedContent = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (normalized.length === 0) return content;
    return content
      .split(/\r?\n/u)
      .filter((line) => line.toLowerCase().includes(normalized))
      .join("\n");
  }, [content, query]);

  useEffect(() => {
    if (!following) return;
    void displayedContent;
    const surface = surfaceRef.current;
    if (surface !== null) surface.scrollTop = surface.scrollHeight;
  }, [displayedContent, following]);

  if (!logs.length || !descriptor) {
    return (
      <div className="inline-empty">
        <Terminal size={22} />
        <div>
          <strong>No task stream available</strong>
          <p>The selected Harbor trial has not written an allowlisted log yet.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="task-log-viewer">
      <div className="artifact-toolbar">
        <select
          aria-label="Task log stream"
          value={selectedId}
          onChange={(event) => onSelect(event.target.value)}
        >
          {logs.map((log) => (
            <option key={log.id} value={log.id}>
              {log.label}
            </option>
          ))}
        </select>
        <label className="artifact-search">
          <Search size={14} />
          <input
            aria-label="Filter loaded task log lines"
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
        <span>{formatBytes(descriptor.sizeBytes)}</span>
      </div>
      {contentWindowed ? (
        <div className="artifact-window-note" role="status">
          Showing the latest two million characters. The complete stream remains on local disk.
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
      ) : null}
      <pre className="code-surface task-log-surface" ref={surfaceRef}>
        {loading && !content ? (
          <span className="code-loading">
            <LoaderCircle className="spin" size={17} />
            Loading latest task output…
          </span>
        ) : (
          displayedContent ||
          (query ? "No loaded lines match this filter." : "Waiting for task output…")
        )}
      </pre>
    </div>
  );
}
