#!/usr/bin/env bash
set -euo pipefail

node --test

git diff --exit-code HEAD -- test package.json
