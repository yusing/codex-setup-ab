#!/usr/bin/env bash
set -euo pipefail
: "${MEKUGI_BASE_URL:?Codex must be launched by mekugi}"
: "${MEKUGI_RUNTIME_DIR:?}"
: "${MEKUGI_EXPORT_DIR:?}"
export TMPDIR=/tmp
case "$MEKUGI_BASE_URL" in
 http://127.0.0.1:*) firewall=iptables; listener=127.0.0.1; port=${MEKUGI_BASE_URL#http://127.0.0.1:} ;;
 http://\[::1\]:*) firewall=ip6tables; listener=::1; port=${MEKUGI_BASE_URL#http://\[::1\]:} ;;
 *) echo 'executor: invalid private listener' >&2; exit 1 ;;
esac
port=${port%/v1}
[[ $port =~ ^[0-9]+$ ]] || { echo 'executor: invalid private listener' >&2; exit 1; }
executor_gid=$(stat -c %g .)
[[ $executor_gid =~ ^[1-9][0-9]*$ ]] || {
 echo 'executor: workspace must have a non-root group' >&2
 exit 1
}
export MEKUGI_EXECUTOR_GID=$executor_gid
# Socket ownership is the executor's immutable workspace group. The router keeps
# group 0; Codex and all tool descendants use this non-root group with no capabilities.
# Children have independent listeners but share the executor group. Insert their
# allow rules ahead of the group's existing terminal rejects.
"$firewall" -w -I OUTPUT 1 -m owner --gid-owner "$executor_gid" -p tcp -d "$listener" --dport "$port" -j ACCEPT
iptables -w -A OUTPUT -m owner --gid-owner "$executor_gid" -j REJECT
ip6tables -w -A OUTPUT -m owner --gid-owner "$executor_gid" -j REJECT
# A private PID namespace hides the egress-capable parent. Private read-only
# mounts keep the executor from modifying trusted capture and runtime artifacts.
exec unshare --mount --pid --fork --mount-proc --kill-child=KILL \
 /usr/local/libexec/mekugi-agent-mounts "$@"
