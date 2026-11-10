import { isIgnoredPath, isSourceFile, PROJECT_LIMITS } from '../shared/project.ts'
import type { OpenProjectResponse, Project, ProjectUpload, SourceFile } from '../shared/project.ts'

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  let response: Response
  try { response = await fetch(url, options) }
  catch { throw new Error('Cannot reach the project server. Check that Lexeme is running and try again.') }
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { message?: string } | null
    throw new Error(error?.message ?? `Project request failed (${response.status}).`)
  }
  return response.json() as Promise<T>
}

function base64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`))
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.readAsDataURL(file)
  })
}

export async function openRepository(selection: File[]): Promise<OpenProjectResponse> {
  const rootName = selection[0]?.webkitRelativePath.split('/')[0]
  if (!rootName) throw new Error('Choose a repository folder containing C source files.')
  const files = selection.map(file => {
    const [root, ...parts] = file.webkitRelativePath.split('/')
    if (root !== rootName) throw new Error('Choose one repository at a time.')
    return { file, path: parts.join('/') }
  }).filter(({ path }) => !isIgnoredPath(path))
  if (!files.some(({ path }) => isSourceFile(path))) throw new Error('The repository must contain at least one .c or .h file.')
  if (files.length > PROJECT_LIMITS.files) throw new Error('The repository exceeds the 1,000-file upload limit.')
  if (files.reduce((size, { file }) => size + file.size, 0) > PROJECT_LIMITS.bytes) {
    throw new Error('The repository exceeds the 10 MiB upload limit.')
  }
  const upload: ProjectUpload = { name: rootName, files: [] }
  // Read sequentially so a large selection does not start hundreds of FileReaders.
  for (const { file, path } of files) upload.files.push({ path, content: await base64(file) })
  return request<OpenProjectResponse>('/api/project', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(upload),
  })
}

export const getProject = () => request<Project | null>('/api/project')
export const readSource = (projectId: string, path: string) =>
  request<SourceFile>(`/api/project/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(path)}`)
