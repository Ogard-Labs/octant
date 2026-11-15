/**
 * What a Windows program reads to find the system, the person's folders and
 * its modules. Windows names are case-insensitive (`Path`, `SystemRoot`), so
 * these upper-case spellings match and set them whatever case the host uses.
 * A launch that inherits only POSIX names (`PATH`, `HOME`) left a Windows
 * program without its system folder or profile.
 */
export const WINDOWS_PROCESS_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set([
  "APPDATA",
  "COMPUTERNAME",
  "COMSPEC",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PSMODULEPATH",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
]);
