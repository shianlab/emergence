"""Inventory the pinned user archive as data. Never execute upstream installers/hooks."""

import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys
import zipfile

PIN = "27932415b4ac078f51fcff92ea38094c8d222960e475701e6a1c7a6df32a99f0"
ROOT = Path(__file__).resolve().parents[1]
ROLE_NAMES = {
    "conductor": "编排协调",
    "scout": "能力发现",
    "artisan": "能力组合",
    "genesis": "角色设计",
    "prism": "质量审查",
    "warden": "质量裁决",
    "sentinel": "安全边界",
    "librarian": "记忆管理",
    "chrysalis": "经验沉淀",
}
STAGE_NAMES = [
    "意图确认",
    "证据与能力发现",
    "方案规划",
    "执行",
    "审查",
    "审查标准复核",
    "验证",
    "经验沉淀",
]
PHASE_NAMES = [
    "方向",
    "计划",
    "执行",
    "审查",
    "元审查",
    "修订",
    "验证",
    "总结",
    "反馈",
    "进化",
    "组织复盘",
]
PHASE_MAP = [
    ["Critical", "Fetch"],
    ["Thinking"],
    ["Execution"],
    ["Review"],
    ["Meta-Review"],
    ["Thinking", "Execution"],
    ["Verification"],
    ["Verification"],
    ["Critical", "Evolution"],
    ["Evolution"],
    ["Evolution"],
]
TARGETS = {
    "attribution": "vendor/meta-kim",
    "verification-evidence": "tests (adapt selected upstream cases)",
    "documentation-history": "docs (source reference only)",
    "governance-roles": "src/core/assets/catalog.ts",
    "methodology": "src/core/domain and assets (phase 3)",
    "host-installation": "native build/configuration; no upstream installer",
    "memory-evolution": "src/core/application/memory (phase 5)",
    "observability": "native TUI projections (phase 5)",
    "durable-execution": "src/core/storage execution repository (phase 4)",
    "quality-evidence": "src/core/application/verification (phase 5)",
    "capability-discovery": "src/core/application/capabilities (phase 3)",
    "decision-permission": "src/core/domain/permissions.ts and src/core/adapters/permissions.ts",
    "host-adapters": "src/core/adapters/harness.ts and future native ports",
    "workflow-execution": "src/core/application/task-coordinator.ts",
    "contracts": "src/core/domain/contracts.ts and later stage-specific schemas",
    "configuration": "src/app/config.ts; explicit native settings",
    "support-infrastructure": "src/core adapters/application; review each dependency before port",
    "interaction-templates": "native Chinese TUI (phase 3)",
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def classify(path):
    # Ordered routing rules describe destination, not proof of source correctness.
    if path in ["LICENSE", "NOTICE"]:
        return "attribution", 2, "preserve"
    if path.startswith(("tests/", "fixtures/", "examples/")):
        return "verification-evidence", 6, "reference-only"
    if (
        path.startswith(("docs/", ".github/"))
        or "/" not in path
        and path not in ["package.json", "setup.mjs", "install-deps.sh"]
    ):
        return "documentation-history", 2, "reference-only"
    if path.startswith("canonical/agents/"):
        return "governance-roles", 2, "internal-definition"
    if path.startswith("canonical/skills/"):
        return "methodology", 3, "internal-policy"
    if path.startswith("canonical/templates/"):
        return "interaction-templates", 3, "translate-to-native-surface"
    if any(
        word in path
        for word in [
            "install",
            "setup",
            "uninstall",
            "sync-",
            "projection-package",
            "global-projection",
        ]
    ):
        return "host-installation", 2, "replace-with-native-integration"
    if any(
        word in path
        for word in [
            "memory",
            "knowledge",
            "evolution",
            "writeback",
            "compaction",
            "planning-continuity",
        ]
    ):
        return "memory-evolution", 5, "port-required"
    if any(word in path for word in ["live", "presentation", "report-panel", "share-artifact"]):
        return "observability", 5, "native-tui-projection"
    if any(
        word in path
        for word in [
            "durable",
            "sqlite",
            "transaction",
            "lease",
            "claim",
            "checkpoint",
            "process-runner",
        ]
    ):
        return "durable-execution", 4, "port-required"
    if any(
        word in path
        for word in ["review", "verify", "verification", "evidence", "fitness", "eval-"]
    ):
        return "quality-evidence", 5, "port-required"
    if any(
        word in path
        for word in [
            "capability",
            "capabilities",
            "provider",
            "dependency",
            "graphify",
            "discovery",
        ]
    ):
        return "capability-discovery", 3, "probe-before-binding"
    if any(
        word in path
        for word in ["decision", "choice", "approval", "safety", "security", "permission"]
    ):
        return "decision-permission", 4, "reuse-existing-authority"
    if path.startswith(
        (
            "src/runtimes/",
            "src/adapters/",
            "canonical/runtime-assets/",
            "config/candidate-runtime-assets/",
        )
    ):
        return "host-adapters", 4, "replace-with-harness-port"
    if any(
        word in path
        for word in [
            "governed-execution",
            "stage",
            "spine",
            "orchestrat",
            "scheduler",
            "dispatch",
            "fanout",
            "continuation",
        ]
    ):
        return "workflow-execution", 4, "reuse-existing-scheduler"
    if path.startswith("config/contracts/"):
        return "contracts", 2, "schema-mapping"
    if path.startswith("config/"):
        return "configuration", 2, "translate-no-global-write"
    if path.startswith(("scripts/", "src/", "bin/")) or path in [
        "package.json",
        "setup.mjs",
        "install-deps.sh",
    ]:
        return "support-infrastructure", 2, "review-before-port"
    raise ValueError("Unclassified source: " + path)


def main():
    archive = Path(sys.argv[1])
    raw = archive.read_bytes()
    if digest(raw) != PIN:
        raise ValueError("Archive differs from pinned reviewed source; do not update implicitly")
    with zipfile.ZipFile(archive) as z:
        files = {}
        for info in z.infolist():
            if info.is_dir():
                continue
            parts = PurePosixPath(info.filename).parts
            if parts[0] != "Meta_Kim-main" or any(
                p in ["..", "."] or ":" in p or "\\" in p for p in parts
            ):
                raise ValueError("Unsafe archive path")
            name = "/".join(parts[1:])
            if name in files or info.file_size > 10_000_000:
                raise ValueError("Duplicate or oversized entry")
            files[name] = z.read(info)

    def read(path):
        return json.loads(files[path])

    source = {
        "name": "Meta_Kim",
        "version": read("package.json")["version"],
        "archiveSha256": PIN,
        "license": "Apache-2.0",
    }
    refs = [
        "LICENSE",
        "NOTICE",
        "config/contracts/core-loop-contract.json",
        "config/contracts/workflow-contract.json",
        "canonical/skills/meta-theory/references/meta-theory.md",
        "canonical/skills/meta-theory/references/ten-step-governance.md",
        "config/candidate-runtime-assets/deepseek-harness/README.md",
    ]
    roles = []
    for key, name in ROLE_NAMES.items():
        path = f"canonical/agents/meta-{key}.md"
        refs.append(path)
        front = files[path].decode("utf-8").split("---", 2)[1]

        def field(name):
            return re.search(r"^" + re.escape(name) + r": (.+)$", front, re.M).group(1).strip('"')

        roles.append(
            {
                "id": "meta-" + key,
                "name": name,
                "responsibility": field("own"),
                "boundary": field("boundary"),
                "notResponsibleFor": field("do_not_touch"),
                "source": path,
                "sha256": digest(files[path]),
                "executionAuthority": False,
            }
        )
    loop = read("config/contracts/core-loop-contract.json")
    stages = [
        {
            "id": s["stage"],
            "name": STAGE_NAMES[i],
            "owner": s["defaultOwner"],
            "inputs": s["requiredInputs"],
            "outputs": s["requiredOutputs"],
            "skipConditions": s["skipConditions"],
        }
        for i, s in enumerate(loop["stages"])
    ]
    phases = [
        {"id": p, "name": PHASE_NAMES[i], "relatedStages": PHASE_MAP[i]}
        for i, p in enumerate(
            read("config/contracts/workflow-contract.json")["businessWorkflow"]["phases"]
        )
    ]
    deps = [
        {
            "id": d["id"],
            "upstreamEligibility": d.get("capabilityCard", {}).get("routeEligibility", "unknown"),
            "emergenceStatus": "not-connected",
            "phase": 3 if d["id"] != "planning-with-files" else 2,
        }
        for d in read("config/capability-index/dependency-project-registry.json")["projects"]
    ]
    catalog = {
        "schemaVersion": 1,
        "policyVersion": "emergence-core-0.2.0",
        "source": source,
        "roles": roles,
        "stages": stages,
        "businessPhases": phases,
        "dependencies": deps,
        "methodology": ["最小可治理单元", "组织职责映射", "按阶段控制节奏", "围绕用户目标交付"],
        "sourceAssets": [{"path": p, "sha256": digest(files[p])} for p in refs],
    }
    inventory = []
    for path, data in sorted(files.items()):
        category, phase, disposition = classify(path)
        status = "not-assessed"
        if path.endswith(".json"):
            try:
                obj = json.loads(data)
                if isinstance(obj, dict) and isinstance(obj.get("status"), str):
                    status = "declared:" + obj["status"][:100]
            except (ValueError, UnicodeError):
                pass
        if "shadow" in path or b"Pure shadow evaluator" in data[:2000]:
            status = "shadow-only"
        if path.startswith(("tests/", "fixtures/", "examples/")):
            status = "test-or-example-not-live-proof"
        inventory.append(
            {
                "path": path,
                "sha256": digest(data),
                "bytes": len(data),
                "category": category,
                "targetPhase": phase,
                "target": TARGETS[category],
                "disposition": disposition,
                "upstreamMaturity": status,
                "upstreamBehaviorVerified": False,
                "migrationStatus": "source-preserved" if path in refs else "mapped-not-ported",
                "vendored": path in refs,
            }
        )
    assets = ROOT / "src/core/assets"
    assets.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(catalog, ensure_ascii=False, separators=(",", ":"))
    (assets / "catalog.ts").write_text(
        "// Derived from Meta_Kim 3.7.3; see vendor/meta-kim/NOTICE and MODIFICATIONS.md.\n"
        + "export const catalogJson = "
        + json.dumps(payload, ensure_ascii=False)
        + ";\n"
        + "export const catalogSha256 = "
        + json.dumps(digest(payload.encode()))
        + ";\n",
        encoding="utf-8",
    )
    vendor = ROOT / "vendor/meta-kim"
    for path in refs:
        target = vendor / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(files[path])
    target = ROOT.parent / "docs/meta-kim-source-inventory.json"
    target.write_text(
        json.dumps(
            {"schemaVersion": 1, "source": source, "fileCount": len(inventory), "files": inventory},
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "files": len(inventory),
                "preservedSources": len(refs),
                "roles": len(roles),
                "stages": len(stages),
                "businessPhases": len(phases),
            }
        )
    )


if __name__ == "__main__":
    main()
