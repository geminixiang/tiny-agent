#!/usr/bin/env bash
set -euo pipefail

node --test
node "$(dirname "$0")/verify.mjs"

test "$(git diff --name-only HEAD)" = "src/labels.js"
test "$(git rev-list --count HEAD)" = "1"
