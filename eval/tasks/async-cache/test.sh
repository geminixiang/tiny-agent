#!/usr/bin/env bash
set -euo pipefail

node --test
node "$(dirname "$0")/verify.mjs"
git diff --exit-code HEAD -- test package.json
