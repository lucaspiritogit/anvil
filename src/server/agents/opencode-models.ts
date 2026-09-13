import type { Model, ProviderListResponse } from '@opencode-ai/sdk/client'
import type { ProviderModelList } from '../../shared/types'

type OpenCodeProvider = ProviderListResponse['all'][number]
type OpenCodeProviderModel = OpenCodeProvider['models'][string]
type CurrentOpenCodeModel = OpenCodeProviderModel & Partial<Pick<Model, 'capabilities'>> & {
  variants?: Record<string, unknown>
}

/** Convert the SDK provider response into the agent-neutral catalogue cached by Anvil. */
export function openCodeModelCatalogue(providers: ProviderListResponse): Pick<ProviderModelList,
  'models' | 'reasoningByModel' | 'capabilitiesByModel'> {
  const models: string[] = []
  const reasoningByModel: NonNullable<ProviderModelList['reasoningByModel']> = {}
  const capabilitiesByModel: NonNullable<ProviderModelList['capabilitiesByModel']> = {}
  const seen = new Set<string>()

  for (const provider of providers.all) {
    for (const providerModel of Object.values(provider.models)) {
      const modelId = `${provider.id}/${providerModel.id}`
      if (seen.has(modelId)) continue
      seen.add(modelId)
      models.push(modelId)

      const model = providerModel as CurrentOpenCodeModel
      const variants = model.variants && !Array.isArray(model.variants) ? Object.keys(model.variants) : []
      reasoningByModel[modelId] = {
        options: variants.map((variant) => ({ id: variant, label: variant }))
      }
      capabilitiesByModel[modelId] = {
        imageInput: model.capabilities?.input.image === true ||
          providerModel.modalities?.input.includes('image') === true ||
          providerModel.attachment === true
      }
    }
  }

  return { models, reasoningByModel, capabilitiesByModel }
}

/** ACP has no per-model image field, so use the SDK catalogue captured during discovery. */
export function requireOpenCodeImageModel(catalogue: ProviderModelList, model: string | undefined): void {
  if (!model) throw new Error('Select an explicit image-capable OpenCode model before attaching images.')
  if (catalogue.capabilitiesByModel?.[model]?.imageInput === true) return
  throw new Error(`OpenCode model ${model} does not advertise image input. Select an image-capable model or configure its input modalities to include image.`)
}
