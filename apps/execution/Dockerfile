FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 util-linux && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/execution
COPY files.mjs runner.mjs test-reporter.mjs ./
USER 1000:1000
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/execution/runner.mjs"]
