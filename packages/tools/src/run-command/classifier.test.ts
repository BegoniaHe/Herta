import { describe, expect, it } from "vitest";
import {
  classifyCommand,
  classifyShellBody,
  readerPathCandidates,
} from "./classifier.js";

describe("classifyCommand — block phase", () => {
  it("blocks rm -rf /", () => {
    const r = classifyCommand(["rm", "-rf", "/"]);
    expect(r.kind).toBe("block");
    if (r.kind !== "block") throw new Error();
    expect(r.code).toBe("command_blocked");
  });

  it("blocks rm -rf ~", () => {
    expect(classifyCommand(["rm", "-rf", "~"]).kind).toBe("block");
  });

  it("blocks rm -rf /*", () => {
    expect(classifyCommand(["rm", "-rf", "/*"]).kind).toBe("block");
  });

  it("blocks rm -fr / (flag order variant)", () => {
    expect(classifyCommand(["rm", "-fr", "/"]).kind).toBe("block");
  });

  it("blocks mkfs.ext4", () => {
    expect(classifyCommand(["mkfs.ext4", "/dev/sda"]).kind).toBe("block");
  });

  it("blocks dd to /dev/sda", () => {
    expect(classifyCommand(["dd", "if=/dev/zero", "of=/dev/sda"]).kind).toBe(
      "block",
    );
  });

  it("blocks shutdown", () => {
    expect(classifyCommand(["shutdown", "-h", "now"]).kind).toBe("block");
  });

  it("blocks reboot, halt, poweroff", () => {
    expect(classifyCommand(["reboot"]).kind).toBe("block");
    expect(classifyCommand(["halt"]).kind).toBe("block");
    expect(classifyCommand(["poweroff"]).kind).toBe("block");
  });

  it("blocks init 0 and init 6", () => {
    expect(classifyCommand(["init", "0"]).kind).toBe("block");
    expect(classifyCommand(["init", "6"]).kind).toBe("block");
  });

  it("blocks fork bomb in shell body", () => {
    expect(classifyCommand(["bash", "-c", ":(){ :|:& };:"]).kind).toBe("block");
  });

  it("blocks rm -rf / inside sh -c", () => {
    expect(classifyCommand(["sh", "-c", "rm -rf /"]).kind).toBe("block");
  });
});

describe("classifyCommand — ask destructive", () => {
  it("asks for rm -rf inside repo", () => {
    const r = classifyCommand(["rm", "-rf", "build/"]);
    expect(r.kind).toBe("ask");
    if (r.kind !== "ask") throw new Error();
    expect(r.risk).toBe("workspace_destructive");
  });

  it("asks for git reset --hard", () => {
    const r = classifyCommand(["git", "reset", "--hard"]);
    expect(r.kind).toBe("ask");
    if (r.kind !== "ask") throw new Error();
    expect(r.risk).toBe("workspace_destructive");
  });

  it("asks for git clean -f", () => {
    const r = classifyCommand(["git", "clean", "-f"]);
    expect(r.kind).toBe("ask");
    if (r.kind !== "ask") throw new Error();
    expect(r.risk).toBe("workspace_destructive");
  });

  it("asks for chmod", () => {
    expect(classifyCommand(["chmod", "+x", "build.sh"]).kind).toBe("ask");
  });
});

describe("classifyCommand — ask network", () => {
  it("asks for curl", () => {
    const r = classifyCommand(["curl", "https://example.com"]);
    expect(r.kind).toBe("ask");
    if (r.kind !== "ask") throw new Error();
    expect(r.risk).toBe("network");
  });

  it("asks for wget", () => {
    expect(classifyCommand(["wget", "https://example.com"]).kind).toBe("ask");
  });

  it("asks for npm install", () => {
    const r = classifyCommand(["npm", "install", "lodash"]);
    expect(r.kind).toBe("ask");
    if (r.kind !== "ask") throw new Error();
    expect(r.risk).toBe("network");
  });

  it("asks for pnpm add", () => {
    expect(classifyCommand(["pnpm", "add", "lodash"]).kind).toBe("ask");
  });

  it("asks for pip install", () => {
    expect(classifyCommand(["pip", "install", "-r", "reqs.txt"]).kind).toBe(
      "ask",
    );
  });

  it("asks for cargo install", () => {
    expect(classifyCommand(["cargo", "install", "ripgrep"]).kind).toBe("ask");
  });

  it("asks for go install", () => {
    expect(classifyCommand(["go", "install", "./..."]).kind).toBe("ask");
  });
});

