# Analysis tests

Run from the repository root.

## Prepare

Install dependencies and compile the analysis code. Recompile after TypeScript changes.

```sh
npm ci
npx --no-install tsc -p analysis/tsconfig.json
```

## Component tests

Check setup, input validation, job lifecycle, cancellation, and timeouts using mocks.
No Podman or sudo required.

```sh
# Run all mocked tests
node --test analysis/test/*.test.mjs

# Or run each suite separately
node --test analysis/test/installation.test.mjs
node --test analysis/test/component.test.mjs
```

## Container smoke test

Check actual GCC processing, valid/invalid C inputs, container reuse, cancellation,
and cleanup. Requires Ubuntu and working rootless Podman.

```sh
# Only needed if setup must install Podman
sudo -v

# Prepare image; repeat after Containerfile or worker changes
node analysis/dist/setup/cli.js

# Run the end-to-end test
node analysis/test/smoke.mjs
```

Inputs: `test_cfiles/` and `parse-request.json`. Job outputs remain in `analysis/.jobs/`.
Invalid C samples are expected to fail; the overall test should exit with code 0.

## Type and lint checks

```sh
npx --no-install tsc -p analysis/tsconfig.json --noEmit
npx --no-install oxlint -c .oxlintrc.json analysis/src analysis/worker analysis/test
```
