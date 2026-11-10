export const PROJECT_LIMITS = { files: 1000, bytes: 10 * 1024 * 1024, depth: 32 } as const

export interface ProjectUpload {
  name: string
  files: { path: string; content: string }[] // Base64 preserves every uploaded byte.
}

export interface ProjectFile { path: string; size: number }
export interface SourceFile { path: string; content: string }
export interface Project {
  id: string
  name: string
  files: ProjectFile[]
  initialFile: SourceFile
}

export function isSourceFile(path: string): boolean {
  return /\.(c|h)$/i.test(path)
}

export function isIgnoredPath(path: string): boolean {
  return path.split('/').some(part => ['.git', 'node_modules', '.jobs'].includes(part))
}