describe("classifyCommand — ask write", () => {
  it("asks for sh -c with redirection", () => {
    const r = classifyCommand(["sh", "-c", "echo hi > out.txt"]);
    expect(r.kind).toBe("ask");
    if (r.kind !== "ask") throw new Error();
    expect(r.risk).toBe("workspace_write");
  });

  it("asks for sh -c with append redirection", () => {
    expect(classifyCommand(["sh", "-c", "echo hi >> out.txt"]).kind).toBe(
      "ask",
    );
  });

  it("asks for find -delete", () => {
    expect(classifyCommand(["find", ".", "-delete"]).kind).toBe("ask");
  });

  it("asks for find -exec", () => {
    expect(
      classifyCommand(["find", ".", "-exec", "echo", "{}", ";"]).kind,
    ).toBe("ask");
  });
});

describe("classifyCommand — allow", () => {
  it("allows npm test", () => {
    expect(classifyCommand(["npm", "test"]).kind).toBe("allow");
  });

  it("allows pnpm test", () => {
    expect(classifyCommand(["pnpm", "test"]).kind).toBe("allow");
  });

  it("allows npm run test", () => {
    expect(classifyCommand(["npm", "run", "test"]).kind).toBe("allow");
  });

  it("allows npm run lint", () => {
    expect(classifyCommand(["npm", "run", "lint"]).kind).toBe("allow");
  });

  it("allows pytest", () => {
    expect(classifyCommand(["pytest", "-x"]).kind).toBe("allow");
  });

  it("allows cargo test/build/check", () => {
    expect(classifyCommand(["cargo", "test"]).kind).toBe("allow");
    expect(classifyCommand(["cargo", "build"]).kind).toBe("allow");
    expect(classifyCommand(["cargo", "check"]).kind).toBe("allow");
  });

  it("allows go test", () => {
    expect(classifyCommand(["go", "test", "./..."]).kind).toBe("allow");
  });

  it("allows git read-only commands", () => {
    expect(classifyCommand(["git", "status"]).kind).toBe("allow");
    expect(classifyCommand(["git", "diff"]).kind).toBe("allow");
    expect(classifyCommand(["git", "log"]).kind).toBe("allow");
    expect(classifyCommand(["git", "show", "HEAD"]).kind).toBe("allow");
  });

  it("allows non-recursive grep and default-filtered rg", () => {
    expect(classifyCommand(["grep", "TODO", "src/main.ts"]).kind).toBe("allow");
    expect(classifyCommand(["rg", "TODO"]).kind).toBe("allow");
  });

  it("allows find without -delete or -exec", () => {
    expect(classifyCommand(["find", ".", "-name", "*.ts"]).kind).toBe("allow");
  });

  it("allows read-only utilities", () => {
    expect(classifyCommand(["ls", "-la"]).kind).toBe("allow");
    expect(classifyCommand(["cat", "README.md"]).kind).toBe("allow");
    expect(classifyCommand(["echo", "hi"]).kind).toBe("allow");
    expect(classifyCommand(["printf", "%s\\n", "hi"]).kind).toBe("allow");
    expect(classifyCommand(["true"]).kind).toBe("allow");
    expect(classifyCommand(["false"]).kind).toBe("allow");
    expect(classifyCommand(["pwd"]).kind).toBe("allow");
  });

  it("permission lab 2026-08-17: node's test runner and version queries allow; process/port listings allow; git grep allows (escape hatches ask)", () => {
    expect(classifyCommand(["node", "--test", "test/"]).kind).toBe("allow");
    expect(
      classifyCommand(["node", "--test", "test/store.test.mjs"]).kind,
    ).toBe("allow");
    expect(classifyCommand(["node", "--test"]).kind).toBe("allow");
    expect(classifyCommand(["node", "--check", "src/server.mjs"]).kind).toBe(
      "allow",
    );
    expect(classifyCommand(["node", "--check", "/etc/x.mjs"]).kind).toBe("ask");
    // arbitrary-code shapes stay asks
    expect(
      classifyCommand(["node", "--test", "--import", "./x.mjs"]).kind,
    ).toBe("ask");
    expect(classifyCommand(["node", "-e", "1"]).kind).toBe("ask");
    expect(classifyCommand(["node", "src/cli.mjs"]).kind).toBe("ask");
    for (const argv of [
      ["node", "--version"],
      ["node", "-v"],
      ["npm", "--version"],
      ["git", "--version"],
    ]) {
      expect(classifyCommand(argv).kind, argv.join(" ")).toBe("allow");
    }
    for (const argv of [
      ["ps", "aux"],
      ["pgrep", "-f", "status.mjs"],
      ["netstat", "-ano"],
      ["tasklist", "//FI", "IMAGENAME eq node.exe"],
      ["lsof", "-i", ":4642"],
      ["which", "node"],
    ]) {
      expect(classifyCommand(argv).kind, argv.join(" ")).toBe("allow");
    }
    expect(classifyCommand(["git", "grep", "-n", "TODO"]).kind).toBe("allow");
    expect(classifyCommand(["git", "blame", "src/a.ts"]).kind).toBe("allow");
    expect(classifyCommand(["git", "stash", "list"]).kind).toBe("allow");
    for (const argv of [
      ["git", "grep", "--no-index", "TODO"],
      ["git", "grep", "--untracked", "TODO"],
    ]) {
      const r = classifyCommand(argv);
      expect(r.kind, argv.join(" ")).toBe("ask");
      if (r.kind === "ask") expect(r.code).toBe("command_ask_recursive_read");
    }
  });

  it("honest classes (2026-08-17): git mutations are vcs, rm is delete, kill is process, mkdir/cp/mv are fs — all still asks", () => {
    const code = (argv: string[]) => {
      const r = classifyCommand(argv);
      return r.kind === "ask" ? `${r.code}/${r.risk}` : r.kind;
    };
    for (const argv of [
      ["git", "commit", "-m", "x"],
      ["git", "add", "-A"],
      ["git", "checkout", "-b", "feat/x"],
      ["git", "stash"],
      ["git", "stash", "pop"],
      ["git", "mv", "a", "b"],
      ["git", "push"],
      ["git", "branch", "feat/x"],
      ["git", "branch", "-d", "feat/x"],
    ]) {
      expect(code(argv), argv.join(" ")).toBe(
        "command_ask_vcs/workspace_write",
      );
    }
    // listing forms of branch stay allowed
    expect(classifyCommand(["git", "branch"]).kind).toBe("allow");
    expect(classifyCommand(["git", "branch", "-a"]).kind).toBe("allow");
    expect(classifyCommand(["git", "branch", "--show-current"]).kind).toBe(
      "allow",
    );
    // the destructive shapes keep their class
    expect(code(["git", "reset", "--hard"])).toBe(
      "command_ask_destructive/workspace_destructive",
    );
    expect(code(["rm", "-rf", "build/"])).toBe(
      "command_ask_destructive/workspace_destructive",
    );
    for (const argv of [
      ["rm", "-f", "notes.json"],
      ["rm", "notes.json"],
      ["rmdir", "empty"],
      ["/bin/rm", "x"],
    ]) {
      expect(code(argv), argv.join(" ")).toBe(
        "command_ask_delete/workspace_write",
      );
    }
    for (const argv of [
      ["kill", "574"],
      ["pkill", "-f", "status.mjs"],
      ["taskkill", "//PID", "1", "//F"],
    ]) {
      expect(code(argv), argv.join(" ")).toBe(
        "command_ask_process/workspace_write",
      );
    }
    for (const argv of [
      ["mkdir", "-p", "scripts"],
      ["touch", "a"],
      ["cp", "a", "b"],
      ["mv", "a", "b"],
      ["ln", "-s", "a", "b"],
    ]) {
      expect(code(argv), argv.join(" ")).toBe("command_ask_fs/workspace_write");
    }
    // genuinely unknown stays unknown
    expect(code(["frobnicate", "--now"])).toBe(
      "command_ask_unknown/workspace_write",
    );
    expect(code(["./bin/notesd.sh", "list"])).toBe(
      "command_ask_unknown/workspace_write",
    );
  });

  it("text filters (2026-08-17): the read-only shapes allow; the writing/executing shapes ask", () => {
    // The pipeline tails the bash model writes constantly.
    expect(classifyCommand(["sort"]).kind).toBe("allow");
    expect(classifyCommand(["sort", "-u", "-k2,2n", "a.txt"]).kind).toBe(
      "allow",
    );
    expect(classifyCommand(["uniq", "-c"]).kind).toBe("allow");
    expect(classifyCommand(["uniq", "in.txt"]).kind).toBe("allow");
    expect(classifyCommand(["cut", "-d,", "-f1", "a.csv"]).kind).toBe("allow");
    expect(classifyCommand(["tr", "a-z", "A-Z"]).kind).toBe("allow");
    expect(classifyCommand(["nl", "-ba", "a.txt"]).kind).toBe("allow");
    // sed: only the line-range print idiom (the bash description's own hint).
    expect(classifyCommand(["sed", "-n", "10,25p", "src/a.ts"]).kind).toBe(
      "allow",
    );
    expect(classifyCommand(["sed", "-n", "5p", "a"]).kind).toBe("allow");
    expect(classifyCommand(["sed", "-n", "$p", "a"]).kind).toBe("allow");
    expect(classifyCommand(["sed", "-n", "3,$p"]).kind).toBe("allow");
    expect(
      classifyCommand(["sed", "-n", "-e", "1,3p", "-e", "9p", "a"]).kind,
    ).toBe("allow");
    expect(classifyCommand(["sed", "--expression=2p", "-n", "a"]).kind).toBe(
      "allow",
    );
    // Writing / executing shapes stay asks (never silently allowed).
    const asks = [
      ["sort", "-o", "out.txt", "in.txt"],
      ["sort", "-uo", "out.txt"],
      ["sort", "--output=out.txt"],
      ["sort", "--compress-program=gzip", "big"],
      ["uniq", "in.txt", "out.txt"],
      ["sed", "-i", "s/a/b/", "a.txt"],
      ["sed", "-i.bak", "1d", "a.txt"],
      ["sed", "--in-place", "1p", "a"],
      ["sed", "-f", "script.sed", "a"],
      ["sed", "-n", "s/a/b/p", "a"], // s/// — could carry a w flag
      ["sed", "-n", "1,3w out.txt", "a"],
      ["sed", "-n", "1e ls", "a"],
      ["sed", "-ne", "1p", "a"], // bundled -ne: not parsed, conservative ask
      ["sed", "1d", "a"],
      ["sed"], // no script
      ["awk", "{print $1}", "a"],
      ["xargs", "rm"],
      ["tee", "out.txt"],
    ];
    for (const argv of asks) {
      expect(classifyCommand(argv).kind, argv.join(" ")).toBe("ask");
    }
    // File operands still take the reader path guard.
    expect(classifyCommand(["sort", "/etc/passwd"]).kind).toBe("ask");
    expect(classifyCommand(["sed", "-n", "1p", "../secret"]).kind).toBe("ask");
    expect(classifyCommand(["cut", "-c1-3", ".env"]).kind).toBe("ask");
    // And the async reader guard covers them (existing files realpathed).
    expect(readerPathCandidates(["sed", "-n", "10,25p", "src/a.ts"])).toEqual([
      "10,25p",
      "src/a.ts",
    ]);
    expect(readerPathCandidates(["sort", "-u", "a.txt"])).toEqual(["a.txt"]);
  });
});

