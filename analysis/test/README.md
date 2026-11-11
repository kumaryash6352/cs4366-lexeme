# Analysis tests

Run from the repository root.

## Prepare

Install dependencies and compile the analysis code. Recompile after TypeScript changes.

```sh
npm ci
npx --no-install tsc -p analysis/tsconfig.json
```

## Component tests

Check prepared-image readiness, input validation, job lifecycle, cancellation, and
timeouts using mocks.
No Podman or sudo required.

```sh
# Run all mocked tests
node --test analysis/test/*.test.mjs

# Or run the component suite directly
node --test analysis/test/component.test.mjs
```

## Container run

Runs one real job: GCC syntax check and preprocessing of `project/main.c`, with
`zlib1g-dev` installed as a sample dependency. Requires Linux, rootless Podman,
and the configured image. See [runtime details](../README.md#runtime).

```sh
node analysis/test/backend-call.mjs
node analysis/test/backend-call.mjs ~/cJSON cJSON.c   # another project
```

Job outputs remain in `analysis/.jobs/`.

## Type and lint checks

```sh
npx --no-install tsc -p analysis/tsconfig.json --noEmit
npx --no-install oxlint -c .oxlintrc.json analysis/src analysis/worker analysis/test
```
