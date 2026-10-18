// Environment for a spawned child process (a stdio MCP server, for example). A child never inherits
// process.env: it gets a small whitelist of harmless variables, plus whatever the one server
// explicitly needs. MEDJAY_* keys and anything secret-looking are never passed implicitly, so a
// compromised or careless server cannot read the harness's credentials.
const SAFE_NAMES: ReadonlySet<string> = new Set(
  [
    "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "SYSTEMDRIVE", "TEMP", "TMP", "TMPDIR",
    "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
    "LANG", "LC_ALL", "LC_CTYPE", "TZ", "USER", "USERNAME", "LOGNAME", "SHELL", "TERM",
    "OS", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
  ].map((name) => name.toLowerCase()),
);

const SECRET_LOOKING = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;
const CODE_INJECTION = /^(?:NODE_OPTIONS|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*|PYTHONSTARTUP|PYTHONPATH|RUBYOPT|PERL5OPT|JAVA_TOOL_OPTIONS)$/i;
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ChildEnvOptions {
  /** Extra harmless names to inherit from the parent. Secret-looking names are refused. */
  allow?: readonly string[];
  /** Variables this one child needs (for example its own short-lived credential). Passed as given. */
  extra?: Readonly<Record<string, string>>;
}

export function safeChildEnv(parent: Readonly<Record<string, string | undefined>>, options: ChildEnvOptions = {}): Record<string, string> {
  const inherit = new Set(SAFE_NAMES);
  for (const name of options.allow ?? []) {
    if (!VALID_NAME.test(name)) throw new Error(`invalid environment variable name "${name}"`);
    if (/^MEDJAY_/i.test(name)) throw new Error(`"${name}" cannot be inherited: MEDJAY_* variables are never passed to child processes`);
    if (SECRET_LOOKING.test(name) || CODE_INJECTION.test(name)) throw new Error(`"${name}" cannot be inherited: it looks like a secret or can inject code`);
    inherit.add(name.toLowerCase());
  }

  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && inherit.has(name.toLowerCase())) env[name] = value;
  }
  for (const [name, value] of Object.entries(options.extra ?? {})) {
    if (!VALID_NAME.test(name)) throw new Error(`invalid environment variable name "${name}"`);
    if (/^MEDJAY_/i.test(name)) throw new Error(`"${name}" cannot be passed to a child: MEDJAY_* variables are the harness's own credentials`);
    if (CODE_INJECTION.test(name)) throw new Error(`"${name}" can inject code into the child and is refused`);
    env[name] = value;
  }
  return env;
}
