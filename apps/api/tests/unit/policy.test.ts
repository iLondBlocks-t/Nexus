import { describe, expect, it } from "vitest";
import { evaluateCommand } from "../../src/sandbox/policy.js";

describe("command policy: host path guard", () => {
  it.each(["cat /root/x", "ls /root", "cd /root && ls", "cat ~root/x", "cp /root/.ssh/id x"])("denies %s", (cmd) => {
    expect(evaluateCommand(cmd).decision).toBe("deny");
  });
  it.each(["ls /rootfs", "ls /root_backup", "ls ./root", "grep -r root src", "ls /home/user/root"])("does not deny %s", (cmd) => {
    expect(evaluateCommand(cmd).decision).not.toBe("deny");
  });
});

describe("command policy: approval and allow", () => {
  it("allows node -e without approval", () => {
    expect(evaluateCommand("node -e 'console.log(1)'").decision).toBe("allow");
  });
  it("requires approval for sleep (not on the automatic allowlist)", () => {
    expect(evaluateCommand("sleep 60").decision).toBe("approval");
  });
  it("requires approval for curl", () => {
    expect(evaluateCommand("curl x").decision).toBe("approval");
  });
  it("denies rm -rf of the home directory", () => {
    expect(evaluateCommand("rm -rf ~").decision).toBe("deny");
    expect(evaluateCommand("rm -rf /").decision).toBe("deny");
  });
});
