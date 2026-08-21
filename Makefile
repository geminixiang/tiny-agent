.PHONY: install install-ts install-go test test-ts test-go check check-ts check-go format format-ts format-go build build-ts build-go

install: install-ts install-go

install-ts:
	npm install --prefix typescript
	cd typescript && npm link

install-go:
	go -C go install ./cmd/tiny-go

test: test-ts test-go

test-ts:
	npm --prefix typescript test

test-go:
	go -C go test ./...

check: check-ts check-go

check-ts:
	npm --prefix typescript run lint
	npm --prefix typescript run format:check
	npm --prefix typescript run check

check-go:
	go -C go vet ./...

format: format-ts format-go

format-ts:
	npm --prefix typescript run format

format-go:
	gofmt -w go/cmd

build: build-ts build-go

build-ts:
	npm --prefix typescript run build

build-go:
	go -C go build -o /dev/null ./cmd/tiny-go
