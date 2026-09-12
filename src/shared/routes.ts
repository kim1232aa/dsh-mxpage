/**
 * Route paths shared by the host (`src/host/routes.ts`) and the browser panel
 * (`src/client/api.ts`).
 *
 * Kept dependency-free on purpose: importing these constants from the host
 * module would drag `node:http` and the DSH webserver types into the browser
 * bundle.
 */

export const API_PREFIX = '/api/dsh-mxpage'

export const ROUTES = {
  projects: `${API_PREFIX}/projects`,
  projectCreate: `${API_PREFIX}/projects/create`,
  project: `${API_PREFIX}/project`,
  upload: `${API_PREFIX}/upload`,
  analyze: `${API_PREFIX}/analyze`,
  plan: `${API_PREFIX}/plan`,
  styleGuide: `${API_PREFIX}/style-guide`,
  section: `${API_PREFIX}/section`,
  sectionCreate: `${API_PREFIX}/section/create`,
  sectionDelete: `${API_PREFIX}/section/delete`,
  reorder: `${API_PREFIX}/reorder`,
  generate: `${API_PREFIX}/generate`,
  edit: `${API_PREFIX}/edit`,
  generatePage: `${API_PREFIX}/generate-page`,
  job: `${API_PREFIX}/job`,
  jobCancel: `${API_PREFIX}/job/cancel`,
  versions: `${API_PREFIX}/versions`,
  versionActivate: `${API_PREFIX}/versions/activate`,
  export: `${API_PREFIX}/export`,
  image: `${API_PREFIX}/image`,
  channels: `${API_PREFIX}/channels`,
  xhsPlan: `${API_PREFIX}/xiaohongshu/plan`,
  xhsGenerate: `${API_PREFIX}/xiaohongshu/generate`,
  xhsEdit: `${API_PREFIX}/xiaohongshu/edit`,
} as const
