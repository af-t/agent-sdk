// Constructor options and environment config resolved into the settings an
// agent carries. An explicit option always wins over the environment, and both
// are allowed to leave a setting unset so the provider applies its own default.

function firstDefined(option, fallback) {
  return option !== undefined ? option : fallback;
}

// Reasoning effort has three spellings, in increasing priority: the environment,
// the `effort` option, and `reasoning.effort`.
function resolveReasoning({ effort, reasoning }, config) {
  let resolvedEffort = config.reasoning.effort;
  if (effort !== undefined) {
    resolvedEffort = effort;
  }
  if (reasoning && typeof reasoning === 'object' && reasoning.effort !== undefined) {
    resolvedEffort = reasoning.effort;
  }

  if (reasoning && typeof reasoning === 'object') {
    return {
      effort: firstDefined(resolvedEffort, config.reasoning.effort),
      maxTokens: firstDefined(reasoning.maxTokens, config.reasoning.maxTokens),
      exclude: firstDefined(reasoning.exclude, config.reasoning.exclude),
      enabled: firstDefined(reasoning.enabled, config.reasoning.enabled),
    };
  }

  const configured =
    resolvedEffort !== undefined ||
    config.reasoning.maxTokens !== undefined ||
    config.reasoning.exclude !== undefined ||
    config.reasoning.enabled !== undefined;
  if (!configured) return undefined;

  return {
    effort: resolvedEffort,
    maxTokens: config.reasoning.maxTokens,
    exclude: config.reasoning.exclude,
    enabled: config.reasoning.enabled,
  };
}

// The sampling and reasoning settings, which become public agent fields so a
// caller can change any of them between runs and forkAt() can carry them over.
export function resolveModelSettings(options, config) {
  return {
    temperature: firstDefined(options.temperature, config.temperature),
    topP: firstDefined(options.topP, config.topP),
    minP: firstDefined(options.minP, config.minP),
    topK: firstDefined(options.topK, config.topK),
    frequencyPenalty: firstDefined(options.frequencyPenalty, config.frequencyPenalty),
    presencePenalty: firstDefined(options.presencePenalty, config.presencePenalty),
    repetitionPenalty: firstDefined(options.repetitionPenalty, config.repetitionPenalty),
    seed: firstDefined(options.seed, config.seed),
    maxCompletionTokens: firstDefined(options.maxCompletionTokens, config.maxCompletionTokens),
    responseFormat: options.responseFormat,
    stop: options.stop,
    reasoning: resolveReasoning(options, config),
  };
}

// Which providers OpenRouter may route a request to. `order`/`only` are also
// accepted as top-level options, which is how they were spelled before the
// provider object existed.
export function resolveProviderRouting({ order, only, provider }, config) {
  const ignore = provider?.ignore || provider?.avoid || config.provider.avoid;
  return {
    order: order || provider?.order || config.provider.order,
    only: only || provider?.only || config.provider.only,
    ignore,
    avoid: ignore,
    sort: provider?.sort || config.provider.sort,
    allowFallbacks: firstDefined(provider?.allowFallbacks, config.provider.allowFallbacks),
    requireParameters: firstDefined(provider?.requireParameters, config.provider.requireParameters),
    dataCollection: firstDefined(provider?.dataCollection, config.provider.dataCollection),
  };
}
