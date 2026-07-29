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
  'NODE_PATH',
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

// Termux points LD_PRELOAD at libtermux-exec.so so that execve() resolves standard
// shebangs under $PREFIX, and dropping it breaks any child launched through one.
// An inherited LD_PRELOAD comes from the operator's own shell, at the same trust
// level as this process, so it survives. A supplied one is still an injection
// vector and must go through sanitizeChildEnvironment instead.
export function sanitizeInheritedEnvironment(environment) {
  const safeEnvironment = sanitizeChildEnvironment(environment);
  if (Object.hasOwn(environment, 'LD_PRELOAD')) safeEnvironment.LD_PRELOAD = environment.LD_PRELOAD;
  return safeEnvironment;
}
