.PHONY: build test lint vet fmt all

all: fmt vet test build

build:
	go build ./...

test:
	go test ./... -count=1

vet:
	go vet ./...

fmt:
	gofmt -w .

lint:
	golangci-lint run -v
