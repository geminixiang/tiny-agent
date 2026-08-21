.PHONY: install install-ts install-go install-py test test-ts test-go test-py test-rust check check-ts check-go check-py build build-ts build-go build-py build-rust format format-ts format-go format-py format-rust

install: install-ts install-go install-py

install-ts:
	npm install --prefix typescript
	cd typescript && npm link

install-go:
	go -C go install ./cmd/tiny-go

install-py:
	uv tool install --force ./python

test: test-ts test-go test-py test-rust

test-rust:
	cd rust && cargo test --offline

test-ts:
	npm --prefix typescript test

test-go:
	go -C go test ./...

test-py:
	uv run --project python python -m unittest discover -s python/tests

check: check-ts check-go check-py

check-ts:
	npm --prefix typescript run lint
	npm --prefix typescript run format:check
	npm --prefix typescript run check

check-go:
	go -C go vet ./...

check-py:
	uv run --project python python -m compileall -q python/tiny_agent python/tests

format: format-ts format-go format-py format-rust

format-rust:
	cd rust && cargo fmt

format-ts:
	npm --prefix typescript run format

format-go:
	gofmt -w go/cmd

format-py:
	@true

build: build-ts build-go build-py build-rust

build-rust:
	cd rust && cargo build --release --offline

build-ts:
	npm --prefix typescript run build

build-go:
	go -C go build -o /dev/null ./cmd/tiny-go

build-py:
	uv build --project python
