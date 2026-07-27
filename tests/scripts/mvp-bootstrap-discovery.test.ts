import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const script = resolve("scripts/mvp-bootstrap-discovery.py");

const pythonProbe = String.raw`
import asyncio
import hashlib
import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import types
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("mvp_bootstrap_discovery", sys.argv[1])
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)


def digest(label):
    return hashlib.sha256(label.encode("utf-8")).hexdigest()


def metadata(task_ids=None, files=None):
    tasks = task_ids or [
        SimpleNamespace(
            org="synthetic",
            name=f"task-{index:03d}",
            ref=f"sha256:{digest(f'task-{index:03d}')}",
        )
        for index in range(module.EXPECTED_TASK_COUNT)
    ]
    dataset_files = files or []
    task_digests = sorted(task.ref.removeprefix("sha256:") for task in tasks)
    material = ",".join(task_digests)
    if dataset_files:
        material += ";" + ",".join(
            sorted(f"{item.path}:{item.content_hash}" for item in dataset_files)
        )
    dataset_hash = hashlib.sha256(material.encode("utf-8")).hexdigest()
    return SimpleNamespace(
        name=module.DATASET_NAME,
        version=f"sha256:{dataset_hash}",
        dataset_version_content_hash=dataset_hash,
        task_ids=tasks,
        files=dataset_files,
    ), dataset_hash


def rejected(action):
    try:
        action()
    except module.DiscoveryError:
        return True
    return False


case = sys.argv[2]
if case == "empty-files":
    value, dataset_hash = metadata()
    manifest = module.package_dataset_manifest(value, dataset_hash)
    with tempfile.TemporaryDirectory() as root:
        task = pathlib.Path(root) / "task"
        task.mkdir()
        (task / "task.toml").write_text("synthetic = true\n", encoding="utf-8")
        inventory_digest = module.inventory_tree(pathlib.Path(root))
    result = {
        "fileCount": len(manifest["files"]),
        "taskCount": len(manifest["tasks"]),
        "datasetRef": manifest["datasetRef"],
        "manifestDigest": module.digest_json(manifest),
        "inventoryDigest": inventory_digest,
    }
elif case == "opaque-registry-hash":
    value, _ = metadata()
    historical_hash = "7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a"
    value.version = f"sha256:{historical_hash}"
    value.dataset_version_content_hash = historical_hash
    manifest = module.package_dataset_manifest(value, historical_hash)
    result = {
        "datasetRef": manifest["datasetRef"],
        "taskCount": len(manifest["tasks"]),
    }
elif case == "mutation":
    original, original_hash = metadata()
    original_digest = module.digest_json(
        module.package_dataset_manifest(original, original_hash)
    )
    reordered, reordered_hash = metadata(task_ids=list(reversed(original.task_ids)))
    reordered_digest = module.digest_json(
        module.package_dataset_manifest(reordered, reordered_hash)
    )
    changed_tasks = list(original.task_ids)
    changed_tasks[0] = SimpleNamespace(
        org=changed_tasks[0].org,
        name=changed_tasks[0].name,
        ref=f"sha256:{digest('changed-task')}",
    )
    changed, changed_hash = metadata(task_ids=changed_tasks)
    changed_digest = module.digest_json(
        module.package_dataset_manifest(changed, changed_hash)
    )
    file_info = SimpleNamespace(path="metric.py", content_hash=digest("metric"))
    with_file, with_file_hash = metadata(files=[file_info])
    with_file_digest = module.digest_json(
        module.package_dataset_manifest(with_file, with_file_hash)
    )
    result = {
        "orderIndependent": original_digest == reordered_digest,
        "taskMutationDetected": original_digest != changed_digest,
        "fileMutationDetected": original_digest != with_file_digest,
    }
elif case == "invalid":
    original, original_hash = metadata()
    duplicate_name = list(original.task_ids)
    duplicate_name[1] = SimpleNamespace(
        org=duplicate_name[0].org,
        name=duplicate_name[0].name,
        ref=duplicate_name[1].ref,
    )
    duplicate_revision = list(original.task_ids)
    duplicate_revision[1] = SimpleNamespace(
        org=duplicate_revision[1].org,
        name=duplicate_revision[1].name,
        ref=duplicate_revision[0].ref,
    )
    mutable = list(original.task_ids)
    mutable[0] = SimpleNamespace(
        org=mutable[0].org,
        name=mutable[0].name,
        ref="main",
    )
    invalid_file = SimpleNamespace(path="../metric.py", content_hash=digest("metric"))
    result = {
        "duplicateName": rejected(
            lambda: module.package_task_membership(duplicate_name)
        ),
        "duplicateRevision": rejected(
            lambda: module.package_task_membership(duplicate_revision)
        ),
        "mutableRef": rejected(lambda: module.package_task_membership(mutable)),
        "invalidFile": rejected(
            lambda: module.package_file_membership([invalid_file])
        ),
        "wrongDatasetHash": rejected(
            lambda: module.package_dataset_manifest(original, digest("wrong"))
        ),
    }
elif case == "tree":
    with tempfile.TemporaryDirectory() as root:
        root_path = pathlib.Path(root)
        file_path = root_path / "task.toml"
        file_path.write_text("first\n", encoding="utf-8")
        os.chmod(file_path, 0o600)
        first = module.inventory_tree(root_path)
        file_path.write_text("second\n", encoding="utf-8")
        second = module.inventory_tree(root_path)
        os.chmod(file_path, 0o640)
        third = module.inventory_tree(root_path)
        empty_directory = root_path / "empty"
        empty_directory.mkdir()
        fourth = module.inventory_tree(root_path)
        empty_directory.rmdir()
        link_path = root_path / "task-link"
        link_path.symlink_to(file_path)
        symlink_rejected = rejected(lambda: module.inventory_tree(root_path))
        link_path.unlink()
        task_id = SimpleNamespace(
            org="synthetic",
            name="path-task",
            ref=f"sha256:{digest('path-task')}",
        )
        expected_path = (
            root_path
            / task_id.org
            / task_id.name
            / task_id.ref.removeprefix("sha256:")
        )
        expected_path.mkdir(parents=True)
        item = SimpleNamespace(id=task_id, downloaded_path=expected_path)
        module.assert_downloaded_task_paths([item], root_path)
        outside_path = pathlib.Path(root).parent
        escaped = SimpleNamespace(id=task_id, downloaded_path=outside_path)
        escaped_path_rejected = rejected(
            lambda: module.assert_downloaded_task_paths([escaped], root_path)
        )
    result = {
        "contentMutationDetected": first != second,
        "emptyDirectoryMutationDetected": third != fourth,
        "escapedPathRejected": escaped_path_rejected,
        "modeMutationDetected": second != third,
        "symlinkRejected": symlink_rejected,
    }
elif case == "package-content":
    package_module = types.ModuleType("harbor")
    package_module.__path__ = []
    publisher_module = types.ModuleType("harbor.publisher")
    publisher_module.__path__ = []
    packager_module = types.ModuleType("harbor.publisher.packager")

    class Packager:
        computed_hash = digest("published")

        @staticmethod
        def compute_content_hash(root):
            return Packager.computed_hash, [root / "task.toml"]

    packager_module.Packager = Packager
    sys.modules["harbor"] = package_module
    sys.modules["harbor.publisher"] = publisher_module
    sys.modules["harbor.publisher.packager"] = packager_module

    with tempfile.TemporaryDirectory() as root:
        root_path = pathlib.Path(root)
        task_file = root_path / "task.toml"
        task_file.write_text("synthetic = true\n", encoding="utf-8")
        task_id = SimpleNamespace(ref=f"sha256:{Packager.computed_hash}")
        item = SimpleNamespace(id=task_id, downloaded_path=root_path)
        module.assert_downloaded_task_content_hashes([item])
        empty = root_path / "unexpected-empty"
        empty.mkdir()
        empty_directory_rejected = rejected(
            lambda: module.assert_downloaded_task_content_hashes([item])
        )
        empty.rmdir()
        Packager.computed_hash = digest("changed")
        content_hash_rejected = rejected(
            lambda: module.assert_downloaded_task_content_hashes([item])
        )
    result = {
        "contentHashRejected": content_hash_rejected,
        "emptyDirectoryRejected": empty_directory_rejected,
    }
elif case == "validated-download":
    class DatasetClient:
        def __init__(self, mode="valid"):
            self.file_calls = 0
            self.mode = mode

        async def download_dataset_files(self, metadata, **options):
            self.file_calls += 1
            result = {}
            for file_info in metadata.files:
                path = pathlib.Path(options["output_dir"]) / file_info.path
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(
                    "wrong" if self.mode == "wrong-hash" else "metric",
                    encoding="utf-8",
                )
                result[file_info.path] = path
            if self.mode == "extra":
                result["extra.py"] = pathlib.Path(options["output_dir"]) / "extra.py"
            return result

    class TaskClient:
        def __init__(self, mode="valid"):
            self.batches = []
            self.mode = mode

        async def download_tasks(self, task_ids, **options):
            self.batches.append(
                {
                    "ids": [task.ref for task in task_ids],
                    "overwrite": options["overwrite"],
                    "export": options["export"],
                }
            )
            results = []
            for task in task_ids:
                content_hash = task.ref.removeprefix("sha256:")
                path = (
                    pathlib.Path(options["output_dir"])
                    / task.org
                    / task.name
                    / content_hash
                )
                path.mkdir(parents=True)
                results.append(
                    SimpleNamespace(
                        path=(
                            pathlib.Path(options["output_dir"]).parent / "escaped"
                            if self.mode == "wrong-path" and not results
                            else path
                        ),
                        content_hash=(
                            digest("wrong-task")
                            if self.mode == "wrong-hash" and not results
                            else content_hash
                        ),
                    )
                )
            return SimpleNamespace(results=results)

    file_info = SimpleNamespace(path="metric.py", content_hash=digest("metric"))
    value, _ = metadata(files=[file_info])

    def rejected_download(dataset_mode="valid", task_mode="valid"):
        with tempfile.TemporaryDirectory() as root:
            try:
                asyncio.run(
                    module.download_validated_package_dataset(
                        DatasetClient(dataset_mode),
                        TaskClient(task_mode),
                        value,
                        pathlib.Path(root) / "dataset",
                        lambda **fields: SimpleNamespace(**fields),
                    )
                )
            except module.DiscoveryError:
                return True
        return False

    dataset_client = DatasetClient()
    task_client = TaskClient()
    with tempfile.TemporaryDirectory() as root:
        output_dir = pathlib.Path(root) / "dataset"
        items = asyncio.run(
            module.download_validated_package_dataset(
                dataset_client,
                task_client,
                value,
                output_dir,
                lambda **fields: SimpleNamespace(**fields),
            )
        )
    result = {
        "batchCount": len(task_client.batches),
        "maximumBatch": max(len(batch["ids"]) for batch in task_client.batches),
        "allImmutable": all(
            ref.startswith("sha256:")
            for batch in task_client.batches
            for ref in batch["ids"]
        ),
        "overwrite": all(not batch["overwrite"] for batch in task_client.batches),
        "export": all(not batch["export"] for batch in task_client.batches),
        "fileCalls": dataset_client.file_calls,
        "itemCount": len(items),
        "wrongTaskDigestRejected": rejected_download(task_mode="wrong-hash"),
        "wrongTaskPathRejected": rejected_download(task_mode="wrong-path"),
        "extraFileRejected": rejected_download(dataset_mode="extra"),
        "wrongFileHashRejected": rejected_download(dataset_mode="wrong-hash"),
    }
else:
    raise AssertionError("unknown probe")

print(json.dumps(result, sort_keys=True))
`;