describe("classifyCommand — reader argv guard", () => {
  // Allow-listed READERS previously took no argument check at all, so
  // `cat ~/.ssh/id_rsa` and `grep secret /etc/passwd` rode the
  // auto-allow. Absolute paths, parent escapes, and credential-looking
  // basenames now downgrade the allow to ask (risk: read).

  it("asks when cat targets a credential file", () => {
    const r = classifyCommand(["cat", ".env"]);
    expect(r.kind).toBe("ask");
    if (r.kind !== "ask") throw new Error();
    expect(r.risk).toBe("workspace_read");
    expect(r.code).toBe("command_ask_reader_path");
  });

  it("asks when cat targets an SSH key via home-relative path", () => {
    expect(classifyCommand(["cat", "~/.ssh/id_rsa"]).kind).toBe("ask");
  });

  it("asks when grep targets an absolute POSIX path", () => {
    expect(classifyCommand(["grep", "root", "/etc/passwd"]).kind).toBe("ask");
  });

  it("asks when a reader targets an absolute Windows path", () => {
    expect(classifyCommand(["cat", "C:\\secrets.txt"]).kind).toBe("ask");
    expect(classifyCommand(["head", "C:/Users/me/notes.txt"]).kind).toBe("ask");
  });

  it("asks on parent-directory escapes", () => {
    expect(classifyCommand(["cat", "../outside.txt"]).kind).toBe("ask");
    expect(classifyCommand(["ls", ".."]).kind).toBe("ask");
    expect(classifyCommand(["head", "..\\..\\other-repo\\file"]).kind).toBe(
      "ask",
    );
  });

  it("asks on credential basenames in workspace-relative paths", () => {
    expect(classifyCommand(["cat", "config/credentials"]).kind).toBe("ask");
    expect(classifyCommand(["head", "certs/server.pem"]).kind).toBe("ask");
    expect(classifyCommand(["tail", ".env.production"]).kind).toBe("ask");
  });

  it("asks on the unified credential set + sensitive .ssh/.aws segments (audit T3.4)", () => {
    // Newly shared with read_file's denylist.
    expect(classifyCommand(["cat", ".npmrc"]).kind).toBe("ask");
    expect(classifyCommand(["cat", ".git-credentials"]).kind).toBe("ask");
    expect(classifyCommand(["cat", "deepseek-api-key.txt"]).kind).toBe("ask");
    // The `.ssh/config` segment gap: `config` is not a credential basename,
    // but `.ssh` is a sensitive directory — now caught.
    expect(classifyCommand(["cat", ".ssh/config"]).kind).toBe("ask");
    expect(classifyCommand(["cat", ".aws/credentials"]).kind).toBe("ask");
  });

  it("allows the .env.example template (centralized allow-exception)", () => {
    expect(classifyCommand(["cat", ".env.example"]).kind).toBe("allow");
  });

  it("asks on a Windows drive-RELATIVE operand (E:.env — no separator) (audit T3.4 review)", () => {
    // Drive-relative resolves against drive E's cwd (the workspace), so
    // `E:.env` reads the workspace .env; the old absolute regex required a
    // separator after the drive letter and missed it.
    expect(classifyCommand(["cat", "E:.env"]).kind).toBe("ask");
    expect(classifyCommand(["cat", "C:id_rsa"]).kind).toBe("ask");
  });
});

