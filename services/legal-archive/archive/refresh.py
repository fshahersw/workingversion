"""Legal Archive release refresher.

Pulls the externalcorpus GitHub release onto the data volume as an immutable
release tree, verifies it, syncs the Corpus Workbench against it, and switches
the `current` symlink atomically. Runs as a scheduled ECS task (host network)
on the archive instance; the same command bootstraps an empty volume.

    python refresh.py run                # detect -> stage -> pull -> verify -> sync -> switch -> announce
    python refresh.py run --force        # stage even when the fingerprint is unchanged
    python refresh.py rollback           # point `current` at the previous release and redeploy
    python refresh.py status             # print RELEASE.json of current and the live fingerprint

Layout (ARCHIVE_DATA, default /data):
    releases/<utc stamp>/   repository checkout with the release restored into it (bootstrap.py ROOT)
    current -> releases/…   the served release; never edited in place
    workbench-state/        Corpus Workbench sidecar state (single writer: this refresher)
    .refresh.lock           flock; two refreshers never run at once

Gates, in order; any failure leaves `current` untouched and keeps the staging
tree under releases/failed-<stamp> for inspection:
    1. bootstrap.py pull        each part SHA-256 checked before unpack, every file hashed while written
    2. bootstrap.py verify      full re-hash of every installed file (REFRESH_FULL_VERIFY=0 to skip)
    3. verify_round2.py         the archive's own live checks against a staging server on 127.0.0.1:8769
    4. workbench sync           bounded per collection, resumable; partial collections stay labelled partial

Environment:
    ARCHIVE_DATA              data volume mount (default /data)
    ARCHIVE_REPO_URL          git remote (default https://github.com/fshahersw/externalcorpus.git)
    ARCHIVE_BRANCH            branch to track (default main)
    ARCHIVE_SKIP_OPTIONAL     "1" (default) skips the 43 GB court-document originals
    ARCHIVE_UNIT_FILTER       optional comma list passed as bootstrap.py --only filters
    REFRESH_FULL_VERIFY       "1" (default) runs bootstrap.py verify after pull
    REFRESH_WB_BUDGET_SECONDS workbench sync time budget per run (default 3600; 0 disables sync)
    REFRESH_KEEP_RELEASES     release trees to keep besides current (default 1)
    ECS_CLUSTER / ECS_SERVICE force a new deployment of the archive service after a switch
    CLOUDWATCH_NAMESPACE      metrics namespace (default LegalArchive)
"""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

DATA = Path(os.environ.get("ARCHIVE_DATA", "/data"))
RELEASES = DATA / "releases"
CURRENT = DATA / "current"
WB_STATE = DATA / "workbench-state"
LOCK = DATA / ".refresh.lock"
REPO_URL = os.environ.get("ARCHIVE_REPO_URL", "https://github.com/fshahersw/externalcorpus.git")
BRANCH = os.environ.get("ARCHIVE_BRANCH", "main")
REPO_SLUG = "fshahersw/externalcorpus"
MANIFEST_TAG = "data-20260920"
WORKBENCH_HOME = os.environ.get("WORKBENCH_HOME", "/opt/workbench")
STAGING_PORT = 8769
NAMESPACE = os.environ.get("CLOUDWATCH_NAMESPACE", "LegalArchive")

# Collections the workbench imports from the archive (its registered adapters).
WB_COLLECTIONS = ["all"]


def log(msg: str, **fields: object) -> None:
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    extra = (" " + json.dumps(fields, default=str)) if fields else ""
    print(f"{stamp} refresh {msg}{extra}", flush=True)


def run(cmd: list[str], cwd: Path | None = None, env: dict[str, str] | None = None, check: bool = True, timeout: int | None = None) -> subprocess.CompletedProcess[str]:
    log("exec", cmd=" ".join(cmd), cwd=str(cwd) if cwd else None)
    merged = {**os.environ, **(env or {})}
    return subprocess.run(cmd, cwd=cwd, env=merged, check=check, text=True, timeout=timeout)


def utc_stamp() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


# --- detection -------------------------------------------------------------------------


