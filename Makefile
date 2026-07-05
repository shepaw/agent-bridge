# Shepaw agent-bridge — npm release workflow
#
# First-time setup (one-time):
#   npm login
#   Create @shepaw org on npmjs.com and add yourself as owner
#   Enable npm 2FA: npm profile enable-2fa auth-and-writes
# Publish (requires granular token — npm login + OTP cannot publish on npm 11):
#   make publish-auth              # show token setup steps
#   npm config set //registry.npmjs.org/:_authToken npm_xxxx
#   make publish
#   make version VERSION=0.1.1    # bump all 6 packages + internal deps
#   npm install                 # refresh package-lock.json
#   git add -A && git commit -m "chore: release v0.1.1"
#   make publish                # after granular token is in ~/.npmrc

.DEFAULT_GOAL := help

NPM_RELEASE := node scripts/npm-release.mjs

.PHONY: help publish-check publish-dry-run publish publish-auth version install-global smoke

help:
	@echo "Shepaw npm release"
	@echo ""
	@echo "  make publish-check       Preflight (auth, versions, registry)"
	@echo "  make publish-dry-run     Build + npm pack --dry-run for all packages"
	@echo "  make publish-auth          How to create npm granular publish token"
	@echo "  make publish             Full release (needs npm_... token in ~/.npmrc)"
	@echo "  make version VERSION=x   Bump all package versions and internal deps"
	@echo "  make install-global      Install CLI from local build (smoke test)"
	@echo "  make smoke               Quick post-install CLI smoke test"
	@echo ""
	@echo "Typical release:"
	@echo "  make version VERSION=0.1.1 && npm install"
	@echo "  git commit -am 'chore: release v0.1.1'"
	@echo "  make publish-auth          # one-time token setup"
	@echo "  make publish               # after npm config set ...authToken npm_..."

publish-check:
	$(NPM_RELEASE) check

publish-dry-run: build
	$(NPM_RELEASE) dry-run

publish-auth:
	$(NPM_RELEASE) publish-auth

publish: publish-check build test
	$(NPM_RELEASE) publish

version:
ifndef VERSION
	$(error VERSION is required, e.g. make version VERSION=0.1.1)
endif
	$(NPM_RELEASE) version $(VERSION)

build:
	npm run build

test:
	npm run test

install-global: build
	cd agent-hub/cli && npm link

smoke:
	@command -v shepaw-hub >/dev/null || (echo "Run 'make install-global' first" && exit 1)
	shepaw-hub --version 2>/dev/null || shepaw-hub --help | head -3
	@echo "✓ shepaw-hub CLI is on PATH"
