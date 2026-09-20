# Legal Archive runtime image: the externalcorpus directory server, the Corpus
# Workbench sidecar and the release refresher share one image (different
# commands). The archive CODE that serves requests lives on the data volume
# next to its data (/data/current is a git checkout with the release restored
# into it), so code and data always match per release; the copy baked in here
# only bootstraps an empty volume and runs the workbench package.
FROM python:3.11-slim

ARG ARCHIVE_REPO=https://github.com/fshahersw/externalcorpus.git
ARG ARCHIVE_COMMIT=main

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    ARCHIVE_DATA=/data \
    WORKBENCH_HOME=/opt/workbench

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl unzip xfsprogs \
 && rm -rf /var/lib/apt/lists/*

# Server needs: lxml, courts-db, pillow (TRANSFER.md). Workbench: pypdf and
# eyecite for citations (its README lists both as optional; we ship them so a
# release sync produces citations). boto3 for the refresher's ECS/CloudWatch calls.
RUN pip install \
      "lxml>=5,<6" \
      "courts-db>=0.10" \
      "pillow>=10,<12" \
      "pypdf>=4,<6" \
      "boto3>=1.34,<2"
# eyecite widens the workbench's citation detection; it pulls native wheels
# (pyahocorasick, hyperscan) that occasionally lag a Python release, so it is
# best-effort: without it the workbench falls back to its built-in detector
# and labels citations with that parser signature.
RUN pip install "eyecite>=2.6,<3" || echo "eyecite unavailable; workbench uses its built-in citation detector"

# Bootstrap copy of the repository (code only, ~5 MB) and the workbench package
# extracted from the zip the repository carries.
RUN git clone --depth 1 "$ARCHIVE_REPO" /opt/archive-seed \
 && git -C /opt/archive-seed -c advice.detachedHead=false checkout "$ARCHIVE_COMMIT" || true \
 && mkdir -p "$WORKBENCH_HOME" \
 && unzip -q /opt/archive-seed/externalcorpus-workbench-upgrade.zip -d /tmp/wb \
 && mv /tmp/wb/externalcorpus-workbench-upgrade/corpus_workbench "$WORKBENCH_HOME/corpus_workbench" \
 && rm -rf /tmp/wb

COPY refresh.py /opt/refresh.py
COPY entrypoint.sh /opt/entrypoint.sh
RUN chmod +x /opt/entrypoint.sh

WORKDIR /data
ENTRYPOINT ["/opt/entrypoint.sh"]
CMD ["archive"]
