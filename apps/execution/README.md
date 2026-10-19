# Dragon execution image

Build the image explicitly from the repository root:

```powershell
docker build --tag wishtaday-execution:local --file apps/execution/Dockerfile apps/execution
```

Set `EXECUTION_ENABLED=true` in the API process environment to enable project commands. The driver uses the local `wishtaday-execution:local` image; `EXECUTION_IMAGE` may select another operator-built compatible image, and `EXECUTION_DOCKER` may select the Docker CLI executable. On Windows the default executable is `C:\Program Files\Docker\Docker\resources\bin\docker.exe`. Other systems use `docker` on PATH. Docker must use Linux containers. The API does not build or pull images automatically.

The worker receives file snapshots on stdin and returns command output plus the resulting snapshot on stdout. It runs as UID 1000 with a read-only image, no network, no capabilities, no privilege escalation, one CPU, 512 MiB memory and 128 processes. Only `/workspace` (64 MiB) and `/tmp` (32 MiB) are writable tmpfs mounts. There are no host bind mounts, persistent Docker volumes, application environment variables or Docker socket in the worker. Each command has its own container, removed after execution. Node.js 24, npm, Python 3 and standard library test tools are available; installing external packages needs network access and is unavailable.

Snapshots retain up to 200 regular files, 1 MiB per file, 8 MiB total. Binary content uses canonical Base64. Symlinks, special files and oversize results return `snapshotError` with no `files`; the caller must preserve the previous database snapshot and expose that failure. Command output is capped at 24,000 bytes per stream. Timeouts terminate remaining worker processes before taking a snapshot; the controller also removes the named container after a Docker CLI timeout. Missing or malformed worker output is an uncertain result and must never trigger automatic command replay.

Run unit tests with `node --test tests/execution-driver.test.mjs`. To additionally run real isolated containers:

```powershell
$env:EXECUTION_DOCKER_TESTS='true'
node --test tests/execution-driver.test.mjs
```

Production deployment is disabled by default. The existing Fargate application has no Docker daemon and requires an independently configured execution worker before project commands can run there.
