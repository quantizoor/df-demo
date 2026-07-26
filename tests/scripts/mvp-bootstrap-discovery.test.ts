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
        "escapedPathRejected": escaped_path_rejected,
        "modeMutationDetected": second != third,
        "symlinkRejected": symlink_rejected,
    }
elif case == "download-reference":
    class Client:
        def __init__(self):
            self.reference = None
            self.options = None

        async def download_dataset(self, reference, **options):
            self.reference = reference
            self.options = options
            return []

    client = Client()
    dataset_hash = digest("dataset")
    with tempfile.TemporaryDirectory() as root:
        output_dir = pathlib.Path(root) / "dataset"
        asyncio.run(
            module.download_immutable_package_dataset(
                client,
                dataset_hash,
                output_dir,
            )
        )
    result = {
        "reference": client.reference,
        "overwrite": client.options["overwrite"],
        "outputDir": pathlib.Path(client.options["output_dir"]).name,
        "export": client.options["export"],
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
      escapedPathRejected: true,
      modeMutationDetected: true,
      symlinkRejected: true,
    });
  });

  it("downloads through the immutable digest reference", async () => {
    const result = await probe("download-reference");

    expect(result).toMatchObject({
      export: false,
      outputDir: "dataset",
      overwrite: false,
    });
    expect(result.reference).toMatch(/^terminal-bench\/terminal-bench-2-1@sha256:[a-f0-9]{64}$/u);
  });
});