describe("classifyCommand — arbitrary-filesystem read bypasses (audit T3.4 review)", () => {
  it("asks on git diff --no-index (reads arbitrary paths), still allows plain git diff", () => {
    expect(
      classifyCommand(["git", "diff", "--no-index", "/dev/null", "/etc/passwd"])
        .kind,
    ).toBe("ask");
    expect(classifyCommand(["git", "diff"]).kind).toBe("allow");
    expect(classifyCommand(["git", "diff", "--stat"]).kind).toBe("allow");
  });

  it("asks on rg -L / --follow (symlink-follow escapes the repo during recursion)", () => {
    expect(classifyCommand(["rg", "-L", "PATTERN", "."]).kind).toBe("ask");
    expect(classifyCommand(["rg", "--follow", "PATTERN", "."]).kind).toBe(
      "ask",
    );
    expect(classifyCommand(["rg", "-nL", "PATTERN", "."]).kind).toBe("ask");
    // Plain rg (no symlink follow) still allows.
    expect(classifyCommand(["rg", "PATTERN", "."]).kind).toBe("allow");
  });

  it("asks on find -L / -follow (symlink-follow traversal escapes the workspace)", () => {
    expect(classifyCommand(["find", "-L", "."]).kind).toBe("ask");
    expect(classifyCommand(["find", ".", "-follow"]).kind).toBe("ask");
    // Plain find still allows.
    expect(classifyCommand(["find", ".", "-name", "*.ts"]).kind).toBe("allow");
  });

  it("still allows plain workspace-relative reads", () => {
    expect(classifyCommand(["cat", "README.md"]).kind).toBe("allow");
    expect(classifyCommand(["grep", "TODO", "src/main.ts"]).kind).toBe("allow");
    expect(classifyCommand(["rg", "TODO"]).kind).toBe("allow");
    expect(classifyCommand(["ls", "-la", "packages"]).kind).toBe("allow");
    expect(classifyCommand(["find", ".", "-name", "*.ts"]).kind).toBe("allow");
  });

  it("ignores flags (leading dash) when scanning args", () => {
    expect(classifyCommand(["ls", "-la"]).kind).toBe("allow");
    expect(classifyCommand(["grep", "-n", "pattern", "file.txt"]).kind).toBe(
      "allow",
    );
  });
});

