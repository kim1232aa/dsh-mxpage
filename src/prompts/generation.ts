export type PromptLanguage = 'zh-CN' | 'en' | 'ja' | 'ko'
export type AspectRatio = '1:1' | '3:4' | '9:16'
export type EditMode = 'repaint' | 'enhance' | 'translate'

export interface GenerationSection {
  type: string
  title: string
  goal: string
  copy: string
  visualPrompt: string
}

export interface GenerationRef {
  role: string
  isMain: boolean
}

const languageNames: Record<PromptLanguage, string> = {
  'zh-CN': 'Simplified Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
}

function buildReferenceText(referenceAssets: GenerationRef[]): string {
  if (!referenceAssets.length) return 'No reference images were provided.'
  return `Reference roles: ${referenceAssets.map((item) => `${item.role}${item.isMain ? ' (main)' : ''}`).join(' / ')}`
}

function buildMainImageInstruction(referenceAssets: GenerationRef[]): string {
  if (!referenceAssets.length) {
    return 'If no product image reference is provided, infer the product carefully from the structured analysis and keep the same product identity across all generated sections.'
  }
  return [
    'The uploaded main product image is the source of truth for product identity.',
    '主体与参考图一致：Keep the same product category, shape, material, color family, proportions, grid/layer structure, moving parts, and key recognisable details across every generated hero image and detail image.',
    'Do not invent a different product.',
    'Use the provided image as the visual anchor, then change composition, scene, angle, crop, lighting, and selling-point emphasis according to the section goal. Never replace the product with a similar-looking object or a generic prop.',
  ].join(' ')
}

function buildAspectInstruction(aspectRatio: AspectRatio): string {
  if (aspectRatio === '1:1') {
    return 'The final image must be a square 1:1 e-commerce hero composition, optimized for tappable product gallery covers.'
  }
  return aspectRatio === '3:4'
    ? 'The final image must be a vertical 3:4 marketplace poster composition.'
    : 'The final image must be a vertical 9:16 long-form mobile commerce composition.'
}

function buildTargetLanguageInstruction(contentLanguage: PromptLanguage): string {
  const targetLanguage = languageNames[contentLanguage]
  return [
    `All user-facing marketing copy that appears inside the image must be written in ${targetLanguage}.`,
    `The section title, key selling points, short supporting copy, disclaimers, and CTA should all be in ${targetLanguage} when they appear in the image.`,
    'Do not mix in Simplified Chinese unless the target language is Simplified Chinese.',
    'Keep the typography native, polished, and commercially readable for the target language.',
    '避免乱码文字：in-image copy must be sharp, correctly spelled, with no garbled glyphs or stacked duplicates.',
  ].join(' ')
}

function buildPhysicalRealityInstruction(): string {
  return [
    'Respect product physics and product-specific mechanical logic.',
    '几何不可反转：preserve real openings, hinges, layer count, seams, buttons, handles and part direction; do not mirror or invert structure.',
    '禁止逆风：airflow, liquid and heat may leave only through the real outlet; never blow backward from an intake.',
    'Infer how the product actually works from the uploaded image and section goal: cable exit points, vents, nozzles, hinges, openings, drawers, buttons, handles, gravity, shadows, reflections, support surfaces, airflow, liquid flow, and user interaction direction.',
    'Do not create impossible physical effects: reversed airflow, cords disappearing into furniture, floating unsupported products, hands passing through solid parts, liquids flowing upward, disconnected shadows, impossible reflections, text crossing through product geometry, or parts bending in a way the material cannot.',
    'For hair dryers specifically, airflow must leave the front nozzle, the rear intake must not emit wind, and the power cord must connect naturally from the handle/base instead of merging into a desk or wall.',
    'For Rubik cubes, speed cubes, puzzle cubes and other mechanical toys: preserve the correct cube order such as 3x3x3 when stated or visible, keep six square color faces, visible corner/edge/center piece logic, real twistable layer seams, rounded or straight tile style matching the reference, and do not turn it into a ruler, sticker sheet, generic storage box, electronics device, or unrelated block toy.',
  ].join(' ')
}

