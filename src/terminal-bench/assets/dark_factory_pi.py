"""Pinned Harbor adapter for cloud-built Dark Factory Pi runtimes.

This file contains no benchmark task data. Harbor imports it inside the trusted
cloud evaluator. Candidate and champion runtime archives are content-addressed,
verified, safely unpacked, and copied into each isolated task environment.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import tarfile
import tempfile
from pathlib import Path, PurePosixPath
from typing import override

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Trajectory


_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_RELATIVE_PATH = re.compile(r"^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$")
_TOOL = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
_FOUNDRY_RESOURCE = re.compile(
    r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$"
)
_THINKING = {"off", "minimal", "low", "medium", "high", "xhigh", "max"}
_MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
_MAX_EXTRACTED_BYTES = 4 * 1024 * 1024 * 1024
_MAX_ARCHIVE_ENTRIES = 100_000
_MAX_JSONL_BYTES = 256 * 1024 * 1024
_MAX_JSONL_RECORDS = 2_000_000
_ALLOWED_PI_EVENT_TYPES = {
    "session",
    "agent_start",
    "agent_end",
    "agent_settled",
    "turn_start",
    "turn_end",
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "compaction_start",
    "compaction_end",
    "auto_retry_start",
    "auto_retry_end",
    "summarization_retry_scheduled",
    "summarization_retry_attempt_start",
    "summarization_retry_finished",
    "bash_execution_update",
}
_PROVIDER_CREDENTIALS = {
    "anthropic": (
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_OAUTH_TOKEN",
        "ANTHROPIC_API_KEY",
    ),
    "microsoft-foundry": ("ANTHROPIC_FOUNDRY_API_KEY",),
    "openai": ("OPENAI_API_KEY",),
    "azure-openai-responses": (
        "AZURE_OPENAI_API_KEY",
        "AZURE_OPENAI_BASE_URL",
        "AZURE_OPENAI_RESOURCE_NAME",
        "AZURE_OPENAI_API_VERSION",
        "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
    ),
    "github-copilot": ("COPILOT_GITHUB_TOKEN",),
    "google": ("GEMINI_API_KEY",),
    "google-vertex": (
        "GOOGLE_CLOUD_API_KEY",
        "GOOGLE_CLOUD_PROJECT",
        "GCLOUD_PROJECT",
        "GOOGLE_CLOUD_LOCATION",
    ),
    "groq": ("GROQ_API_KEY",),
    "mistral": ("MISTRAL_API_KEY",),
    "openrouter": ("OPENROUTER_API_KEY",),
    "xai": ("XAI_API_KEY",),
    "deepseek": ("DEEPSEEK_API_KEY",),
    "cerebras": ("CEREBRAS_API_KEY",),
    "nvidia": ("NVIDIA_API_KEY",),
    "huggingface": ("HF_TOKEN",),
    "fireworks": ("FIREWORKS_API_KEY",),
    "together": ("TOGETHER_API_KEY",),
    "vercel-ai-gateway": ("AI_GATEWAY_API_KEY",),
    "zai": ("ZAI_API_KEY",),
    "zai-coding-cn": ("ZAI_CODING_CN_API_KEY",),
    "minimax": ("MINIMAX_API_KEY",),
    "minimax-cn": ("MINIMAX_CN_API_KEY",),
    "moonshotai": ("MOONSHOT_API_KEY",),
    "moonshotai-cn": ("MOONSHOT_API_KEY",),
    "kimi-coding": ("KIMI_API_KEY",),
    "opencode": ("OPENCODE_API_KEY",),
    "opencode-go": ("OPENCODE_API_KEY",),
}
_PROVIDER_AUTHENTICATION = {
    "anthropic": (
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_OAUTH_TOKEN",
        "ANTHROPIC_API_KEY",
    ),
    "microsoft-foundry": ("ANTHROPIC_FOUNDRY_API_KEY",),
    "openai": ("OPENAI_API_KEY",),
    "azure-openai-responses": ("AZURE_OPENAI_API_KEY",),
    "github-copilot": ("COPILOT_GITHUB_TOKEN",),
    "google": ("GEMINI_API_KEY",),
    "google-vertex": ("GOOGLE_CLOUD_API_KEY",),
    "groq": ("GROQ_API_KEY",),
    "mistral": ("MISTRAL_API_KEY",),
    "openrouter": ("OPENROUTER_API_KEY",),
    "xai": ("XAI_API_KEY",),
    "deepseek": ("DEEPSEEK_API_KEY",),
    "cerebras": ("CEREBRAS_API_KEY",),
    "nvidia": ("NVIDIA_API_KEY",),
    "huggingface": ("HF_TOKEN",),
    "fireworks": ("FIREWORKS_API_KEY",),
    "together": ("TOGETHER_API_KEY",),
    "vercel-ai-gateway": ("AI_GATEWAY_API_KEY",),
    "zai": ("ZAI_API_KEY",),
    "zai-coding-cn": ("ZAI_CODING_CN_API_KEY",),
    "minimax": ("MINIMAX_API_KEY",),
    "minimax-cn": ("MINIMAX_CN_API_KEY",),
    "moonshotai": ("MOONSHOT_API_KEY",),
    "moonshotai-cn": ("MOONSHOT_API_KEY",),
    "kimi-coding": ("KIMI_API_KEY",),
    "opencode": ("OPENCODE_API_KEY",),
    "opencode-go": ("OPENCODE_API_KEY",),
}


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _microsoft_foundry_models_json(
    resource_name: str, deployment_name: str, model_family: str
) -> str:
    """Return Pi's credential-blind, endpoint-derived Foundry model config."""
    if (
        not _FOUNDRY_RESOURCE.fullmatch(resource_name)
        or not re.fullmatch(
            r"[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}",
            deployment_name,
        )
        or model_family != "claude-opus-4-8"
    ):
        raise RuntimeError("Microsoft Foundry deployment identity is invalid")
    return json.dumps(
        {
            "providers": {
                "microsoft-foundry": {
                    "name": "Microsoft Foundry",
                    "baseUrl": (
                        f"https://{resource_name}.services.ai.azure.com/anthropic"
                    ),
                    "api": "anthropic-messages",
                    "apiKey": "$ANTHROPIC_FOUNDRY_API_KEY",
                    "models": [
                        {
                            "id": deployment_name,
                            "name": "Claude Opus 4.8",
                            "reasoning": True,
                            "input": ["text", "image"],
                            "contextWindow": 1_000_000,
                            "maxTokens": 128_000,
                            "cost": {
                                "input": 5,
                                "output": 25,
                                "cacheRead": 0.5,
                                "cacheWrite": 6.25,
                            },
                            "thinkingLevelMap": {
                                "low": "low",
                                "medium": "medium",
                                "high": "high",
                                "xhigh": "xhigh",
                                "max": "max",
                            },
                            "compat": {
                                "forceAdaptiveThinking": True,
                            },
                        }
                    ],
                }
            }
        },
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    )