describe("classifyCommand — shell re-entry generalization (audit finding 3)", () => {
  // Pre-fix, re-entry matched ONLY sh|bash + argv[1]==="-c" exactly, so every
  // wrapper below downgraded the no-override BLOCK tier to a plain ASK.

  it("blocks cmd /c shutdown (single-string body)", () => {
    const r = classifyCommand(["cmd", "/c", "shutdown /s /t 0"]);
    expect(r.kind).toBe("block");
  });

  it("blocks cmd /c shutdown (argv-split body)", () => {
    expect(
      classifyCommand(["cmd", "/c", "shutdown", "/s", "/t", "0"]).kind,
    ).toBe("block");
  });

  it("blocks cmd /k and dash-flag variants", () => {
    expect(classifyCommand(["cmd", "/k", "shutdown /s"]).kind).toBe("block");
    expect(classifyCommand(["cmd", "-c", "shutdown /s"]).kind).toBe("block");
  });

  it("blocks powershell -Command Remove-Item -Recurse -Force C:\\", () => {
    expect(
      classifyCommand([
        "powershell",
        "-Command",
        "Remove-Item -Recurse -Force C:\\",
      ]).kind,
    ).toBe("block");
  });

  it("blocks pwsh -c with abbreviated flag and split argv", () => {
    expect(
      classifyCommand([
        "pwsh",
        "-c",
        "Remove-Item",
        "-Recurse",
        "-Force",
        "C:\\",
      ]).kind,
    ).toBe("block");
  });

  it("blocks bash -lc fork bomb (bundled option group)", () => {
    expect(classifyCommand(["bash", "-lc", ":(){ :|:& };:"]).kind).toBe(
      "block",
    );
    expect(classifyCommand(["zsh", "-xc", "rm -rf /"]).kind).toBe("block");
  });

  it("blocks a catastrophic -EncodedCommand payload (decoded before classifying)", () => {
    const b64 = Buffer.from("shutdown /s /t 0", "utf16le").toString("base64");
    expect(classifyCommand(["powershell", "-EncodedCommand", b64]).kind).toBe(
      "block",
    );
    expect(classifyCommand(["powershell", "-enc", b64]).kind).toBe("block");
  });

  it("blocks an -EncodedCommand payload that does not decode to a command", () => {
    // Bytes below 0x20 decode to control characters — an opaque payload.
    const garbage = Buffer.from([1, 0, 2, 0, 3, 0]).toString("base64");
    expect(
      classifyCommand(["powershell", "-EncodedCommand", garbage]).kind,
    ).toBe("block");
    expect(classifyCommand(["powershell", "-EncodedCommand"]).kind).toBe(
      "block",
    );
  });

  it("asks (not blocks) for a benign -EncodedCommand payload", () => {
    const b64 = Buffer.from("Get-ChildItem", "utf16le").toString("base64");
    expect(classifyCommand(["powershell", "-EncodedCommand", b64]).kind).toBe(
      "ask",
    );
  });

  it("blocks nested wrapping (cmd /c powershell -Command shutdown)", () => {
    expect(
      classifyCommand(["cmd", "/c", "powershell -Command shutdown /s"]).kind,
    ).toBe("block");
  });

  it("normalizes interpreter paths and case", () => {
    expect(
      classifyCommand(["C:\\Windows\\System32\\cmd.exe", "/C", "shutdown /s"])
        .kind,
    ).toBe("block");
    expect(classifyCommand(["CMD", "/C", "shutdown /s"]).kind).toBe("block");
  });

  it("a benign wrapped body never upgrades the wrapper to allow", () => {
    // `npm test` is allow-listed bare, but wrapped it stays ASK — the body
    // string can chain (`npm test & curl evil`) in ways argv cannot.
    expect(classifyCommand(["cmd", "/c", "npm test"]).kind).toBe("ask");
    expect(classifyCommand(["bash", "-c", "echo hi"]).kind).toBe("ask");
    expect(classifyCommand(["powershell", "-File", "script.ps1"]).kind).toBe(
      "ask",
    );
  });

  it("asks with a write label for redirection in any wrapped body", () => {
    const r = classifyCommand(["powershell", "-Command", "ls > out.txt"]);
    expect(r.kind).toBe("ask");
    if (r.kind !== "ask") throw new Error();
    expect(r.risk).toBe("workspace_write");
  });
});

