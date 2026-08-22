.PHONY: install install-ts install-go install-py install-rs test test-mcp test-ts test-go test-py test-rs check check-ts check-go check-py check-rs eval build build-ts build-go build-py build-rs format format-ts format-go format-py format-rs

install: install-ts install-go install-py install-rs

install-ts:
	npm ci --prefix typescript
	cd typescript && npm link

install-go:
	go -C go install ./cmd/tiny-go

install-py:
	uv tool install --force ./python

install-rs:
	cargo install --path ./rust --force

test: test-ts test-go test-py test-rs

test-rs:
	cd rust && cargo test --offline

test-ts:
	npm --prefix typescript test

test-mcp:
	npm --prefix typescript run test:mcp

test-go:
	go -C go test ./...

test-py:
	uv run --project python python -m unittest discover -s python/tests

check: check-ts check-go check-py check-rs

check-ts:
	npm --prefix typescript run lint
	npm --prefix typescript run format:check
	npm --prefix typescript run check

check-go:
	go -C go vet ./...

check-py:
	uv run --project python python -m compileall -q python/tiny_agent python/tests

check-rs:
	cd rust && cargo clippy --all-targets --offline -- -D warnings

eval:
	cd typescript && node --import tsx ../eval/run.ts

format: format-ts format-go format-py format-rs

format-rs:
	cd rust && cargo fmt

format-ts:
	npm --prefix typescript run format

format-go:
	gofmt -w go/cmd

format-py:
	@true

build: build-ts build-go build-py build-rs

build-rs:
	cd rust && cargo build --release --offline

build-ts:
	npm --prefix typescript run build

build-go:
	go -C go build -o /dev/null ./cmd/tiny-go

build-py:
	uv build --project python
