import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  commandCompletedSuccessfully,
  parseWindowsUserSid,
} from './keySetupCore.mjs';
import { errorMessage } from './lib/thrownErrors.mjs';

/**
 * PowerShell verification for the exact owner-only Windows credential DACL.
 * It reads the ACL through .NET, not Get-Acl: Get-Acl autoloads its module
 * from PSModulePath, and a PSModulePath inherited from PowerShell 7 makes
 * Windows PowerShell 5.1 load PowerShell 7's copy of that module, which fails.
 */
const WINDOWS_ACL_VERIFY_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$acl = [System.IO.File]::GetAccessControl($env:GEV_ACL_FILE)',
  'if (-not $acl.AreAccessRulesProtected) { exit 2 }',
  "$allowed = @($env:GEV_ACL_USER_SID, 'S-1-5-18', 'S-1-5-32-544')",
  '$seen = @{}',
  '$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))',
  'if ($rules.Count -ne 3) { exit 7 }',
  'foreach ($rule in $rules) {',
  '  $ruleSid = $rule.IdentityReference.Value',
  '  if ($rule.IsInherited) { exit 3 }',
  '  if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { exit 4 }',
  '  if ($allowed -notcontains $ruleSid) { exit 5 }',
  '  if ($seen.ContainsKey($ruleSid)) { exit 8 }',
  '  $full = [System.Security.AccessControl.FileSystemRights]::FullControl',
  '  if ($rule.FileSystemRights -ne $full) { exit 6 }',
  '  $seen[$ruleSid] = $true',
  '}',
  'if ($seen.Count -ne 3) { exit 9 }',
].join('; ');

/** What each exit status of the verification script means. */
const WINDOWS_ACL_VERIFY_FAILURES = Object.freeze({
  1: 'PowerShell reported an error',
  2: 'inheritance is still enabled',
  3: 'an inherited rule remains',
  4: 'a rule is not an allow rule',
  5: 'a rule names an unexpected principal',
  6: 'a rule grants less than full control',
  7: 'there are not exactly three rules',
  8: 'a principal appears twice',
  9: 'a principal is missing',
});

/**
 * A refused hardening, naming the step and why.
 * @param {string} step
 * @param {string} detail
 */
function failure(step, detail) {
  return { ok: false, step, detail };
}

/**
 * One line on a failed subprocess: its spawn error, signal or exit status,
 * what that status means when known, and the first line it printed.
 * @param {import('node:child_process').SpawnSyncReturns<string | Buffer>} result
 * @param {Readonly<Record<number, string>>} [meanings]
 */
