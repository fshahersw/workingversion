#!/bin/sh
# One image, three roles. Every role works on the data volume mounted at
# $ARCHIVE_DATA (default /data), whose layout the refresher owns:
#   /data/releases/<utc-stamp>/   full repository checkout + restored release data
#   /data/current -> releases/…   the release the service serves (atomic symlink)
#   /data/workbench-state/        Corpus Workbench sidecar state (SQLite FTS5, versions)
set -eu

DATA="${ARCHIVE_DATA:-/data}"
ROLE="${1:-archive}"

wait_for_current() {
  # The service tasks start before the first pull only on a brand-new volume:
  # block until the refresher has published a release rather than crash-loop.
  while [ ! -d "$DATA/current/delivery/archive-directory" ]; do
    echo "legal-archive: waiting for $DATA/current (run the refresher task to pull the release)"
    sleep 30
  done
}

case "$ROLE" in
  archive)
    wait_for_current
    cd "$DATA/current/delivery/archive-directory"
    # 127.0.0.1 only, by the server's design; the gateway container in the same
    # task network namespace is the only caller and rewrites the Host header.
    exec python server.py --serve --port "${ARCHIVE_PORT:-8769}"
    ;;
  workbench)
    wait_for_current
    mkdir -p "$DATA/workbench-state"
    cd "$DATA"
    exec env PYTHONPATH="${WORKBENCH_HOME:-/opt/workbench}" python -m corpus_workbench \
      --state "$DATA/workbench-state" serve --port "${WORKBENCH_PORT:-8770}" \
      --archive-url "http://127.0.0.1:${ARCHIVE_PORT:-8769}"
    ;;
  refresh)
    shift
    exec python /opt/refresh.py "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
