const SENSITIVE_ENV_PATTERNS = [
  'api_key',
  'apikey',
  'api-key',
  'secret',
  'token',
  'password',
  'credential',
  'auth',
  'openrouter',
  'tavily',
  'private_key',
  'privatekey',
];

const UNSAFE_ENV_KEYS = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'LD_PROFILE',
  'LD_ORIGIN_PATH',
  'GCONV_PATH',
  'NLSPATH',
  'LOCPATH',
  'HOSTALIASES',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'DYLD_FALLBACK_FRAMEWORK_PATH',
  'BASH_ENV',
  'ENV',
  'SHELLOPTS',
  'PS4',
  'IFS',
  'PROMPT_COMMAND',
  'NODE_OPTIONS',
  'NODE_REPL_EXTERNAL_MODULE',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PYTHONINSPECT',
  'PYTHONHOME',
  'PERL5LIB',
  'PERL5OPT',
  'PERLLIB',
  'PERL5DB',
  'RUBYOPT',
  'RUBYLIB',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'CLASSPATH',
  'PHPRC',
  'PHP_INI_SCAN_DIR',
]);

export function removeSecrets(environment) {
  const safeEnvironment = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!SENSITIVE_ENV_PATTERNS.some((pattern) => key.toLowerCase().includes(pattern))) safeEnvironment[key] = value;
  }
  return safeEnvironment;
}

export function sanitizeChildEnvironment(environment) {
  const safeEnvironment = {};
  for (const [key, value] of Object.entries(removeSecrets(environment))) {
    const upperKey = key.toUpperCase();
    if (UNSAFE_ENV_KEYS.has(upperKey) || upperKey.startsWith('BASH_FUNC_')) continue;
    safeEnvironment[key] = value;
  }
  return safeEnvironment;
}