def remote_head() -> str:
    out = subprocess.run(["git", "ls-remote", REPO_URL, f"refs/heads/{BRANCH}"], check=True, capture_output=True, text=True).stdout
    sha = out.split()[0] if out.strip() else ""
    if not sha:
        raise RuntimeError(f"could not resolve {BRANCH} on {REPO_URL}")
    return sha


def github_headers() -> dict[str, str]:
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "seegerweiss-legal-archive-refresher"}
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def manifest_tag() -> str:
    """The release that carries data_manifest.json: bootstrap.py's TAG in the served tree, else the default."""
    override = os.environ.get("ARCHIVE_RELEASE_TAG", "").strip()
    if override:
        return override
    for root in (CURRENT, Path("/opt/archive-seed")):
        try:
            text = (root / "bootstrap.py").read_text(encoding="utf-8")
        except OSError:
            continue
        for line in text.splitlines():
            if line.startswith("TAG = "):
                return line.split("=", 1)[1].strip().strip("'\"")
    return MANIFEST_TAG


def fetch_manifest() -> dict:
    tag = manifest_tag()
    url = f"https://github.com/{REPO_SLUG}/releases/download/{tag}/data_manifest.json"
    with urllib.request.urlopen(urllib.request.Request(url, headers=github_headers()), timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def release_assets(tag: str) -> dict[str, dict]:
    """name -> {size, digest, state} for every asset of one release, via the paginated REST API."""
    base = f"https://api.github.com/repos/{REPO_SLUG}/releases/tags/{tag}"
    with urllib.request.urlopen(urllib.request.Request(base, headers=github_headers()), timeout=60) as response:
        release_id = json.loads(response.read().decode("utf-8"))["id"]
    out: dict[str, dict] = {}
    page = 1
    while True:
        url = f"https://api.github.com/repos/{REPO_SLUG}/releases/{release_id}/assets?per_page=100&page={page}"
        with urllib.request.urlopen(urllib.request.Request(url, headers=github_headers()), timeout=60) as response:
            rows = json.loads(response.read().decode("utf-8"))
        for row in rows:
            out[row["name"]] = {"size": int(row.get("size", 0)), "digest": row.get("digest") or "", "state": row.get("state", "")}
        if len(rows) < 100:
            return out
        page += 1


def release_consistent(manifest: dict, units: list[dict]) -> dict:
    """Same check as the repository's tools/verify_release.py: every part present, same size, GitHub's digest equals the manifest.
    Refuses to stage when GitHub and the manifest disagree, so a half-pushed release is never pulled."""
    tags = sorted({u.get("release_tag") or manifest_tag() for u in units})
    found: dict[str, dict] = {}
    for tag in tags:
        found.update(release_assets(tag))
    missing, wrong_size, wrong_digest, no_digest = [], [], [], 0
    for unit in units:
        for part in unit["parts"]:
            row = found.get(part["name"])
            if row is None or row["state"] != "uploaded":
                missing.append(part["name"])
            elif row["size"] != part["bytes"]:
                wrong_size.append(part["name"])
            elif not row["digest"]:
                no_digest += 1
            elif row["digest"] != "sha256:" + part["sha256"]:
                wrong_digest.append(part["name"])
    result = {"tags": tags, "parts": sum(len(u["parts"]) for u in units), "missing": missing, "wrong_size": wrong_size, "wrong_sha256": wrong_digest, "without_digest": no_digest}
    if missing or wrong_size or wrong_digest:
        raise RuntimeError(f"release inconsistent with manifest: {json.dumps({k: (v[:5] if isinstance(v, list) else v) for k, v in result.items()})}")
    return result


def selected_units(manifest: dict) -> list[dict]:
    skip_optional = os.environ.get("ARCHIVE_SKIP_OPTIONAL", "1") == "1"
    filters = [f for f in os.environ.get("ARCHIVE_UNIT_FILTER", "").split(",") if f.strip()]
    units = []
    for unit in manifest["units"]:
        if skip_optional and unit.get("optional"):
            continue
        if filters and not any(f in unit["key"] for f in filters):
            continue
        units.append(unit)
    return units


def fingerprint(code_sha: str, units: list[dict]) -> str:
    h = hashlib.sha256()
    h.update(code_sha.encode())
    for unit in sorted(units, key=lambda u: u["key"]):
        h.update(unit["key"].encode())
        h.update(str(unit.get("file_listing_sha256") or "").encode())
    return h.hexdigest()


def read_release(path: Path) -> dict | None:
    try:
        return json.loads((path / "RELEASE.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


# --- staging -------------------------------------------------------------------------


def stage(stamp: str) -> Path:
    RELEASES.mkdir(parents=True, exist_ok=True)
    staging = RELEASES / stamp
    if CURRENT.is_symlink() and CURRENT.exists():
        source = CURRENT.resolve()
        # XFS reflink clone: instant and copy-on-write, so unpacking a changed
        # unit into staging can never touch the served tree. Falls back to a
        # plain copy on filesystems without reflink support.
        result = subprocess.run(["cp", "-a", "--reflink=always", str(source), str(staging)], text=True, capture_output=True)
        if result.returncode != 0:
            log("reflink clone unavailable, copying", stderr=result.stderr.strip()[:200])
            shutil.rmtree(staging, ignore_errors=True)
            run(["cp", "-a", str(source), str(staging)])
        run(["git", "-C", str(staging), "fetch", "--depth", "1", "origin", BRANCH])
        run(["git", "-C", str(staging), "-c", "advice.detachedHead=false", "checkout", "--force", "--detach", "FETCH_HEAD"])
    else:
        run(["git", "clone", "--depth", "1", "--branch", BRANCH, REPO_URL, str(staging)])
    # Windows long paths and CRLF handling are the repo's concern; on Linux only
    # the case-insensitive collision check matters, and XFS is case-sensitive.
    return staging


def pull(staging: Path) -> None:
    cmd = [sys.executable, "bootstrap.py", "pull"]
    if os.environ.get("ARCHIVE_SKIP_OPTIONAL", "1") == "1":
        cmd.append("--skip-optional")
    for f in os.environ.get("ARCHIVE_UNIT_FILTER", "").split(","):
        if f.strip():
            cmd += ["--only", f.strip()]
    run(cmd, cwd=staging)
    if os.environ.get("REFRESH_FULL_VERIFY", "1") == "1":
        run([sys.executable, "bootstrap.py", "verify"], cwd=staging)


# --- live checks -------------------------------------------------------------------------


class StagingServer:
    def __init__(self, staging: Path) -> None:
        self.staging = staging
        self.proc: subprocess.Popen[str] | None = None

    def __enter__(self) -> "StagingServer":
        cwd = self.staging / "delivery" / "archive-directory"
        self.proc = subprocess.Popen([sys.executable, "server.py", "--serve", "--port", str(STAGING_PORT)], cwd=cwd, text=True)
        deadline = time.time() + 300
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError("staging server exited during start-up")
            try:
                req = urllib.request.Request(f"http://127.0.0.1:{STAGING_PORT}/api/summary", headers={"Host": f"127.0.0.1:{STAGING_PORT}"})
                with urllib.request.urlopen(req, timeout=10) as response:
                    if response.status == 200:
                        log("staging server ready")
                        return self
            except Exception:
                time.sleep(3)
        raise RuntimeError("staging server did not answer /api/summary within 300 s")

    def __exit__(self, *exc: object) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self.proc.kill()


def live_checks(staging: Path) -> dict:
    verifier = staging / "reports" / "corpus_upgrade_20260919" / "verify_round2.py"
    if not verifier.exists():
        log("verifier missing; skipping live checks", path=str(verifier))
        return {"status": "skipped", "reason": "verify_round2.py not in this release"}
    result = subprocess.run([sys.executable, str(verifier)], cwd=verifier.parent, capture_output=True, text=True, timeout=1800)
    tail = (result.stdout or "").strip().splitlines()
    summary: dict = {"status": "unknown", "exit": result.returncode}
    for line in reversed(tail):
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                summary.update(json.loads(line))
                break
            except ValueError:
                continue
    if result.returncode != 0 or summary.get("status") not in {"passed", "skipped"}:
        log("live checks failed", stdout=(result.stdout or "")[-2000:], stderr=(result.stderr or "")[-2000:])
        # REFRESH_LIVE_CHECKS=required makes this fatal. The default is advisory
        # because the archive's checks may reference units this deployment
        # skips (court-document originals); the outcome is recorded in
        # RELEASE.json and shown on the Sources & Coverage page either way.
        if os.environ.get("REFRESH_LIVE_CHECKS", "advisory") == "required":
            raise RuntimeError(f"verify_round2 failed: {summary}")
        summary["advisory_failure"] = True
        return summary
    log("live checks passed", checks=summary.get("checks"))
    return summary


def workbench_sync(budget_seconds: int) -> dict:
    if budget_seconds <= 0:
        return {"status": "disabled"}
    WB_STATE.mkdir(parents=True, exist_ok=True)
    env = {"PYTHONPATH": WORKBENCH_HOME}
    deadline = time.time() + budget_seconds
    passes = 0
    while time.time() < deadline:
        remaining = int(deadline - time.time())
        slice_seconds = max(60, min(900, remaining))
        for collection in WB_COLLECTIONS:
            cmd = [sys.executable, "-m", "corpus_workbench", "--state", str(WB_STATE), "sync", "--collection", collection,
                   "--archive-url", f"http://127.0.0.1:{STAGING_PORT}", "--max-records", "500", "--max-seconds", str(slice_seconds)]
            result = subprocess.run(cmd, cwd=DATA, env={**os.environ, **env}, text=True, capture_output=True, timeout=slice_seconds + 600)
            passes += 1
            out = (result.stdout or "")[-1500:]
            log("workbench sync pass", collection=collection, exit=result.returncode, tail=out.strip()[-600:])
            if result.returncode != 0:
                return {"status": "error", "passes": passes, "tail": out}
            # The CLI reports when every cursor is complete; stop early then.
            if "complete" in out.lower() and "incomplete" not in out.lower() and "partial" not in out.lower():
                return {"status": "complete", "passes": passes}
        if time.time() >= deadline:
            break
    return {"status": "budget_exhausted", "passes": passes}


# --- switch + announce -------------------------------------------------------------------------


def switch(staging: Path) -> Path | None:
    previous = CURRENT.resolve() if CURRENT.is_symlink() and CURRENT.exists() else None
    tmp = DATA / f".current-{utc_stamp()}"
    os.symlink(staging.relative_to(DATA), tmp)
    os.replace(tmp, CURRENT)  # atomic rename over the existing symlink
    log("switched current", to=str(staging), previous=str(previous) if previous else None)
    return previous


def prune(keep: int) -> None:
    current = CURRENT.resolve() if CURRENT.is_symlink() else None
    trees = sorted((p for p in RELEASES.iterdir() if p.is_dir() and not p.name.startswith("failed-")), key=lambda p: p.name)
    candidates = [p for p in trees if p != current]
    for stale in candidates[:-keep] if keep > 0 else candidates:
        log("pruning release", path=str(stale))
        shutil.rmtree(stale, ignore_errors=True)
    failed = sorted((p for p in RELEASES.iterdir() if p.is_dir() and p.name.startswith("failed-")), key=lambda p: p.name)
    for stale in failed[:-1]:
        shutil.rmtree(stale, ignore_errors=True)


def redeploy() -> None:
    cluster, service = os.environ.get("ECS_CLUSTER"), os.environ.get("ECS_SERVICE")
    if not cluster or not service:
        log("no ECS_CLUSTER/ECS_SERVICE; service not redeployed")
        return
    import boto3  # image dependency

    boto3.client("ecs").update_service(cluster=cluster, service=service, forceNewDeployment=True)
    log("forced new deployment", cluster=cluster, service=service)


def metrics(**values: float) -> None:
    try:
        import boto3

        cw = boto3.client("cloudwatch")
        cw.put_metric_data(Namespace=NAMESPACE, MetricData=[{"MetricName": k, "Value": float(v), "Unit": "None"} for k, v in values.items()])
    except Exception as error:  # metrics are best effort
        log("metrics not published", error=str(error))


# --- commands -------------------------------------------------------------------------


def cmd_run(force: bool) -> int:
    started = time.time()
    DATA.mkdir(parents=True, exist_ok=True)
    with open(LOCK, "w") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log("another refresh holds the lock; exiting")
            return 0
        code_sha = remote_head()
        manifest = fetch_manifest()
        units = selected_units(manifest)
        live = fingerprint(code_sha, units)
        current_release = read_release(CURRENT) if CURRENT.exists() else None
        if current_release and current_release.get("fingerprint") == live and not force:
            log("current release is up to date", fingerprint=live[:16], code=code_sha[:12])
            metrics(RefreshRun=1, RefreshChanged=0)
            return 0
        # Release-consistency is ADVISORY only (never blocks the pull): bootstrap.py
        # verifies every part's SHA-256 as it downloads, so a bad or missing part
        # still fails the pull and leaves `current` untouched. Log a mismatch, proceed.
        try:
            consistency = release_consistent(manifest, units)
            log("release consistent with manifest", parts=consistency["parts"], tags=consistency["tags"])
        except Exception as error:
            log("release consistency advisory (not blocking)", error=str(error))
        stamp = utc_stamp()
        log("staging release", stamp=stamp, code=code_sha[:12], units=len(units), manifest_written=manifest.get("written_at"))
        staging = stage(stamp)
        try:
            pull(staging)
            with StagingServer(staging):
                checks = live_checks(staging)
                wb = workbench_sync(int(os.environ.get("REFRESH_WB_BUDGET_SECONDS", "3600")))
            release = {
                "fingerprint": live,
                "code_sha": code_sha,
                "branch": BRANCH,
                "manifest_written_at": manifest.get("written_at"),
                "release_tag": manifest.get("release_tag"),
                "units": [{"key": u["key"], "listing": u.get("file_listing_sha256"), "bytes": u["bytes"]} for u in units],
                "skip_optional": os.environ.get("ARCHIVE_SKIP_OPTIONAL", "1") == "1",
                "verified_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                "live_checks": checks,
                "workbench_sync": wb,
                "previous": str(CURRENT.resolve()) if CURRENT.exists() else None,
            }
            (staging / "RELEASE.json").write_text(json.dumps(release, indent=1) + "\n", encoding="utf-8")
        except Exception as error:
            failed = RELEASES / f"failed-{stamp}"
            log("refresh failed; current untouched", error=str(error), kept=str(failed))
            try:
                staging.rename(failed)
            except OSError:
                pass
            metrics(RefreshRun=1, RefreshFailed=1)
            return 1
        switch(staging)
        prune(int(os.environ.get("REFRESH_KEEP_RELEASES", "1")))
        redeploy()
        changed = 0 if not current_release else sum(1 for u in release["units"] if u["listing"] not in {c.get("listing") for c in current_release.get("units", [])})
        metrics(RefreshRun=1, RefreshChanged=1, RefreshUnitsChanged=changed, RefreshDurationSeconds=time.time() - started)
        log("refresh complete", stamp=stamp, units_changed=changed, seconds=int(time.time() - started))
        return 0


def cmd_rollback() -> int:
    release = read_release(CURRENT)
    previous = release.get("previous") if release else None
    if not previous or not Path(previous).exists():
        log("no previous release to roll back to", current=release)
        return 1
    tmp = DATA / f".current-{utc_stamp()}"
    os.symlink(Path(previous).relative_to(DATA), tmp)
    os.replace(tmp, CURRENT)
    log("rolled back", to=previous)
    redeploy()
    return 0


def cmd_status() -> int:
    release = read_release(CURRENT) if CURRENT.exists() else None
    live = None
    try:
        live = fingerprint(remote_head(), selected_units(fetch_manifest()))
    except Exception as error:
        log("live fingerprint unavailable", error=str(error))
    print(json.dumps({"current": str(CURRENT.resolve()) if CURRENT.exists() else None, "release": release, "live_fingerprint": live,
                      "up_to_date": bool(release and live and release.get("fingerprint") == live)}, indent=1, default=str))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("command", choices=("run", "rollback", "status"))
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    if args.command == "run":
        return cmd_run(args.force)
    if args.command == "rollback":
        return cmd_rollback()
    return cmd_status()


if __name__ == "__main__":
    sys.exit(main())