function buildGenerationRequirementsInstruction(generationRequirements?: string | null): string {
  const trimmed = generationRequirements?.trim()
  if (!trimmed) return 'No extra project-level image generation requirements were provided.'
  return [
    'Project-level image generation requirements from the user. Treat these as high-priority creative constraints for this image while still following the current section goal:',
    trimmed,
    'Operationalize these requirements concretely through camera angle, scene, props, product interaction, composition variation, and in-image copy. Do not ignore them or mention them only as abstract text.',
  ].join('\n')
}

export function buildSectionImagePrompt(
  section: GenerationSection,
  referenceAssets: GenerationRef[] = [],
  aspectRatio: AspectRatio = '9:16',
  contentLanguage: PromptLanguage = 'zh-CN',
  generationRequirements?: string | null,
): string {
  return [
    'You are a senior e-commerce key-visual designer creating marketplace-ready product artwork.',
    `Section type: ${section.type}`,
    `Section title: ${section.title}`,
    `Section goal: ${section.goal}`,
    `Section copy: ${section.copy}`,
    `Visual prompt guidance: ${section.visualPrompt}`,
    buildReferenceText(referenceAssets),
    buildMainImageInstruction(referenceAssets),
    buildAspectInstruction(aspectRatio),
    buildTargetLanguageInstruction(contentLanguage),
    buildGenerationRequirementsInstruction(generationRequirements),
    buildPhysicalRealityInstruction(),
    'Generate one high-conversion mobile e-commerce visual for this section.',
    'The image should emphasize product clarity, composition hierarchy, material texture, and marketplace aesthetics.',
    'The headline, selling points, supporting copy, and CTA should be visually designed inside the image rather than left for later DOM text insertion.',
    'Make the result feel like finished commercial artwork, not a blank template.',
  ].join('\n')
}

export function buildRegenerationPrompt(
  section: GenerationSection,
  referenceAssets: GenerationRef[] = [],
  aspectRatio: AspectRatio = '9:16',
  contentLanguage: PromptLanguage = 'zh-CN',
  generationRequirements?: string | null,
): string {
  return [
    buildSectionImagePrompt(section, referenceAssets, aspectRatio, contentLanguage, generationRequirements),
    'This is a regeneration task. Keep the same product identity and selling-point direction, but improve composition accuracy, completion quality, and conversion appeal.',
  ].join('\n')
}

export function buildImageEditPrompt(
  section: GenerationSection,
  referenceAssets: GenerationRef[] = [],
  mode: EditMode = 'repaint',
  aspectRatio: AspectRatio = '9:16',
  contentLanguage: PromptLanguage = 'zh-CN',
  generationRequirements?: string | null,
): string {
  const targetLanguage = languageNames[contentLanguage]
  const modeInstruction =
    mode === 'translate'
      ? `This is an in-image translation task. Use the current image as the base and translate every visible user-facing word, headline, selling point, label, badge, CTA, note, and disclaimer into ${targetLanguage}. Preserve the original product, layout, composition, typography hierarchy, colors, lighting, and commercial style as much as possible. Do not add new claims or redesign the image except where text length requires natural typographic fitting. Remove the original-language text after replacing it with ${targetLanguage}. 避免乱码文字。`
      : mode === 'enhance'
        ? 'This is an enhancement task. Use the current image as the base, preserve the overall framing, and improve realism, texture, lighting, clarity, edge quality, and commercial polish.'
        : 'This is a repaint task. Use the current image as the base, keep the same product identity, and redesign the composition, atmosphere, styling, and conversion emphasis according to the section goal.'

  return [
    buildSectionImagePrompt(section, referenceAssets, aspectRatio, contentLanguage, generationRequirements),
    modeInstruction,
    'The current section image must be treated as the editable base image.',
    'Keep the product identical to the uploaded main product image and do not replace it with a different item. 主体与参考图一致。',
    mode === 'translate'
      ? 'Only change the in-image language. Do not translate invisible metadata, do not add subtitles outside the artwork, and do not leave bilingual duplicates unless the original design intentionally uses bilingual branding.'
      : '',
    'Output one marketplace-ready mobile e-commerce image only.',
  ]
    .filter(Boolean)
    .join('\n')
}
