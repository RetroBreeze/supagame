// Output is untrusted and may contain arbitrary credentials. Extract only fixed
// diagnostic vocabulary; never forward messages, headers, URLs or JSON bodies.
export function safeProcessOutput(stdout: string, stderr: string): string {
  const known = ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'ENOENT', 'EACCES', 'ABORT_ERR', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'FunctionsApiTransportError', 'HostedMutationConsentRequiredError'];
  const describe = (value: string) => known.filter(code => new RegExp(`\\b${code}\\b`).test(value)).join(', ') || 'unrecognized diagnostic';
  return `stderr: ${stderr ? describe(stderr) : 'empty'}; stdout: ${stdout ? describe(stdout) : 'empty'}; raw output is withheld.`;
}
export class DeploymentDiagnostic extends Error {}
