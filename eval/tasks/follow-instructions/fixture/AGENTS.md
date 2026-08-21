# Project instructions

- Only modify `src/labels.js`.
- Do not add dependencies or create files.
- `normalizeLabel(value)` must trim leading and trailing whitespace, collapse internal whitespace to one space, convert the result to uppercase, then prefix it with `tiny:`.
- Throw `TypeError("Label must be a string")` when value is not a string.