async function probe(caseName: string): Promise<Record<string, unknown>> {
  const { stdout } = await execute("python3", ["-c", pythonProbe, script, caseName]);
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("evaluator-private MVP bootstrap discovery", () => {
  it("emits only a fixed phase marker when argument parsing fails", async () => {
    const failure = await execute("python3", [script]).catch(
      (error: { readonly stdout: string; readonly stderr: string }) => error,
    );

    expect(failure.stdout).toBe("");
    expect(failure.stderr).toBe("MVP_DISCOVERY_FAILURE:arguments\n");
  });

  it("accepts Harbor package datasets with no dataset.toml or optional files", async () => {
    const result = await probe("empty-files");

    expect(result).toMatchObject({
      fileCount: 0,
      taskCount: 89,
    });
    expect(result.datasetRef).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(result.manifestDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.inventoryDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("treats Harbor's historical dataset hash as an opaque registry pin", async () => {
    await expect(probe("opaque-registry-hash")).resolves.toEqual({
      datasetRef: "sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a",
      taskCount: 89,
    });
  });

  it("is order-independent and binds task and optional-file membership", async () => {
    await expect(probe("mutation")).resolves.toEqual({
      fileMutationDetected: true,
      orderIndependent: true,
      taskMutationDetected: true,
    });
  });

  it("rejects duplicate, mutable, malformed, and hash-inconsistent metadata", async () => {
    await expect(probe("invalid")).resolves.toEqual({
      duplicateName: true,
      duplicateRevision: true,
      invalidFile: true,
      mutableRef: true,
      wrongDatasetHash: true,
    });
  });

  it("binds file bytes and modes and rejects symlinks", async () => {
    await expect(probe("tree")).resolves.toEqual({
      contentMutationDetected: true,
      emptyDirectoryMutationDetected: true,
      escapedPathRejected: true,
      modeMutationDetected: true,
      symlinkRejected: true,
    });
  });

  it("rejects package content-hash drift and unexpected empty directories", async () => {
    await expect(probe("package-content")).resolves.toEqual({
      contentHashRejected: true,
      emptyDirectoryRejected: true,
    });
  });

  it("downloads exact task digests in bounded batches and validates declared files", async () => {
    await expect(probe("validated-download")).resolves.toEqual({
      allImmutable: true,
      batchCount: 18,
      export: true,
      fileCalls: 1,
      itemCount: 89,
      maximumBatch: 5,
      overwrite: true,
      extraFileRejected: true,
      wrongFileHashRejected: true,
      wrongTaskDigestRejected: true,
      wrongTaskPathRejected: true,
    });
  });
});