describe("classifyCommand — Windows catastrophic direct forms", () => {
  it("blocks rm -rf on a drive root", () => {
    expect(classifyCommand(["rm", "-rf", "C:\\"]).kind).toBe("block");
  });

  it("blocks Windows deletion commands on system roots", () => {
    expect(classifyCommand(["del", "C:\\"]).kind).toBe("block");
    expect(classifyCommand(["rd", "/s", "/q", "C:\\"]).kind).toBe("block");
    expect(
      classifyCommand(["Remove-Item", "-Recurse", "-Force", "C:\\"]).kind,
    ).toBe("block");
  });

  it("blocks Stop-Computer / Restart-Computer / format", () => {
    expect(classifyCommand(["Stop-Computer"]).kind).toBe("block");
    expect(classifyCommand(["Restart-Computer", "-Force"]).kind).toBe("block");
    expect(classifyCommand(["format", "C:"]).kind).toBe("block");
  });

  it("still asks for repo-scoped deletion", () => {
    expect(classifyCommand(["rm", "-rf", "build/"]).kind).toBe("ask");
    expect(classifyCommand(["Remove-Item", "-Recurse", "build"]).kind).toBe(
      "ask",
    );
  });
});

describe("classifyCommand — recursive content reads (audit finding 2a)", () => {
  // Pre-fix, `grep -r API_KEY .` was auto-ALLOWED (readerArgvGuard skips
  // flags; `.` is neither absolute nor parent-escaping) and recursed into
  // `.env` — the first half of the zero-prompt credential exfil chain.

  it("asks for grep -r / -R / --recursive", () => {
    const r = classifyCommand(["grep", "-r", "API_KEY", "."]);
    expect(r.kind).toBe("ask");
    if (r.kind !== "ask") throw new Error();
    expect(r.risk).toBe("workspace_read");
    expect(r.code).toBe("command_ask_recursive_read");
    expect(classifyCommand(["grep", "-R", "x", "."]).kind).toBe("ask");
    expect(classifyCommand(["grep", "--recursive", "x", "."]).kind).toBe("ask");
  });

  it("catches -r bundled into a short-option group", () => {
    expect(classifyCommand(["grep", "-rn", "pattern", "."]).kind).toBe("ask");
    expect(classifyCommand(["grep", "-irn", "pattern", "."]).kind).toBe("ask");
  });

  it("catches the --directories=recurse spellings", () => {
    expect(
      classifyCommand(["grep", "--directories=recurse", "x", "."]).kind,
    ).toBe("ask");
    expect(classifyCommand(["grep", "-d", "recurse", "x", "."]).kind).toBe(
      "ask",
    );
  });

  it("asks for rg flags that defeat its default filters", () => {
    expect(classifyCommand(["rg", "--hidden", "API_KEY"]).kind).toBe("ask");
    expect(classifyCommand(["rg", "--no-ignore", "API_KEY"]).kind).toBe("ask");
    expect(classifyCommand(["rg", "-uu", "API_KEY"]).kind).toBe("ask");
    expect(classifyCommand(["rg", "--unrestricted", "x"]).kind).toBe("ask");
  });

  it("keeps plain rg and single-file grep allowed", () => {
    expect(classifyCommand(["rg", "TODO"]).kind).toBe("allow");
    expect(classifyCommand(["rg", "TODO", "src/main.ts"]).kind).toBe("allow");
    expect(classifyCommand(["grep", "-n", "TODO", "src/main.ts"]).kind).toBe(
      "allow",
    );
  });
});

