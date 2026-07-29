// Explicit constructor options take precedence over environment configuration.
// An unset value lets the provider apply its default.

function firstDefined(option, fallback) {
  return option !== undefined ? option : fallback;
}

// Reasoning effort increases in priority from the environment to `effort` and
// then to `reasoning.effort`.
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

// Sampling and reasoning values are public agent fields that callers can
// change between runs and forkAt can copy.
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

export function resolveProviderRouting({ provider }, config) {
  return {
    order: provider?.order || config.provider.order,
    only: provider?.only || config.provider.only,
    avoid: provider?.avoid || config.provider.avoid,
    sort: provider?.sort || config.provider.sort,
    allowFallbacks: firstDefined(provider?.allowFallbacks, config.provider.allowFallbacks),
    requireParameters: firstDefined(provider?.requireParameters, config.provider.requireParameters),
    dataCollection: firstDefined(provider?.dataCollection, config.provider.dataCollection),
  };
}
