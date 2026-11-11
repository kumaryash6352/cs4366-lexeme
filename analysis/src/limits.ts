// Prototype input limits. They bound host disk, memory, and argv size for a
// single interactive session; none is a GCC limit. Raise them when real
// projects need more.

/** Longest accepted project-relative path; far above typical C trees. */
export const MAX_PATH_CHARS = 512
/** Each include dir and define becomes one or two GCC argv entries. */
export const MAX_INCLUDE_DIRS = 32
export const MAX_DEFINES = 32
export const MAX_DEFINE_CHARS = 256
/** Inline editor source; larger inputs should be sent as a projectDir. */
export const MAX_SOURCE_BYTES = 1024 * 1024
export const MAX_DEPENDENCIES = 64
/** Debian package names are at most a few dozen characters in practice. */
export const MAX_DEPENDENCY_CHARS = 128
/** Copied project size; staging is a full copy into the job directory. */
export const MAX_PROJECT_FILES = 1000
export const MAX_PROJECT_BYTES = 10 * 1024 * 1024
export const MAX_PROJECT_DEPTH = 32
export const MAX_RESULT_BYTES = 1024 * 1024
export const MAX_JOBS_PER_SESSION = 100

/** Captured stdout/stderr per command. Large enough for `podman info --format json`. */
export const COMMAND_OUTPUT_CHARS = 64 * 1024
/** Tail of command output quoted in thrown error messages. */
export const ERROR_TAIL_CHARS = 4 * 1024
/** Worker stderr kept for `<job>/worker.log`; the log file is the full record. */
export const WORKER_LOG_CHARS = 1024 * 1024

/** Container defaults, overridable through ServiceOptions. */
export const DEFAULT_MEMORY = '512m'
export const DEFAULT_PIDS_LIMIT = 128
export const DEFAULT_TIMEOUT_MS = 60_000
export const MAX_TIMEOUT_MS = 600_000
