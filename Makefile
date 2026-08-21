.PHONY: install install-ts install-go install-py test test-ts test-go test-py check check-ts check-go check-py format format-ts format-go format-py build build-ts build-go build-py

install: install-ts install-go install-py

install-ts:
	npm install --prefix typescript
	cd typescript && npm link

install-go:
	go -C go install ./cmd/tiny-go

install-py:
	uv tool install --force ./python

test: test-ts test-go test-py

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

format: format-ts format-go format-py

format-ts:
	npm --prefix typescript run format

format-go:
	gofmt -w go/cmd

format-py:
	@true

build: build-ts build-go build-py

build-ts:
	npm --prefix typescript run build

build-go:
	go -C go build -o /dev/null ./cmd/tiny-go

build-py:
	uv build --project python
