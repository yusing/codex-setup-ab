Improve argument handling in the `install.sh` implementation of `nvm_download`
when it translates curl-style arguments for wget.

For the installer's existing caller-supplied arguments, the wget path must retain
literal URLs and output paths without reparsing shell syntax. Preserve the existing
curl path and wget translations for progress, compression, failure, redirect,
headers, silence, output, and resume flags. An argument following `-C` must be
consumed as that option's value rather than forwarded independently. Paths containing
spaces and URLs containing shell metacharacters must remain one unchanged argument.
Support for output operands that themselves resemble options is outside this task.

Keep argument translation in POSIX-style shell constructs and retain the installer's
existing Bash entry-point requirement. Add local regression tests using fake download
commands, covering literal data, option translation, resume values, and the unchanged
curl route. Run `sh -n install.sh` and the focused installer tests without downloads.
