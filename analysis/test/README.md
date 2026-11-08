# Analysis tests

Run from the repository root. Recompile after TypeScript changes.

```sh
npx --no-install tsc -p analysis/tsconfig.json
node --test analysis/test/*.test.mjs
npx --no-install oxlint -c .oxlintrc.json analysis/src analysis/worker analysis/test
```

`component.test.mjs` covers request/configuration validation and the container
lifecycle using mocked Podman calls. `logging.test.mjs` checks streaming,
truncation, diagnostic tails, and asynchronous output handling.

`worker.test.mjs` runs the actual worker locally. GCC tests require GCC; CMake
tests require CMake, Make, GCC, and Python 3 on PATH. Tests skip when their main
tools are unavailable. They cover custom source filenames, more than 32 flags,
multiple CMake compilation commands, quoted paths/macros, and configuration
failures. These tests use temporary directories and do not need Podman.

For an end-to-end container run, use Linux with working rootless Podman and a
published image containing the current worker. Set the image in
`analysis/runtime.config.json` first.

```sh
# Bundled CMake project; installs zlib1g-dev in the job container
node analysis/test/backend-call.mjs

# Another CMake project, optionally followed by Debian packages
node analysis/test/backend-call.mjs ~/cJSON
node analysis/test/backend-call.mjs /path/to/project zlib1g-dev libssl-dev
```

The script prints the job result and every artifact path. Outputs remain in
`analysis/.jobs/`. See [runtime details](../README.md#runtime).