describe("classifyCommand — command identity (audit BL1)", () => {
  // The refusing tiers used to compare the RAW argv[0], some branches
  // case-sensitively, so the TIER depended on spelling. Every miss landed on
  // command_ask_unknown — which, unlike command_ask_destructive, is both
  // cacheable (ADR 0026) and rule-eligible (ADR 0030), so a path-qualified
  // spelling was weaker in two tiers at once.
  it("blocks catastrophic commands regardless of path or case", () => {
    for (const argv of [
      ["rm", "-rf", "/"],
      ["/bin/rm", "-rf", "/"],
      ["RM", "-rf", "/"],
      ["/usr/bin/rm", "-fr", "/"],
      ["rm.exe", "-rf", "C:\\"],
    ]) {
      expect(classifyCommand(argv).kind).toBe("block");
    }
  });

  it("blocks system-control commands regardless of path or case", () => {
    for (const argv of [
      ["shutdown", "-h", "now"],
      ["/sbin/shutdown", "-h", "now"],
      ["SHUTDOWN", "-h", "now"],
      ["/sbin/reboot"],
      ["/sbin/mkfs.ext4", "/dev/sda"],
    ]) {
      expect(classifyCommand(argv).kind).toBe("block");
    }
  });

  it("applies the same normalization to the destructive ASK tier", () => {
    const r = classifyCommand(["/bin/rm", "-rf", "build/"]);
    expect(r.kind).toBe("ask");
    if (r.kind !== "ask") throw new Error();
    // Not the cacheable/rule-eligible unknown class.
    expect(r.code).toBe("command_ask_destructive");
  });

  it("does NOT normalize the allow tier — a planted binary must not inherit it", () => {
    // Normalizing here would let /tmp/evil/git match the read-only allow
    // list. Allow stays on the raw argv[0] on purpose.
    expect(classifyCommand(["git", "status"]).kind).toBe("allow");
    expect(classifyCommand(["/tmp/evil/git", "status"]).kind).toBe("ask");
    expect(classifyCommand(["GIT", "status"]).kind).toBe("ask");
  });
});

describe("classifyShellBody — every command in a compound body (audit S4)", () => {
  // Only the FIRST command of a body was checked, so a separator downgraded
  // the no-override BLOCK tier to a plain ask.
  it("blocks a catastrophic command after a separator", () => {
    for (const body of [
      "cd /tmp && rm -rf /",
      "true; shutdown -h now",
      "cd /tmp;rm -rf /", // no whitespace — token-splitting misses this
      "x | shutdown -h now",
      "a & rm -rf /",
      "echo hi\nrm -rf /", // newline
    ]) {
      expect(classifyCommand(["bash", "-c", body]).kind).toBe("block");
    }
  });

  it("does not blocked-list separators that live INSIDE quotes", () => {
    // The block tier has no override, so a false positive is a hard failure
    // with no way past it. These must stay ask.
    for (const body of [
      `echo 'a; shutdown'`,
      `echo "stop; shutdown later"`,
      `grep "foo|bar" file`,
    ]) {
      expect(classifyCommand(["sh", "-c", body]).kind).toBe("ask");
    }
  });

  it("leaves ordinary compound bodies alone", () => {
    for (const body of [
      "cd /tmp && ls",
      "npm run build; npm test",
      "cat a | grep x",
    ]) {
      expect(classifyCommand(["sh", "-c", body]).kind).toBe("ask");
    }
  });
});

