#!/bin/bash
# A clean macOS in a virtual machine, for testing Dispatch from download to first run the way a
# new user meets it: no Homebrew, no command line tools, default zsh, nothing in the home folder.
#
#   vm.sh up        start the VM (clones the image on first use, ~24 GB) and set up key login
#   vm.sh ssh CMD   run CMD in the VM as its user, in a login zsh (what Terminal.app gives them)
#   vm.sh put A B   copy a file or folder into the VM
#   vm.sh get A B   copy a file out of the VM
#   vm.sh shot F    screenshot of the VM's screen into F (png), through Screen Sharing: what a person sees
#   vm.sh screen …  the mouse and keys of a person on that screen (screen.py: click, drag, key, pixel, shot)
#   vm.sh reboot    restart the VM and wait until it answers again
#   vm.sh reset     throw the VM away; the next `up` starts from the pristine image again
#   vm.sh down      stop the VM
#
# Needs tart (https://tart.run); TART=/path/to/tart when it is not on PATH.
set -euo pipefail
TART="${TART:-$(command -v tart || echo "$HOME/.local/share/tart/tart.app/Contents/MacOS/tart")}"
IMAGE="${FRESH_MAC_IMAGE:-ghcr.io/cirruslabs/macos-sequoia-vanilla:latest}"
BASE=dispatch-fresh          # the pristine image, never booted
VM=dispatch-fresh-run        # the copy a test run uses
USER_PASS=admin              # the image's only account is admin / admin
KEY="$HOME/.ssh/id_ed25519"
SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=8 -o IdentitiesOnly=yes -i "$KEY")

ip() { "$TART" ip "$VM" 2>/dev/null; }
# screen.py's venv (asyncvnc, Pillow), made once; Screen Sharing turns a quick second connection away now and then
VENV="${XDG_CACHE_HOME:-$HOME/.cache}/dispatch-fresh-mac/venv"
screen() {
  [ -x "$VENV/bin/python" ] || { python3 -m venv "$VENV" && "$VENV/bin/pip" -q install asyncvnc pillow >/dev/null; } || return 1
  for _ in 1 2 3 4 5; do "$VENV/bin/python" "$(dirname "$0")/screen.py" "$(ip)" "$@" 2>/dev/null && return 0; sleep 4; done
  echo "Screen Sharing did not answer" >&2; return 1
}
wait_ssh() { for _ in $(seq 1 90); do if [ -n "$(ip)" ] && ssh "${SSH_OPTS[@]}" -o BatchMode=yes "admin@$(ip)" true 2>/dev/null; then return 0; fi; sleep 2; done; return 1; }

case "${1:-}" in
  up)
    "$TART" list | grep -q " $BASE " || "$TART" clone "$IMAGE" "$BASE"
    "$TART" list | grep -q " $VM " || "$TART" clone "$BASE" "$VM"
    if ! "$TART" list | grep " $VM " | grep -q running; then
      "$TART" set "$VM" --cpu 4 --memory 6144
      nohup "$TART" run "$VM" --no-graphics >/dev/null 2>&1 </dev/null & disown
    fi
    for _ in $(seq 1 90); do [ -n "$(ip)" ] && break; sleep 2; done
    [ -n "$(ip)" ] || { echo "the VM did not get an address" >&2; exit 1; }
    # a first boot has an address before sshd listens: the password login below would hit a closed port
    for _ in $(seq 1 90); do nc -z -G 2 "$(ip)" 22 2>/dev/null && break; sleep 2; done
    if ! ssh "${SSH_OPTS[@]}" -o BatchMode=yes "admin@$(ip)" true 2>/dev/null; then
      # First boot: put our public key in with the image's password, once.
      PUB="$(cat "$KEY.pub")" VMIP="$(ip)" PASS="$USER_PASS" expect -c '
        set timeout 60
        spawn ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive -o IdentitiesOnly=yes -o NumberOfPasswordPrompts=1 admin@$env(VMIP) "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo \"$env(PUB)\" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
        expect -re "assword:"
        send "$env(PASS)\r"
        expect eof' >/dev/null
    fi
    wait_ssh || { echo "the VM does not answer over ssh" >&2; exit 1; }
    echo "up: admin@$(ip)" ;;
  ssh)   shift; ssh "${SSH_OPTS[@]}" "admin@$(ip)" "/bin/zsh -lic $(printf '%q' "$*")" ;;
  raw)   shift; ssh "${SSH_OPTS[@]}" "admin@$(ip)" "$@" ;;
  put)   scp -r "${SSH_OPTS[@]}" "$2" "admin@$(ip):$3" ;;
  get)   scp -r "${SSH_OPTS[@]}" "admin@$(ip):$2" "$3" ;;
  shot)  screen shot "$2" ;;
  screen) shift; screen "$@" ;;
  reboot) ssh "${SSH_OPTS[@]}" "admin@$(ip)" "sudo shutdown -r now" || true; sleep 20; wait_ssh && echo "back: admin@$(ip)" ;;
  down)  "$TART" stop "$VM" 2>/dev/null || true ;;
  reset) "$TART" stop "$VM" 2>/dev/null || true; "$TART" delete "$VM" 2>/dev/null || true; echo "reset" ;;
  ip)    ip ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
