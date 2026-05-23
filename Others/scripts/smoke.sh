#!/usr/bin/env bash
# Run the openclaw-bridge end-to-end smoke. The smoke vitest file spins up its
# own mock OpenClaw WebSocket server inside the test process, so no separate
# mock is required.
#
# Usage:
#   ./Others/scripts/smoke.sh
#
set -euo pipefail
cd "$(dirname "$0")/../../App"
pnpm test --run smoke-end-to-end.test.ts