function describeCommandFailure(result, meanings = {}) {
  if (!result) return 'no result';
  if (result.error) return result.error.message;
  if (result.signal) return `killed by ${result.signal}`;
  const meaning = meanings[/** @type {number} */ (result.status)]
    ? `: ${meanings[/** @type {number} */ (result.status)]}`
    : '';
  const output = `${result.stderr || ''}\n${result.stdout || ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return `exit ${result.status}${meaning}${output ? ` (${output.slice(0, 200)})` : ''}`;
}

/**
 * Resolve the native Windows ACL tools without consulting PATH.
 *
 * Provider Settings supports the standard Windows installation layout only:
 * a local drive root named `Windows` (for example C:\\Windows or D:\\Windows).
 * Requiring consistent aliases, canonical paths, and regular files prevents an
 * inherited environment override, UNC share, device path, junction, or PATH
 * shim from being treated as an operating-system security tool.
 * @param {NodeJS.ProcessEnv} environment
 * @param {typeof fs} fileSystem
 * @param {NodeJS.Architecture} architecture
 */
function resolveWindowsNativeTools(environment, fileSystem, architecture) {
  const aliases = ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'windir'];
  const configured = /** @type {string[]} */ (
    aliases
      .map((name) => environment[name])
      .filter((value) => typeof value === 'string' && value.length > 0)
  );
  if (configured.length === 0) return null;

  const roots = configured.map((value) => {
    if (value !== value.trim() || !/^[A-Za-z]:\\Windows\\?$/i.test(value))
      return null;
    return value.endsWith('\\') ? value.slice(0, -1) : value;
  });
  if (roots.some((root) => !root)) return null;
  if (
    roots.some(
      (root) =>
        /** @type {string} */ (root).toLowerCase() !==
        /** @type {string} */ (roots[0]).toLowerCase(),
    )
  )
    return null;

  const systemRoot = /** @type {string} */ (roots[0]);
  const systemDirectory = architecture === 'ia32' ? 'Sysnative' : 'System32';
  const expected = {
    whoami: path.win32.join(systemRoot, systemDirectory, 'whoami.exe'),
    icacls: path.win32.join(systemRoot, systemDirectory, 'icacls.exe'),
    powershell: path.win32.join(
      systemRoot,
      systemDirectory,
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
  };

  try {
    // Called with a path alone, both variants return a string.
    /** @type {(path: string) => string} */
    const realpath = fileSystem.realpathSync.native || fileSystem.realpathSync;
    const rootEntry = fileSystem.lstatSync(systemRoot);
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) return null;
    const canonicalRoot = realpath.call(fileSystem.realpathSync, systemRoot);
    if (canonicalRoot.toLowerCase() !== systemRoot.toLowerCase()) return null;
    for (const executable of Object.values(expected)) {
      const entry = fileSystem.lstatSync(executable);
      if (!entry.isFile() || entry.isSymbolicLink()) return null;
      const canonicalExecutable = realpath.call(
        fileSystem.realpathSync,
        executable,
      );
      const canonicalCandidates = [executable];
      if (architecture === 'ia32') {
        canonicalCandidates.push(
          executable.replace('\\Sysnative\\', '\\System32\\'),
        );
      }
      if (
        !canonicalCandidates.some(
          (candidate) =>
            candidate.toLowerCase() === canonicalExecutable.toLowerCase(),
        )
      )
        return null;
    }
  } catch {
    return null;
  }
  return expected;
}

/**
 * Restrict a credential file before any secret is written to it, and say
 * which step failed when that isn't possible. Dependencies are injectable so
 * every fail-closed branch is unit-testable.
 * @param {string} filepath
 * @returns {{ ok: true } | { ok: false, step: string, detail: string }}
 */
export function hardenCredentialFileReport(
  filepath,
  {
    platform = process.platform,
    architecture = process.arch,
    spawn = spawnSync,
    fileSystem = fs,
    environment = process.env,
  } = {},
) {
  if (platform !== 'win32') {
    let step = 'chmod';
    try {
      if (platform === 'darwin') {
        step = 'chmod -N';
        const aclRemoval = spawn('chmod', ['-N', filepath], {
          stdio: 'ignore',
        });
        if (!commandCompletedSuccessfully(aclRemoval)) {
          return failure(step, describeCommandFailure(aclRemoval));
        }
        step = 'chmod';
      }
      fileSystem.chmodSync(filepath, 0o600);
      const mode = fileSystem.statSync(filepath).mode & 0o777;
      if (mode !== 0o600)
        return failure(step, `the mode is ${mode.toString(8)}, not 600`);
      return { ok: true };
    } catch (error) {
      return failure(step, errorMessage(error) ?? String(error));
    }
  }

  const tools = resolveWindowsNativeTools(
    environment,
    fileSystem,
    architecture,
  );
  if (!tools) {
    return failure(
      'native tools',
      'whoami, icacls or powershell is not at its standard path under SystemRoot',
    );
  }

  let step = 'whoami';
  try {
    // Grant by the CURRENT PROCESS TOKEN'S SID, never a bare username. Parsing
    // the second CSV field structurally prevents an SID-looking account name or
    // a broad group SID from becoming the credential owner.
    const whoami = spawn(tools.whoami, ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (!commandCompletedSuccessfully(whoami))
      return failure(step, describeCommandFailure(whoami));
    const sid = parseWindowsUserSid(whoami.stdout);
    if (!sid) return failure(step, 'its output named no user SID');

    step = 'icacls';
    const applied = spawn(
      tools.icacls,
      [
        filepath,
        '/inheritance:r',
        '/grant:r',
        `*${sid}:F`,
        '*S-1-5-18:F',
        '*S-1-5-32-544:F',
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    if (!commandCompletedSuccessfully(applied))
      return failure(step, describeCommandFailure(applied));

    // Command success is not proof of the resulting DACL. Query it back and
    // accept only three explicit FullControl allow principals, with inheritance
    // disabled. Any unexpected rule, right, command error, or missing principal
    // fails closed before the secret reaches disk.
    step = 'verify';
    /** @type {NodeJS.ProcessEnv} */
    const verifyEnvironment = {
      ...environment,
      GEV_ACL_FILE: filepath,
      GEV_ACL_USER_SID: sid,
    };
    // Windows PowerShell 5.1 must build its own module path: one inherited
    // from a PowerShell 7 parent points it at incompatible modules.
    for (const name of Object.keys(verifyEnvironment)) {
      if (name.toLowerCase() === 'psmodulepath') delete verifyEnvironment[name];
    }
    const verified = spawn(
      tools.powershell,
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_ACL_VERIFY_SCRIPT],
      {
        encoding: 'utf8',
        env: verifyEnvironment,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    if (!commandCompletedSuccessfully(verified)) {
      return failure(
        step,
        describeCommandFailure(verified, WINDOWS_ACL_VERIFY_FAILURES),
      );
    }
    return { ok: true };
  } catch (error) {
    return failure(step, errorMessage(error) ?? String(error));
  }
}

/**
 * Restrict a credential file before any secret is written to it.
 * @param {string} filepath
 * @param {Parameters<typeof hardenCredentialFileReport>[1]} [options]
 */
export function hardenCredentialFile(filepath, options) {
  return hardenCredentialFileReport(filepath, options).ok;
}