def _safe_member(member: tarfile.TarInfo) -> bool:
    path = PurePosixPath(member.name)
    return (
        member.name != ""
        and not path.is_absolute()
        and ".." not in path.parts
        and not member.issym()
        and not member.islnk()
        and not member.isdev()
        and (member.isdir() or member.isfile())
    )


def _extract_verified_runtime(archive: Path, destination: Path) -> None:
    extracted_bytes = 0
    entry_count = 0
    normalized_paths: set[str] = set()
    file_paths: set[str] = set()
    with tarfile.open(archive, mode="r:*") as bundle:
        members = bundle.getmembers()
        for member in members:
            normalized = str(PurePosixPath(member.name))
            parents = tuple(
                str(parent)
                for parent in PurePosixPath(normalized).parents
                if str(parent) != "."
            )
            entry_count += 1
            extracted_bytes += max(0, member.size)
            if (
                entry_count > _MAX_ARCHIVE_ENTRIES
                or extracted_bytes > _MAX_EXTRACTED_BYTES
                or not _safe_member(member)
                or normalized == "."
                or not _RELATIVE_PATH.fullmatch(normalized)
                or normalized in normalized_paths
                or any(parent in file_paths for parent in parents)
                or (
                    member.isfile()
                    and any(
                        existing.startswith(f"{normalized}/")
                        for existing in normalized_paths
                    )
                )
            ):
                raise RuntimeError("Pi runtime archive violates extraction policy")
            normalized_paths.add(normalized)
            if member.isfile():
                file_paths.add(normalized)
        bundle.extractall(destination, members=members, filter="data")


