#!/usr/bin/env python3
"""Evaluator-private Terminal-Bench inventory discovery for the MVP.

This program is invoked only inside the protected evaluator Daytona sandbox.
It downloads the exact public registry revision, statically rejects
incompatible task definitions, and then starts bounded direct Daytona child
sandboxes to prove that the pinned Bun Linux x64 glibc executable runs in each
retained task environment. Task-bearing output is written only to the
evaluator's mounted private state; stdout and stderr intentionally contain no
task information.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.metadata
import json
import os
import platform
import re
import stat
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any

DATASET_NAME = "terminal-bench/terminal-bench-2-1"
DATASET_REFERENCE = f"{DATASET_NAME}@6"
EXPECTED_TASK_COUNT = 89
MAXIMUM_FILE_COUNT = 100_000
MAXIMUM_TOTAL_BYTES = 100 * 1024 * 1024 * 1024
MAXIMUM_PROBE_CANDIDATES = 24
MAXIMUM_RETAINED_CORE_TASKS = 10
MAXIMUM_RETAINED_EASY_TASKS = 2
PROBE_CONCURRENCY = 5
SHA256 = re.compile(r"^[a-f0-9]{64}$")
SAFE_TASK_NAME = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
)


class DiscoveryError(RuntimeError):
    pass


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest_json(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def assert_cloud_boundary() -> None:
    identities = (
        os.environ.get("DAYTONA_SANDBOX_ID"),
        os.environ.get("DAYTONA_WORKSPACE_ID"),
    )
    if (
        platform.system() != "Linux"
        or platform.machine() != "x86_64"
        or platform.libc_ver()[0].lower() != "glibc"
        or os.environ.get("CI") != "true"
        or os.environ.get("DF_CLOUD_EXECUTION") != "1"
        or os.environ.get("DF_MVP_ROLE") != "evaluator"
        or not any(value and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,255}", value) for value in identities)
        or not os.environ.get("DAYTONA_API_KEY")
        or os.environ.get("DAYTONA_API_URL", "").rstrip("/")
        != "https://app.daytona.io/api"
        or not re.search(r"(?:^|[-_.])eu(?:$|[-_.])", os.environ.get("DAYTONA_TARGET", ""), re.I)
    ):
        raise DiscoveryError("Evaluator-private cloud boundary is unavailable")


def inventory_tree(root: Path) -> str:
    root = root.resolve(strict=True)
    entries: list[dict[str, Any]] = []
    total_bytes = 0
    for directory, directory_names, file_names in os.walk(root, followlinks=False):
        directory_names.sort(key=os.fsencode)
        file_names.sort(key=os.fsencode)
        directory_path = Path(directory)
        for name in list(directory_names):
            path = directory_path / name
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
                raise DiscoveryError("Dataset contains an unsupported directory entry")
        for name in file_names:
            path = directory_path / name
            item_stat = path.lstat()
            if stat.S_ISLNK(item_stat.st_mode) or not stat.S_ISREG(item_stat.st_mode):
                raise DiscoveryError("Dataset contains an unsupported file entry")
            resolved = path.resolve(strict=True)
            try:
                relative = resolved.relative_to(root).as_posix()
            except ValueError as error:
                raise DiscoveryError("Dataset entry escaped the discovery root") from error
            total_bytes += item_stat.st_size
            if (
                len(entries) >= MAXIMUM_FILE_COUNT
                or total_bytes > MAXIMUM_TOTAL_BYTES
            ):
                raise DiscoveryError("Dataset inventory exceeds its bounded policy")
            entries.append(
                {
                    "path": relative,
                    "byteLength": item_stat.st_size,
                    "mode": stat.S_IMODE(item_stat.st_mode),
                    "sha256": hash_file(resolved),
                }
            )
    entries.sort(key=lambda item: os.fsencode(item["path"]))
    return digest_json(
        {
            "schemaVersion": 1,
            "domain": "dark-factory.mvp-private-dataset-content-manifest.v1",
            "entries": entries,
        }
    )


def package_task_membership(task_ids: Any) -> list[dict[str, str]]:
    tasks: list[dict[str, str]] = []
    seen_names: set[str] = set()
    seen_revisions: set[str] = set()
    for task_id in task_ids:
        name = f"{getattr(task_id, 'org', '')}/{getattr(task_id, 'name', '')}"
        ref = getattr(task_id, "ref", None)
        revision_digest = (
            ref.removeprefix("sha256:") if isinstance(ref, str) else ""
        )
        if (
            not SAFE_TASK_NAME.fullmatch(name)
            or ref != f"sha256:{revision_digest}"
            or not SHA256.fullmatch(revision_digest)
            or name in seen_names
            or revision_digest in seen_revisions
        ):
            raise DiscoveryError("Package dataset task membership is invalid")
        seen_names.add(name)
        seen_revisions.add(revision_digest)
        tasks.append({"name": name, "ref": ref})
    tasks.sort(key=lambda item: (item["name"], item["ref"]))
    return tasks


def package_file_membership(file_infos: Any) -> list[dict[str, str]]:
    files: list[dict[str, str]] = []
    seen_paths: set[str] = set()
    for file_info in file_infos:
        path = getattr(file_info, "path", None)
        content_hash = getattr(file_info, "content_hash", None)
        parsed = PurePosixPath(path) if isinstance(path, str) else None
        if (
            parsed is None
            or not path
            or parsed.is_absolute()
            or parsed.as_posix() != path
            or any(part in {"", ".", ".."} for part in parsed.parts)
            or "\\" in path
            or path in seen_paths
            or not isinstance(content_hash, str)
            or not SHA256.fullmatch(content_hash)
        ):
            raise DiscoveryError("Package dataset file membership is invalid")
        seen_paths.add(path)
        files.append({"path": path, "ref": f"sha256:{content_hash}"})
    files.sort(key=lambda item: (item["path"], item["ref"]))
    return files


def package_dataset_manifest(metadata: Any, dataset_hash: str) -> dict[str, Any]:
    if (
        metadata.name != DATASET_NAME
        or metadata.version != f"sha256:{dataset_hash}"
        or metadata.dataset_version_content_hash != dataset_hash
        or not SHA256.fullmatch(dataset_hash)
        or len(metadata.task_ids) != EXPECTED_TASK_COUNT
    ):
        raise DiscoveryError("Package dataset metadata is invalid")

    tasks = package_task_membership(metadata.task_ids)
    files = package_file_membership(metadata.files)
    return {
        "schemaVersion": 1,
        "domain": "dark-factory.mvp-private-package-dataset-manifest.v1",
        "datasetName": metadata.name,
        "datasetRef": f"sha256:{dataset_hash}",
        "tasks": tasks,
        "files": files,
    }


def immutable_package_dataset_reference(dataset_hash: str) -> str:
    if not SHA256.fullmatch(dataset_hash):
        raise DiscoveryError("Package dataset digest is invalid")
    return f"{DATASET_NAME}@sha256:{dataset_hash}"


async def download_immutable_package_dataset(
    client: Any, dataset_hash: str, output_dir: Path
) -> Any:
    return await client.download_dataset(
        immutable_package_dataset_reference(dataset_hash),
        overwrite=False,
        output_dir=output_dir,
        export=False,
    )


def assert_downloaded_task_paths(items: Any, root: Path) -> None:
    root = root.resolve(strict=True)
    seen_paths: set[Path] = set()
    for item in items:
        task_id = item.id
        revision_digest = task_id.ref.removeprefix("sha256:")
        expected = root / task_id.org / task_id.name / revision_digest
        candidate = Path(item.downloaded_path)
        try:
            resolved = candidate.resolve(strict=True)
        except (FileNotFoundError, RuntimeError) as error:
            raise DiscoveryError("Downloaded task path is unavailable") from error
        if (
            not candidate.is_absolute()
            or resolved != expected
            or not resolved.is_dir()
            or resolved in seen_paths
        ):
            raise DiscoveryError("Downloaded task path escaped its exact package location")
        seen_paths.add(resolved)


def resource_profile(environment: Any) -> dict[str, int] | None:
    cpu = environment.cpus
    memory_mib = environment.memory_mb
    storage_mib = environment.storage_mb
    gpus = environment.gpus or 0
    if (
        isinstance(cpu, bool)
        or not isinstance(cpu, int)
        or isinstance(memory_mib, bool)
        or not isinstance(memory_mib, int)
        or isinstance(storage_mib, bool)
        or not isinstance(storage_mib, int)
        or cpu < 1
        or memory_mib < 1
        or storage_mib < 1
        or memory_mib % 1024 != 0
        or storage_mib % 1024 != 0
        or gpus != 0
        or environment.tpu is not None
    ):
        return None
    return {
        "cpu": cpu,
        "memoryMiB": memory_mib,
        "storageMiB": storage_mib,
        "gpus": 0,
    }


def fits(profile: dict[str, int], ceiling: dict[str, int]) -> bool:
    return (
        profile["cpu"] <= ceiling["cpu"]
        and profile["memoryMiB"] <= ceiling["memoryMiB"]
        and profile["storageMiB"] <= ceiling["storageMiB"]
        and profile["gpus"] == 0
    )


def direct_context_is_valid(path: Path, docker_image: str | None) -> bool:
    return (
        path.is_dir()
        and not (path / "docker-compose.yaml").exists()
        and not (path / "docker-compose.yml").exists()
        and ((path / "Dockerfile").is_file() or bool(docker_image))
    )


def static_candidate(
    downloaded_path: Path,
    revision_digest: str,
    dataset_revision: str,
    provider_limits: dict[str, Any],
    provider_limits_digest: str,
    eligibility_policy_digest: str,
) -> dict[str, Any] | None:
    from harbor.models.task.config import TaskOS
    from harbor.models.task.task import Task
    from harbor.models.task.verifier_mode import (
        resolve_effective_verifier_env_config,
        resolve_step_verifier_mode,
        resolve_task_verifier_mode,
    )

    task = Task(downloaded_path)
    config = task.config
    if (
        config.task is None
        or not SAFE_TASK_NAME.fullmatch(config.task.name)
        or config.environment.os != TaskOS.LINUX
        or not direct_context_is_valid(
            task.paths.environment_dir, config.environment.docker_image
        )
    ):
        return None
    difficulty = config.metadata.get("difficulty")
    if difficulty not in {"hard", "medium", "easy"}:
        return None
    agent_resources = resource_profile(config.environment)
    if agent_resources is None or not fits(
        agent_resources, provider_limits["perSandbox"]
    ):
        return None

    verifier_resources: list[dict[str, int]] = []
    isolation_material: list[dict[str, Any]] = []
    steps = list(config.steps or [])
    if not steps:
        if resolve_task_verifier_mode(config).value != "separate":
            return None
        verifier_environment = resolve_effective_verifier_env_config(config, None)
        if verifier_environment is None or not direct_context_is_valid(
            task.paths.tests_dir, verifier_environment.docker_image
        ):
            return None
        profile = resource_profile(verifier_environment)
        if profile is None or not fits(profile, provider_limits["perSandbox"]):
            return None
        verifier_resources.append(profile)
        isolation_material.append(
            {
                "ordinal": 0,
                "mode": "separate",
                "config": verifier_environment.model_dump(mode="json"),
            }
        )
    else:
        for ordinal, step in enumerate(steps):
            if resolve_step_verifier_mode(config, step).value != "separate":
                return None
            verifier_environment = resolve_effective_verifier_env_config(config, step)
            if verifier_environment is None:
                return None
            context = task.paths.step_tests_dir(step.name)
            if not context.exists():
                context = task.paths.tests_dir
            if not direct_context_is_valid(context, verifier_environment.docker_image):
                return None
            profile = resource_profile(verifier_environment)
            if profile is None or not fits(profile, provider_limits["perSandbox"]):
                return None
            verifier_resources.append(profile)
            isolation_material.append(
                {
                    "ordinal": ordinal,
                    "mode": "separate",
                    "config": verifier_environment.model_dump(mode="json"),
                }
            )

    resource_material = {
        "revisionDigest": revision_digest,
        "agent": agent_resources,
        "verifiers": verifier_resources,
    }
    task_config_digest = hash_file(task.paths.config_path)
    prior = {"hard": 0.8, "medium": 0.6, "easy": 0.3}[difficulty]
    all_profiles = [agent_resources, *verifier_resources]
    normalized_cost = round(
        max(
            max(
                profile["cpu"] / provider_limits["perSandbox"]["cpu"],
                profile["memoryMiB"]
                / provider_limits["perSandbox"]["memoryMiB"],
                profile["storageMiB"]
                / provider_limits["perSandbox"]["storageMiB"],
            )
            for profile in all_profiles
        ),
        6,
    )
    name = config.task.name
    return {
        "_downloadedPath": str(downloaded_path),
        "_shortName": task.short_name,
        "harborTaskLocator": name,
        "revisionDigest": revision_digest,
        "difficulty": difficulty,
        "easyCanary": difficulty == "easy",
        "baselineFailureRate": prior,
        "baselineProvenance": {
            "kind": "dataset-declared-difficulty-prior",
            "sourceDigest": digest_json(
                {
                    "revisionDigest": revision_digest,
                    "taskConfigSha256": task_config_digest,
                    "declaredDifficulty": difficulty,
                }
            ),
            "policyDigest": eligibility_policy_digest,
            "datasetRevision": dataset_revision,
        },
        "graderIsolation": {
            "verifierEnvironmentMode": "separate",
            "allStepVerifierEnvironmentModesSeparate": True,
            "sourceDigest": digest_json(
                {
                    "revisionDigest": revision_digest,
                    "taskConfigSha256": task_config_digest,
                    "verifiers": isolation_material,
                }
            ),
        },
        "leaderboard": {"kind": "unknown", "reason": "not-published"},
        "initialFailureRate": prior,
        "uncertainty": 0.9,
        "normalizedCost": normalized_cost,
        "sensitiveLiterals": sorted(
            literal for literal in {name, task.short_name} if len(literal) >= 3
        ),
        "executionEligibility": {
            "environmentType": "daytona",
            "sandboxMode": "direct",
            "compose": False,
            "officialResources": {
                "agent": agent_resources,
                "verifiers": verifier_resources,
            },
            "resourceSourceDigest": digest_json(resource_material),
            "providerLimitsDigest": provider_limits_digest,
            "resourceFit": True,
        },
    }


async def probe_candidate(
    candidate: dict[str, Any],
    bun_path: Path,
    bun_sha256: str,
) -> tuple[dict[str, Any] | None, int, int]:
    from daytona.common.errors import DaytonaNotFoundError
    from harbor.environments.factory import EnvironmentFactory
    from harbor.models.environment_type import EnvironmentType
    from harbor.models.task.task import Task
    from harbor.models.trial.paths import TrialPaths

    task = Task(Path(candidate["_downloadedPath"]))
    session_digest = hashlib.sha256(
        candidate["revisionDigest"].encode("ascii")
    ).hexdigest()[:20]
    with tempfile.TemporaryDirectory(prefix="df-mvp-probe-") as temp:
        trial_paths = TrialPaths(Path(temp) / "trial")
        trial_paths.mkdir()
        environment = EnvironmentFactory.create_environment(
            type=EnvironmentType.DAYTONA,
            environment_dir=task.paths.environment_dir,
            environment_name=f"df-mvp-{session_digest}",
            session_id=f"df-mvp-bootstrap-{session_digest}",
            trial_paths=trial_paths,
            task_env_config=task.config.environment.model_copy(deep=True),
            network_policy=task.config.environment.resolve_baseline(),
            # Provider-side cleanup backstop if the evaluator process is
            # interrupted while an SDK request is in flight. Explicit,
            # identity-verified deletion below remains mandatory for success.
            auto_stop_interval_mins=30,
            auto_delete_interval_mins=0,
        )
        primary_error: Exception | None = None
        output = ""
        compatible = False
        sandbox: Any | None = None
        created = 0
        destroyed = 0
        try:
            await asyncio.wait_for(environment.start(force_build=False), timeout=1_200)
            sandbox = getattr(environment, "_sandbox", None)
            if sandbox is None:
                raise DiscoveryError("Harbor did not retain the child sandbox identity")
            created = 1
            await asyncio.wait_for(
                environment.upload_file(bun_path, "/tmp/df-mvp-bun"), timeout=120
            )
            result = await asyncio.wait_for(
                environment.exec(
                    "chmod 0755 /tmp/df-mvp-bun && /tmp/df-mvp-bun --version",
                    timeout_sec=60,
                ),
                timeout=90,
            )
            output = (result.stdout or "").strip()
            compatible = result.return_code == 0 and bool(
                re.fullmatch(r"1\.3\.14", output)
            )
        except Exception as error:
            primary_error = error
        finally:
            sandbox = sandbox or getattr(environment, "_sandbox", None)
            if sandbox is not None:
                created = 1
            try:
                await asyncio.shield(environment.stop(delete=True))
            except Exception as cleanup_error:
                raise DiscoveryError(
                    "A compatibility child sandbox could not be destroyed"
                ) from cleanup_error
            if sandbox is not None:
                # Harbor 0.20.0 deliberately swallows some provider deletion
                # failures. A second direct delete must either succeed or
                # prove that the exact sandbox identity is already gone.
                for attempt in range(3):
                    try:
                        await asyncio.shield(sandbox.delete())
                    except DaytonaNotFoundError:
                        destroyed = 1
                        break
                    except Exception as cleanup_error:
                        if attempt == 2:
                            raise DiscoveryError(
                                "A compatibility child sandbox deletion was not proven"
                            ) from cleanup_error
                        await asyncio.sleep(2**attempt)
                    else:
                        destroyed = 1
                        break
            if created != destroyed:
                raise DiscoveryError(
                    "Compatibility child sandbox accounting did not close"
                )
        if primary_error is not None or not compatible:
            return None, created, destroyed
        sanitized = {
            key: value for key, value in candidate.items() if not key.startswith("_")
        }
        sanitized["executionEligibility"]["runtimeCompatibility"] = {
            "architecture": "x86_64",
            "runtimeAbi": "linux-x64-glibc",
            "bunExecutableSha256": bun_sha256,
            "smokeEvidenceDigest": digest_json(
                {
                    "policy": "direct-daytona-bun-exec-v1",
                    "revisionDigest": candidate["revisionDigest"],
                    "bunExecutableSha256": bun_sha256,
                    "reportedVersion": output,
                    "exitCode": 0,
                    "destroyed": True,
                }
            ),
            "compatible": True,
        }
        return sanitized, created, destroyed


async def probe_candidates(
    candidates: list[dict[str, Any]],
    bun_path: Path,
    bun_sha256: str,
) -> tuple[list[dict[str, Any]], int, int]:
    semaphore = asyncio.Semaphore(PROBE_CONCURRENCY)

    async def bounded(
        candidate: dict[str, Any],
    ) -> tuple[dict[str, Any] | None, int, int]:
        async with semaphore:
            return await probe_candidate(candidate, bun_path, bun_sha256)

    retained: list[dict[str, Any]] = []
    created = 0
    destroyed = 0
    for start in range(0, len(candidates), PROBE_CONCURRENCY):
        batch = candidates[start : start + PROBE_CONCURRENCY]
        results = await asyncio.gather(*(bounded(candidate) for candidate in batch))
        for result, result_created, result_destroyed in results:
            created += result_created
            destroyed += result_destroyed
            if result is not None:
                retained.append(result)
        core_count = sum(not item["easyCanary"] for item in retained)
        easy_count = sum(item["easyCanary"] for item in retained)
        if (
            core_count >= MAXIMUM_RETAINED_CORE_TASKS
            and easy_count >= MAXIMUM_RETAINED_EASY_TASKS
        ):
            break
    core = sorted(
        (item for item in retained if not item["easyCanary"]),
        key=lambda item: item["revisionDigest"],
    )[:MAXIMUM_RETAINED_CORE_TASKS]
    easy = sorted(
        (item for item in retained if item["easyCanary"]),
        key=lambda item: item["revisionDigest"],
    )[:MAXIMUM_RETAINED_EASY_TASKS]
    selected = sorted([*core, *easy], key=lambda item: item["revisionDigest"])
    if len(core) < 4 or len(easy) < 1 or len(selected) < 5:
        raise DiscoveryError("Fewer than five compatible task revisions were proven")
    if created < len(selected) or destroyed != created:
        raise DiscoveryError("Compatibility sandbox accounting is incomplete")
    return selected, created, destroyed


async def discover(arguments: argparse.Namespace) -> dict[str, Any]:
    from harbor.models.task.id import PackageTaskId
    from harbor.registry.client.package import PackageDatasetClient

    assert_cloud_boundary()
    if importlib.metadata.version("harbor") != "0.20.0":
        raise DiscoveryError("Harbor package version differs from the immutable image")
    bun_path = Path(arguments.bun).resolve(strict=True)
    if not bun_path.is_file() or hash_file(bun_path) != arguments.bun_sha256:
        raise DiscoveryError("Bun executable differs from the caller pin")
    provider_limits = json.loads(arguments.provider_limits)
    if digest_json(provider_limits) != arguments.provider_limits_digest:
        raise DiscoveryError("Provider limits binding changed")

    client = PackageDatasetClient()
    metadata = await client.get_dataset_metadata(DATASET_REFERENCE)
    dataset_hash = (metadata.dataset_version_content_hash or "").removeprefix(
        "sha256:"
    )
    if (
        metadata.name != DATASET_NAME
        or metadata.version != f"sha256:{dataset_hash}"
        or not SHA256.fullmatch(dataset_hash)
        or len(metadata.task_ids) != EXPECTED_TASK_COUNT
        or any(not isinstance(task_id, PackageTaskId) for task_id in metadata.task_ids)
    ):
        raise DiscoveryError("Terminal-Bench registry revision is not the expected immutable set")
    registry_manifest = package_dataset_manifest(metadata, dataset_hash)
    dataset_manifest_sha256 = digest_json(registry_manifest)
    immutable_reference = immutable_package_dataset_reference(dataset_hash)
    digest_metadata = await client.get_dataset_metadata(immutable_reference)
    if (
        any(not isinstance(task_id, PackageTaskId) for task_id in digest_metadata.task_ids)
        or package_dataset_manifest(digest_metadata, dataset_hash) != registry_manifest
    ):
        raise DiscoveryError("Terminal-Bench registry revision is not digest-addressable")
    dataset_revision = f"terminal-bench-2.1-r6-{dataset_hash[:12]}"
    bootstrap_root = Path(arguments.output).parent
    bootstrap_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    # The evaluator's outer sandbox has a 10 GiB ephemeral disk. Keep the
    # bounded registry download on the already-mounted private volume instead.
    with tempfile.TemporaryDirectory(
        prefix=".dataset-download-", dir=bootstrap_root
    ) as temp:
        dataset_root = Path(temp) / "dataset"
        items = await download_immutable_package_dataset(
            client,
            dataset_hash,
            dataset_root,
        )
        if len(items) != EXPECTED_TASK_COUNT:
            raise DiscoveryError("Downloaded dataset cardinality changed")
        if any(not isinstance(item.id, PackageTaskId) for item in items):
            raise DiscoveryError("Downloaded dataset contains a non-package task reference")
        if package_task_membership(item.id for item in items) != registry_manifest["tasks"]:
            raise DiscoveryError("Downloaded dataset membership changed")
        assert_downloaded_task_paths(items, dataset_root)
        refreshed_metadata = await client.get_dataset_metadata(DATASET_REFERENCE)
        if package_dataset_manifest(refreshed_metadata, dataset_hash) != registry_manifest:
            raise DiscoveryError("Package dataset metadata changed during download")
        dataset_content_sha256 = inventory_tree(dataset_root)
        candidates: list[dict[str, Any]] = []
        seen_revisions: set[str] = set()
        seen_names: set[str] = set()
        for item in items:
            if not isinstance(item.id, PackageTaskId):
                raise DiscoveryError("Dataset contains a non-package task reference")
            revision_digest = (item.id.ref or "").removeprefix("sha256:")
            if (
                not SHA256.fullmatch(revision_digest)
                or revision_digest in seen_revisions
            ):
                raise DiscoveryError("Dataset contains a duplicate or mutable task revision")
            seen_revisions.add(revision_digest)
            candidate = static_candidate(
                item.downloaded_path,
                revision_digest,
                dataset_revision,
                provider_limits,
                arguments.provider_limits_digest,
                arguments.eligibility_policy_digest,
            )
            if candidate is None:
                continue
            if candidate["harborTaskLocator"] in seen_names:
                raise DiscoveryError("Dataset contains duplicate task locators")
            seen_names.add(candidate["harborTaskLocator"])
            candidates.append(candidate)

        easy_candidates = sorted(
            (item for item in candidates if item["easyCanary"]),
            key=lambda item: item["revisionDigest"],
        )
        core_candidates = sorted(
            (item for item in candidates if not item["easyCanary"]),
            key=lambda item: item["revisionDigest"],
        )
        ordered_candidates = [
            *easy_candidates[:8],
            *core_candidates[:16],
        ][:MAXIMUM_PROBE_CANDIDATES]
        definitions, created, destroyed = await probe_candidates(
            ordered_candidates, bun_path, arguments.bun_sha256
        )
        return {
            "schemaVersion": 1,
            "domain": "dark-factory.mvp-private-bootstrap-discovery.v1",
            "datasetName": DATASET_NAME,
            "datasetRef": f"sha256:{dataset_hash}",
            "datasetRevision": dataset_revision,
            "datasetContentSha256": dataset_content_sha256,
            "datasetManifestSha256": dataset_manifest_sha256,
            "registryRevision": 6,
            "sourceTaskCount": EXPECTED_TASK_COUNT,
            "compatibleTaskCount": len(definitions),
            "compatibilitySandboxesCreated": created,
            "compatibilitySandboxesDestroyed": destroyed,
            "allCompatibilitySandboxesDestroyed": created == destroyed,
            "definitions": definitions,
        }


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--output", required=True)
    parser.add_argument("--bun", required=True)
    parser.add_argument("--bun-sha256", required=True)
    parser.add_argument("--provider-limits", required=True)
    parser.add_argument("--provider-limits-digest", required=True)
    parser.add_argument("--eligibility-policy-digest", required=True)
    arguments = parser.parse_args()
    if (
        not SHA256.fullmatch(arguments.bun_sha256)
        or not SHA256.fullmatch(arguments.provider_limits_digest)
        or not SHA256.fullmatch(arguments.eligibility_policy_digest)
    ):
        raise DiscoveryError("Discovery digest argument is invalid")
    output = Path(arguments.output)
    if (
        not output.is_absolute()
        or output.name != "discovery.json"
        or "/workspace/df-state/private/bootstrap/" not in output.as_posix()
    ):
        raise DiscoveryError("Discovery output is outside evaluator-private state")
    return arguments


async def main() -> None:
    arguments = parse_arguments()
    output = await discover(arguments)
    output_path = Path(arguments.output)
    output_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(
        output_path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(canonical_json(output))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        raise SystemExit(1)
