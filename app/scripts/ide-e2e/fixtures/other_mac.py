"""A second Mac for the scenarios about your other Macs (run-on, history-remote): this Mac again, reached over ssh at
127.0.0.1 with a key of the instance's own, as a person of its own (a HOME inside the instance), so nothing of the real
account is read or written on "the other side". scenarios declare it: meta.instance.fixture "other-mac".

  <instance>/other-mac/sshd_config   a private sshd on a free port of 127.0.0.1 that only takes this key, as this user,
                                     and runs every login through remote-shell.sh (the other HOME, the usual PATH)
  <instance>/other-mac/ssh_config    Host e2e-mac: that address, port and key
  <instance>/other-mac/bin/ssh, scp  ssh and scp with that config, first on the instance's PATH (the app, its CLI, the
                                     scenario), so `ssh e2e-mac …` reaches it like any Mac in ~/.ssh/config

The sshd ends with the instance (`instance stop` ends the programs started with the instance's folder in their command
line that nothing else ends: its pid file names it)."""
import getpass
import os
import shutil
import socket
import subprocess
import time

ALIAS = "e2e-mac"


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def write(path, text, mode=0o644):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    os.chmod(path, mode)


def seed_history(home):
    """Two Claude Code conversations the person had on that Mac, in a project of theirs, as Claude Code writes them."""
    import json
    import uuid
    from datetime import datetime, timezone
    folder = os.path.join(home, "Projects", "notes-site")
    os.makedirs(os.path.join(folder, ".git"), exist_ok=True)
    stamp = datetime.now(timezone.utc).isoformat()
    project = os.path.join(home, ".claude", "projects", folder.replace("/", "-"))
    os.makedirs(project, exist_ok=True)
    for title in ("Fix the RSS feed dates on the other Mac", "Add a dark mode toggle on the other Mac"):
        sid = str(uuid.uuid5(uuid.NAMESPACE_URL, "dispatch-e2e-other-mac:" + title))
        user = {"type": "user", "sessionId": sid, "cwd": folder, "entrypoint": "cli", "timestamp": stamp, "uuid": str(uuid.uuid4()),
                "parentUuid": None, "isSidechain": False, "version": "2.1.82", "message": {"role": "user", "content": title}}
        answer = dict(user, type="assistant", uuid=str(uuid.uuid4()), parentUuid=user["uuid"],
                      message={"role": "assistant", "content": [{"type": "text", "text": "Done."}], "id": "fixture", "model": "fixture",
                               "stop_reason": "end_turn", "usage": {"input_tokens": 0, "output_tokens": 0}})
        with open(os.path.join(project, sid + ".jsonl"), "w", encoding="utf-8") as f:
            # compact, as Claude Code writes its lines: the index counts messages by `"type":"user"` as written
            f.write("\n".join(json.dumps(r, separators=(",", ":")) for r in (user, answer, {"type": "custom-title", "sessionId": sid, "customTitle": title})) + "\n")


def prepare(rec):
    d = os.path.join(rec["root"], "other-mac")
    home = os.path.join(d, "home")
    os.makedirs(os.path.join(d, "bin"))
    os.makedirs(os.path.join(home, "Projects"))
    for name in ("host_key", "client_key"):
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", os.path.join(d, name)], check=True)
    shutil.copy(os.path.join(d, "client_key.pub"), os.path.join(d, "authorized_keys"))
    os.chmod(os.path.join(d, "authorized_keys"), 0o600)
    real = os.path.expanduser("~")
    path = ":".join(p for p in (os.path.join(home, ".local", "bin"), os.path.join(real, ".opencode", "bin"), os.path.join(real, ".local", "bin"),
                                "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"))
    # every login: the other person's HOME (a folder of the instance), the PATH a Mac's login shell has
    # its OpenCode keeps its store in that HOME too (XDG_*): left to find its own, the second Mac on this Mac wrote
    # into the person's real ~/.local/share/opencode
    write(os.path.join(d, "remote-shell.sh"), "#!/bin/sh\nexport HOME=%s PATH=%s XDG_DATA_HOME=\"%s/.local/share\" XDG_CONFIG_HOME=\"%s/.config\" XDG_CACHE_HOME=\"%s/.cache\" XDG_STATE_HOME=\"%s/.local/state\"\ncd \"$HOME\"\n"
          "if [ -n \"$SSH_ORIGINAL_COMMAND\" ]; then exec /bin/zsh -c \"$SSH_ORIGINAL_COMMAND\"; fi\nexec /bin/zsh -l\n" % (home, path, home, home, home, home), 0o755)
    port = free_port()
    write(os.path.join(d, "sshd_config"), "\n".join([
        "Port %d" % port, "ListenAddress 127.0.0.1", "HostKey %s/host_key" % d, "AuthorizedKeysFile %s/authorized_keys" % d,
        "PasswordAuthentication no", "KbdInteractiveAuthentication no", "UsePAM no", "StrictModes no", "AllowUsers %s" % getpass.getuser(),
        "PidFile %s/sshd.pid" % d, "ForceCommand %s/remote-shell.sh" % d, "Subsystem sftp internal-sftp", ""]))
    write(os.path.join(d, "ssh_config"), "\n".join([
        "Host %s" % ALIAS, "  HostName 127.0.0.1", "  Port %d" % port, "  User %s" % getpass.getuser(), "  IdentityFile %s/client_key" % d,
        "  IdentitiesOnly yes", "  UserKnownHostsFile %s/known_hosts" % d, "  StrictHostKeyChecking accept-new", ""]))
    for tool in ("ssh", "scp"):
        write(os.path.join(d, "bin", tool), "#!/bin/sh\nexec /usr/bin/%s -F %s/ssh_config \"$@\"\n" % (tool, d), 0o755)
    subprocess.run(["/usr/sbin/sshd", "-f", os.path.join(d, "sshd_config"), "-E", os.path.join(d, "sshd.log")], check=True)
    for _ in range(50):
        r = subprocess.run([os.path.join(d, "bin", "ssh"), "-o", "BatchMode=yes", "-o", "ConnectTimeout=3", ALIAS, "echo ready"],
                           capture_output=True, text=True, timeout=30)
        if r.stdout.strip() == "ready":
            break
        time.sleep(0.2)
    else:
        raise RuntimeError("the second Mac's sshd does not answer: %s" % (r.stderr.strip() or r.stdout.strip()))
    seed_history(home)
    target = "%s@%s" % (getpass.getuser(), ALIAS)  # user@address, as Settings › Macs writes an entry
    return {"env": {"PATH_PREPEND": os.path.join(d, "bin"), "DISPATCH_E2E_OTHER_MAC": target},
            "record": {"other_mac": {"target": target, "home": home, "port": port, "bin": os.path.join(d, "bin"), "dir": d}}}