def _timestamp(value: object) -> str:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or value < 0
        or value > 253402300799999
    ):
        raise RuntimeError("Pi trajectory contains an invalid timestamp")
    from datetime import datetime, timezone

    return (
        datetime.fromtimestamp(value / 1000, tz=timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _content_text(value: object, label: str) -> str:
    if isinstance(value, str):
        return value
    if not isinstance(value, list):
        raise RuntimeError(f"Pi trajectory {label} is not textual")
    output: list[str] = []
    for part in value:
        if (
            not isinstance(part, dict)
            or part.get("type") != "text"
            or not isinstance(part.get("text"), str)
        ):
            raise RuntimeError(
                f"Pi trajectory {label} contains unsupported multimodal content"
            )
        output.append(part["text"])
    return "\n".join(output)


def _nonnegative_int(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise RuntimeError(f"Pi trajectory {label} is invalid")
    return value


def _nonnegative_number(value: object, label: str) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or value < 0
    ):
        raise RuntimeError(f"Pi trajectory {label} is invalid")
    return float(value)


def _convert_pi_jsonl_to_atif(
    input_path: Path,
    output_path: Path,
    agent_version: str,
    model_name: str,
    reasoning_effort: str,
) -> Trajectory:
    if not model_name or not agent_version:
        raise RuntimeError("Pi trajectory model or runtime identity is missing")
    metadata = input_path.stat()
    if (
        not input_path.is_file()
        or metadata.st_size <= 0
        or metadata.st_size > _MAX_JSONL_BYTES
        or output_path.exists()
    ):
        raise RuntimeError("Pi trajectory source is missing or outside policy")

    steps: list[dict[str, object]] = []
    tool_steps: dict[str, int] = {}
    total_prompt = 0
    total_completion = 0
    total_cached = 0
    total_cost = 0.0
    saw_session_header = False
    saw_agent_end = False
    saw_agent_settled = False
    pending_failed_assistant_messages = 0
    pending_compaction_reason: str | None = None
    pending_auto_retry_attempt: int | None = None
    pending_summarization_retry = False
    summarization_retry_waiting_for_attempt = False
    compaction_count = 0
    retry_count = 0
    bash_update_count = 0
    record_count = 0

    with input_path.open("r", encoding="utf-8") as stream:
        for raw_line in stream:
            record_count += 1
            if (
                record_count > _MAX_JSONL_RECORDS
                or len(raw_line.encode("utf-8")) > 16 * 1024 * 1024
            ):
                raise RuntimeError("Pi trajectory record count or size exceeds policy")
            try:
                event = json.loads(raw_line)
            except json.JSONDecodeError as error:
                raise RuntimeError("Pi trajectory contains non-JSON output") from error
            if not isinstance(event, dict):
                raise RuntimeError("Pi trajectory event must be an object")
            event_type = event.get("type")
            if event_type not in _ALLOWED_PI_EVENT_TYPES:
                raise RuntimeError("Pi trajectory contains an unsupported event type")
            if event_type == "session":
                if (
                    record_count != 1
                    or saw_session_header
                    or not set(event).issubset(
                        {
                            "type",
                            "version",
                            "id",
                            "timestamp",
                            "cwd",
                            "parentSession",
                        }
                    )
                    or not {"type", "version", "id", "timestamp", "cwd"}.issubset(
                        event
                    )
                    or event.get("version") != 3
                    or not isinstance(event.get("id"), str)
                    or not isinstance(event.get("timestamp"), str)
                    or not isinstance(event.get("cwd"), str)
                    or not Path(event["cwd"]).is_absolute()
                    or (
                        "parentSession" in event
                        and not isinstance(event["parentSession"], str)
                    )
                ):
                    raise RuntimeError("Pi session header is malformed")
                saw_session_header = True
                continue
            if event_type == "agent_end":
                if (
                    set(event) != {"type", "messages", "willRetry"}
                    or not isinstance(event.get("messages"), list)
                    or not isinstance(event.get("willRetry"), bool)
                ):
                    raise RuntimeError("Pi agent-end event is malformed")
                if event["willRetry"]:
                    if pending_failed_assistant_messages <= 0:
                        raise RuntimeError(
                            "Pi retry is detached from a failed assistant turn"
                        )
                    pending_failed_assistant_messages -= 1
                else:
                    if saw_agent_end:
                        raise RuntimeError("Pi trajectory has multiple terminal ends")
                    saw_agent_end = True
                continue
            if event_type in {"agent_start", "turn_start"}:
                if set(event) != {"type"}:
                    raise RuntimeError("Pi lifecycle event is malformed")
                continue
            if event_type == "turn_end":
                if (
                    set(event) != {"type", "message", "toolResults"}
                    or not isinstance(event.get("message"), dict)
                    or not isinstance(event.get("toolResults"), list)
                ):
                    raise RuntimeError("Pi turn-end event is malformed")
                continue
            if event_type == "message_start":
                if (
                    set(event) != {"type", "message"}
                    or not isinstance(event.get("message"), dict)
                ):
                    raise RuntimeError("Pi message-start event is malformed")
                continue
            if event_type == "message_update":
                if (
                    set(event)
                    != {"type", "message", "assistantMessageEvent"}
                    or not isinstance(event.get("message"), dict)
                    or not isinstance(event.get("assistantMessageEvent"), dict)
                ):
                    raise RuntimeError("Pi message-update event is malformed")
                continue
            if event_type == "tool_execution_start":
                if (
                    set(event) != {"type", "toolCallId", "toolName", "args"}
                    or not isinstance(event.get("toolCallId"), str)
                    or not isinstance(event.get("toolName"), str)
                ):
                    raise RuntimeError("Pi tool-start event is malformed")
                continue
            if event_type == "tool_execution_update":
                if (
                    set(event)
                    != {
                        "type",
                        "toolCallId",
                        "toolName",
                        "args",
                        "partialResult",
                    }
                    or not isinstance(event.get("toolCallId"), str)
                    or not isinstance(event.get("toolName"), str)
                ):
                    raise RuntimeError("Pi tool-update event is malformed")
                continue
            if event_type == "tool_execution_end":
                if (
                    set(event)
                    != {
                        "type",
                        "toolCallId",
                        "toolName",
                        "result",
                        "isError",
                    }
                    or not isinstance(event.get("toolCallId"), str)
                    or not isinstance(event.get("toolName"), str)
                    or not isinstance(event.get("isError"), bool)
                ):
                    raise RuntimeError("Pi tool-end event is malformed")
                continue
            if event_type == "agent_settled":
                if set(event) != {"type"} or saw_agent_settled:
                    raise RuntimeError("Pi agent-settled event is malformed")
                saw_agent_settled = True
                continue
            if event_type == "compaction_start":
                if (
                    set(event) != {"type", "reason"}
                    or event.get("reason")
                    not in {"manual", "threshold", "overflow"}
                    or pending_compaction_reason is not None
                ):
                    raise RuntimeError("Pi compaction-start event is malformed")
                pending_compaction_reason = event["reason"]
                compaction_count += 1
                continue
            if event_type == "compaction_end":
                if (
                    not set(event).issubset(
                        {
                            "type",
                            "reason",
                            "result",
                            "aborted",
                            "willRetry",
                            "errorMessage",
                        }
                    )
                    or not {"type", "reason", "aborted", "willRetry"}.issubset(
                        event
                    )
                    or event.get("reason") != pending_compaction_reason
                    or not isinstance(event.get("aborted"), bool)
                    or not isinstance(event.get("willRetry"), bool)
                    or (
                        "errorMessage" in event
                        and not isinstance(event["errorMessage"], str)
                    )
                ):
                    raise RuntimeError("Pi compaction-end event is malformed")
                pending_compaction_reason = None
                continue
            if event_type == "auto_retry_start":
                if (
                    set(event)
                    != {
                        "type",
                        "attempt",
                        "maxAttempts",
                        "delayMs",
                        "errorMessage",
                    }
                    or isinstance(event.get("attempt"), bool)
                    or not isinstance(event.get("attempt"), int)
                    or event["attempt"] <= 0
                    or isinstance(event.get("maxAttempts"), bool)
                    or not isinstance(event.get("maxAttempts"), int)
                    or event["maxAttempts"] < event["attempt"]
                    or isinstance(event.get("delayMs"), bool)
                    or not isinstance(event.get("delayMs"), (int, float))
                    or event["delayMs"] < 0
                    or not isinstance(event.get("errorMessage"), str)
                    or pending_auto_retry_attempt is not None
                ):
                    raise RuntimeError("Pi auto-retry-start event is malformed")
                pending_auto_retry_attempt = event["attempt"]
                retry_count += 1
                continue
            if event_type == "auto_retry_end":
                if (
                    not set(event).issubset(
                        {"type", "success", "attempt", "finalError"}
                    )
                    or not {"type", "success", "attempt"}.issubset(event)
                    or not isinstance(event.get("success"), bool)
                    or event.get("attempt") != pending_auto_retry_attempt
                    or (
                        "finalError" in event
                        and not isinstance(event["finalError"], str)
                    )
                ):
                    raise RuntimeError("Pi auto-retry-end event is malformed")
                pending_auto_retry_attempt = None
                continue
            if event_type == "summarization_retry_scheduled":
                if (
                    set(event)
                    != {
                        "type",
                        "attempt",
                        "maxAttempts",
                        "delayMs",
                        "errorMessage",
                    }
                    or isinstance(event.get("attempt"), bool)
                    or not isinstance(event.get("attempt"), int)
                    or event["attempt"] <= 0
                    or isinstance(event.get("maxAttempts"), bool)
                    or not isinstance(event.get("maxAttempts"), int)
                    or event["maxAttempts"] < event["attempt"]
                    or isinstance(event.get("delayMs"), bool)
                    or not isinstance(event.get("delayMs"), (int, float))
                    or event["delayMs"] < 0
                    or not isinstance(event.get("errorMessage"), str)
                    or summarization_retry_waiting_for_attempt
                ):
                    raise RuntimeError(
                        "Pi summarization-retry event is malformed"
                    )
                pending_summarization_retry = True
                summarization_retry_waiting_for_attempt = True
                retry_count += 1
                continue
            if event_type == "summarization_retry_attempt_start":
                if (
                    not set(event).issubset({"type", "source", "reason"})
                    or not {"type", "source"}.issubset(event)
                    or event.get("source") not in {"branchSummary", "compaction"}
                    or (
                        event.get("source") == "compaction"
                        and event.get("reason")
                        not in {"manual", "threshold", "overflow"}
                    )
                    or (
                        event.get("source") == "branchSummary"
                        and "reason" in event
                    )
                    or not pending_summarization_retry
                    or not summarization_retry_waiting_for_attempt
                ):
                    raise RuntimeError(
                        "Pi summarization-retry-start event is malformed"
                    )
                summarization_retry_waiting_for_attempt = False
                continue
            if event_type == "summarization_retry_finished":
                if set(event) != {"type"} or not pending_summarization_retry:
                    raise RuntimeError(
                        "Pi summarization-retry-finished event is malformed"
                    )
                pending_summarization_retry = False
                summarization_retry_waiting_for_attempt = False
                continue
            if event_type == "bash_execution_update":
                if (
                    not set(event).issubset({"type", "id", "delta"})
                    or not {"type", "delta"}.issubset(event)
                    or ("id" in event and not isinstance(event["id"], str))
                    or not isinstance(event.get("delta"), str)
                ):
                    raise RuntimeError("Pi bash-update event is malformed")
                bash_update_count += 1
                continue
            if event_type != "message_end":
                continue
            if set(event) != {"type", "message"}:
                raise RuntimeError("Pi message-end event is malformed")
            message = event.get("message")
            if not isinstance(message, dict):
                raise RuntimeError("Pi message event is malformed")
            role = message.get("role")
            if role == "user":
                steps.append(
                    {
                        "step_id": len(steps) + 1,
                        "timestamp": _timestamp(message.get("timestamp")),
                        "source": "user",
                        "message": _content_text(
                            message.get("content"), "user message"
                        ),
                    }
                )
                continue
            if role == "assistant":
                if message.get("stopReason") in {"error", "aborted"}:
                    pending_failed_assistant_messages += 1
                    continue
                content = message.get("content")
                usage = message.get("usage")
                if not isinstance(content, list) or not isinstance(usage, dict):
                    raise RuntimeError("Pi assistant message or usage is malformed")
                text_parts: list[str] = []
                reasoning_parts: list[str] = []
                tool_calls: list[dict[str, object]] = []
                for part in content:
                    if not isinstance(part, dict):
                        raise RuntimeError("Pi assistant content is malformed")
                    part_type = part.get("type")
                    if part_type == "text" and isinstance(part.get("text"), str):
                        text_parts.append(part["text"])
                    elif (
                        part_type == "thinking"
                        and isinstance(part.get("thinking"), str)
                    ):
                        reasoning_parts.append(part["thinking"])
                    elif (
                        part_type == "toolCall"
                        and isinstance(part.get("id"), str)
                        and isinstance(part.get("name"), str)
                        and isinstance(part.get("arguments"), dict)
                    ):
                        tool_call_id = part["id"]
                        if tool_call_id in tool_steps:
                            raise RuntimeError(
                                "Pi trajectory reuses a tool-call identifier"
                            )
                        tool_calls.append(
                            {
                                "tool_call_id": tool_call_id,
                                "function_name": part["name"],
                                "arguments": part["arguments"],
                            }
                        )
                    else:
                        raise RuntimeError(
                            "Pi assistant content contains an unsupported part"
                        )

                input_tokens = _nonnegative_int(usage.get("input"), "input usage")
                output_tokens = _nonnegative_int(
                    usage.get("output"), "output usage"
                )
                cached_tokens = _nonnegative_int(
                    usage.get("cacheRead"), "cache-read usage"
                )
                cost = usage.get("cost")
                if not isinstance(cost, dict):
                    raise RuntimeError("Pi assistant cost is malformed")
                cost_usd = _nonnegative_number(cost.get("total"), "total cost")
                metrics = {
                    "prompt_tokens": input_tokens + cached_tokens,
                    "completion_tokens": output_tokens,
                    "cached_tokens": cached_tokens,
                    "cost_usd": cost_usd,
                }
                step: dict[str, object] = {
                    "step_id": len(steps) + 1,
                    "timestamp": _timestamp(message.get("timestamp")),
                    "source": "agent",
                    "model_name": message.get("model"),
                    "reasoning_effort": reasoning_effort,
                    "message": "\n".join(text_parts),
                    "metrics": metrics,
                    "llm_call_count": 1,
                }
                if not isinstance(step["model_name"], str) or not step["model_name"]:
                    raise RuntimeError("Pi assistant model identity is missing")
                if reasoning_parts:
                    step["reasoning_content"] = "\n".join(reasoning_parts)
                if tool_calls:
                    step["tool_calls"] = tool_calls
                    step["observation"] = {"results": []}
                steps.append(step)
                step_index = len(steps) - 1
                for tool_call in tool_calls:
                    tool_steps[str(tool_call["tool_call_id"])] = step_index
                total_prompt += input_tokens + cached_tokens
                total_completion += output_tokens
                total_cached += cached_tokens
                total_cost += cost_usd
                continue
            if role == "toolResult":
                tool_call_id = message.get("toolCallId")
                if not isinstance(tool_call_id, str) or tool_call_id not in tool_steps:
                    raise RuntimeError(
                        "Pi tool result is detached from its assistant action"
                    )
                step = steps[tool_steps.pop(tool_call_id)]
                observation = step.get("observation")
                if not isinstance(observation, dict):
                    raise RuntimeError("Pi tool observation is malformed")
                results = observation.get("results")
                if not isinstance(results, list):
                    raise RuntimeError("Pi tool observation results are malformed")
                results.append(
                    {
                        "source_call_id": tool_call_id,
                        "content": _content_text(
                            message.get("content"), "tool result"
                        ),
                        "extra": {
                            "is_error": message.get("isError") is True,
                        },
                    }
                )
                continue
            raise RuntimeError("Pi trajectory contains an unsupported message role")

    if (
        not saw_session_header
        or not saw_agent_end
        or not saw_agent_settled
        or pending_failed_assistant_messages
        or pending_compaction_reason is not None
        or pending_auto_retry_attempt is not None
        or pending_summarization_retry
        or summarization_retry_waiting_for_attempt
        or tool_steps
        or len(steps) < 2
        or steps[0].get("source") != "user"
        or steps[-1].get("source") != "agent"
    ):
        raise RuntimeError("Pi trajectory is incomplete")

    source_sha256 = _sha256_file(input_path)
    trajectory = Trajectory.model_validate(
        {
            "schema_version": "ATIF-v1.7",
            "session_id": f"pi-run-{source_sha256[:32]}",
            "trajectory_id": f"pi-trajectory-{source_sha256}",
            "agent": {
                "name": "dark-factory-pi",
                "version": agent_version,
                "model_name": model_name,
                "extra": {
                    "runtime_sha256": agent_version,
                },
            },
            "steps": steps,
            "final_metrics": {
                "total_prompt_tokens": total_prompt,
                "total_completion_tokens": total_completion,
                "total_cached_tokens": total_cached,
                "total_cost_usd": total_cost,
                "total_steps": len(steps),
            },
            "extra": {
                "dark_factory": {
                    "compaction_count": compaction_count,
                    "retry_count": retry_count,
                    "bash_update_count": bash_update_count,
                    "agent_settled": saw_agent_settled,
                }
            },
        }
    )
    with output_path.open("x", encoding="utf-8") as output:
        json.dump(
            trajectory.to_json_dict(),
            output,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        output.write("\n")
    return trajectory


class DarkFactoryPi(BaseInstalledAgent):
    """Runs one immutable private-Pi runtime with all project resources disabled."""

    SUPPORTS_RESUME = False
    SUPPORTS_ATIF = True
    _OUTPUT_FILENAME = "dark-factory-pi.jsonl"

    def __init__(
        self,
        *args,
        runtime_archive_path: str,
        runtime_sha256: str,
        pi_entrypoint: str,
        thinking: str,
        enabled_tools: list[str],
        credential_environment_names: list[str],
        foundry_resource_name: str | None = None,
        model_family: str | None = None,
        **kwargs,
    ):
        archive = Path(runtime_archive_path)
        if (
            not archive.is_absolute()
            or ".." in archive.parts
            or not _SHA256.fullmatch(runtime_sha256)
            or not _RELATIVE_PATH.fullmatch(pi_entrypoint)
            or thinking not in _THINKING
            or not enabled_tools
            or any(not _TOOL.fullmatch(tool) for tool in enabled_tools)
            or not credential_environment_names
            or any(
                not re.fullmatch(r"[A-Z_][A-Z0-9_]{0,127}", name)
                for name in credential_environment_names
            )
            or len(set(credential_environment_names))
            != len(credential_environment_names)
            or (
                foundry_resource_name is not None
                and not _FOUNDRY_RESOURCE.fullmatch(foundry_resource_name)
            )
            or (
                model_family is not None
                and not re.fullmatch(
                    r"[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}",
                    model_family,
                )
            )
        ):
            raise ValueError("Dark Factory Pi adapter configuration is malformed")
        self._runtime_archive_path = archive
        self._runtime_sha256 = runtime_sha256
        self._pi_entrypoint = pi_entrypoint
        self._thinking = thinking
        self._enabled_tools = sorted(set(enabled_tools))
        self._credential_environment_names = sorted(
            credential_environment_names
        )
        self._foundry_resource_name = foundry_resource_name
        self._model_family = model_family
        super().__init__(*args, **kwargs)

    @staticmethod
    @override
    def name() -> str:
        return "dark-factory-pi"

    @override
    def get_version_command(self) -> str | None:
        pi = shlex.quote(f"/opt/pi/{self._pi_entrypoint}")
        return f"{pi} --version"

    @override
    def parse_version(self, stdout: str) -> str:
        return stdout.strip().splitlines()[-1].strip()

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        archive = self._runtime_archive_path
        if (
            not archive.is_file()
            or archive.stat().st_size <= 0
            or archive.stat().st_size > _MAX_ARCHIVE_BYTES
            or _sha256_file(archive) != self._runtime_sha256
        ):
            raise RuntimeError("Pi runtime archive failed its content-addressed check")

        with tempfile.TemporaryDirectory(prefix="df-pi-runtime-") as temp:
            extracted = Path(temp) / "runtime"
            extracted.mkdir(mode=0o700)
            _extract_verified_runtime(archive, extracted)
            pi = extracted / self._pi_entrypoint
            if not pi.is_file():
                raise RuntimeError("Pi runtime archive is missing a sealed entrypoint")
            await environment.upload_dir(extracted, "/opt/pi")

        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be provider/model")
        provider, model = self.model_name.split("/", 1)
        if provider == "microsoft-foundry":
            if (
                self._foundry_resource_name is None
                or self._model_family != "claude-opus-4-8"
            ):
                raise RuntimeError(
                    "Microsoft Foundry resource was not bound"
                )
            models_json = _microsoft_foundry_models_json(
                self._foundry_resource_name,
                model,
                self._model_family,
            )
            foundry_setup = (
                "install -d -o root -g root -m 0755 "
                "/installed-agent/foundry-config; "
                f"printf '%s\\n' {shlex.quote(models_json)} > "
                "/installed-agent/foundry-config/models.json; "
                "chown root:root "
                "/installed-agent/foundry-config/models.json; "
                "chmod 0644 "
                "/installed-agent/foundry-config/models.json; "
            )
        else:
            if (
                self._foundry_resource_name is not None
                or self._model_family is not None
            ):
                raise RuntimeError(
                    "Foundry resource was attached to another provider"
                )
            foundry_setup = ""

        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                "install -d -m 0755 /installed-agent/empty-config; "
                f"{foundry_setup}"
                f"chmod 0755 {shlex.quote(f'/opt/pi/{self._pi_entrypoint}')}; "
                f"{shlex.quote(f'/opt/pi/{self._pi_entrypoint}')} --version"
            ),
        )

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be provider/model")
        provider, model = self.model_name.split("/", 1)
        if provider not in _PROVIDER_CREDENTIALS or not model:
            raise ValueError("Pi provider/model is not allowlisted")
        granted = set(self._credential_environment_names)
        if (
            not granted.issubset(_PROVIDER_CREDENTIALS[provider])
            or not granted.intersection(_PROVIDER_AUTHENTICATION[provider])
        ):
            raise ValueError(
                "Pi provider credential environment grant is invalid"
            )
        if (
            provider == "microsoft-foundry"
            and (
                self._foundry_resource_name is None
                or self._model_family != "claude-opus-4-8"
                or self._thinking != "high"
            )
        ):
            raise RuntimeError(
                "Microsoft Foundry evaluated model binding changed"
            )

        # Daytona secret placeholders are scoped to the sandbox where they were
        # issued. Harbor attaches the evaluated Foundry secret directly to each
        # task sandbox, so copying the evaluator sandbox's placeholder here would
        # replace it with a credential that cannot be resolved in the child.
        environment_values = (
            {}
            if provider == "microsoft-foundry"
            else {
                key: value
                for key in self._credential_environment_names
                if (value := os.environ.get(key))
            }
        )
        if provider != "microsoft-foundry" and not any(
            key in environment_values
            for key in _PROVIDER_AUTHENTICATION[provider]
        ):
            raise RuntimeError(
                "Pi provider authentication was not injected"
            )
        environment_values.update(
            {
                "NO_COLOR": "1",
                "PI_CODING_AGENT_DIR": (
                    "/installed-agent/foundry-config"
                    if provider == "microsoft-foundry"
                    else "/installed-agent/empty-config"
                ),
                "PI_OFFLINE": "1",
                "PI_SKIP_VERSION_CHECK": "1",
                "PI_TELEMETRY": "0",
            }
        )
        pi = shlex.quote(f"/opt/pi/{self._pi_entrypoint}")
        tools = shlex.quote(",".join(self._enabled_tools))
        output = shlex.quote(f"/logs/agent/{self._OUTPUT_FILENAME}")
        credential_check = (
            '[ -n "${ANTHROPIC_FOUNDRY_API_KEY:-}" ] || { '
            'echo "Pi provider authentication was not injected." >&2; '
            "exit 87; }; "
            if provider == "microsoft-foundry"
            else ""
        )
        command = (
            "set -euo pipefail; "
            f"{credential_check}"
            "for protected_path in /tests /solution; do "
            '[ ! -e "$protected_path" ] || { '
            'echo "Protected verifier material was visible during the agent phase." >&2; '
            "exit 86; }; "
            "done; "
            f"{pi} --print --mode json "
            f"--provider {shlex.quote(provider)} --model {shlex.quote(model)} "
            f"--thinking {shlex.quote(self._thinking)} --no-session --no-approve "
            "--offline --no-extensions --no-skills --no-prompt-templates "
            f"--no-themes --no-context-files --tools {tools} "
            f"{shlex.quote(instruction)} 2>&1 </dev/null | tee {output}"
        )
        await self.exec_as_agent(environment, command=command, env=environment_values)

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        output_file = self.logs_dir / self._OUTPUT_FILENAME
        if not output_file.is_file():
            raise RuntimeError("Pi did not produce its required JSON event log")
        trajectory = _convert_pi_jsonl_to_atif(
            output_file,
            self.logs_dir / "trajectory.json",
            self._runtime_sha256,
            self.model_name,
            self._thinking,
        )
        metrics = trajectory.final_metrics
        if metrics is None:
            raise RuntimeError("Pi ATIF trajectory is missing final metrics")
        context.n_input_tokens = metrics.total_prompt_tokens
        context.n_output_tokens = metrics.total_completion_tokens
        context.n_cache_tokens = metrics.total_cached_tokens
        context.cost_usd = metrics.total_cost_usd