describe("classifyShellBody — exec-wrappers and quoted nesting (2026-08-24)", () => {
  // A wrapper is a program whose job is to run another program. The block tier
  // was reading the WRAPPER's name and concluding nothing catastrophic was
  // happening, so six spellings downgraded the no-override tier to a plain
  // "unrecognized command" ask (codex study; cf. Codex's recursive peel).
  it("peels exec-wrappers before the catastrophic check", () => {
    for (const body of [
      "sudo rm -rf /",
      "sudo -u root rm -rf /",
      "doas rm -rf /",
      "env rm -rf /",
      "env FOO=bar rm -rf /",
      "nice rm -rf /",
      "nice -n 19 rm -rf /",
      "nohup rm -rf /",
      "setsid rm -rf /",
      "stdbuf -oL rm -rf /",
      "timeout 5 rm -rf /",
      "timeout -k 1 5 rm -rf /",
      "xargs rm -rf /",
      "command rm -rf /",
      "builtin rm -rf /",
      "sudo env timeout 5 rm -rf /", // a chain, peeled to the end
    ]) {
      expect(classifyCommand(["bash", "-c", body]).kind).toBe("block");
    }
  });

  it("a quoted inner command survives as one token so re-entry can recurse", () => {
    // Whitespace-splitting tore the body apart, so the re-entry read `sh` as
    // the whole inner command and found nothing.
    expect(classifyCommand(["bash", "-c", `sh -c 'rm -rf /'`]).kind).toBe(
      "block",
    );
    expect(classifyCommand(["bash", "-c", `sudo sh -c "rm -rf ~"`]).kind).toBe(
      "block",
    );
  });

  it("fails closed once the nesting outruns the depth cap", () => {
    // Each layer wraps the previous one as a single backslash-escaped word.
    // A few layers still resolve to the benign innermost command; past the cap
    // the scan refuses rather than reporting "nothing catastrophic found",
    // which is what it used to do. Four interpreter layers is not something
    // honest work does.
    const esc = (s: string) => s.replace(/([\\"' `])/g, "\\$1");
    const nest = (layers: number) => {
      let body = "echo x";
      for (let i = 0; i < layers; i += 1) body = `bash -c ${esc(body)}`;
      return body;
    };
    expect(classifyShellBody(nest(2), 0).hit).toBe(false);
    const deep = classifyShellBody(nest(4), 0);
    expect(deep.hit).toBe(true);
    expect(deep.reason).toMatch(/deeper than the classifier can inspect/);
    expect(classifyCommand(["bash", "-c", nest(4)]).kind).toBe("block");
  });

  it("does not blanket-block ordinary wrapper use", () => {
    // False positives here are unappealable, so the benign twins are pinned.
    for (const body of [
      "sudo npm test",
      "env NODE_ENV=test npm test",
      "timeout 600 npm test",
      "nice -n 10 npm run build",
      "xargs grep foo",
      "command -v git",
    ]) {
      expect(classifyCommand(["bash", "-c", body]).kind).toBe("ask");
    }
  });
});

describe("classifyCommand — default", () => {
  it("asks for unknown commands", () => {
    const r = classifyCommand(["someUnknownThing"]);
    expect(r.kind).toBe("ask");
    if (r.kind !== "ask") throw new Error();
    expect(r.risk).toBe("workspace_write");
    expect(r.code).toBe("command_ask_unknown");
  });

  it("classifies known script interpreters honestly, not as unknown", () => {
    for (const argv of [
      ["node", "src/index.mjs", "sample.txt"],
      ["python", "build.py"],
      ["python3", "-m", "pytest"],
      ["deno", "run", "main.ts"],
      ["bun", "test.ts"],
    ]) {
      const r = classifyCommand(argv);
      expect(r.kind).toBe("ask");
      if (r.kind !== "ask") throw new Error();
      expect(r.risk).toBe("workspace_write");
      expect(r.code).toBe("command_ask_interpreter");
    }
  });

  it("interpreter detection is basename/.exe-normalized", () => {
    const r = classifyCommand(["C:\\Program Files\\nodejs\\node.exe", "a.js"]);
    if (r.kind !== "ask") throw new Error();
    expect(r.code).toBe("command_ask_interpreter");
  });

  it("interpreter class does NOT swallow earlier phases", () => {
    // A shell stays on its own paths (block/reentry/unknown), not interpreter.
    const sh = classifyCommand(["bash", "-c", "echo hi"]);
    if (sh.kind !== "ask") throw new Error();
    expect(sh.code).not.toBe("command_ask_interpreter");
  });
});
